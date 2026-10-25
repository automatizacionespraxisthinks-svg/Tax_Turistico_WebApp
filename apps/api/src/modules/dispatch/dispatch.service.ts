import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DB, type Database } from '../../db/db.module';
import { AuditService } from '../audit/audit.service';
import { drivers, rideOffers, rideStatusHistory, rides } from '../../db/schema';
import { AppError } from '../../common/problem';
import { isUniqueViolation } from '../../common/pg-errors';
import { OutboxService } from '../integrations/outbox.service';
import { FleetService } from '../fleet/fleet.service';
import { ZonesService } from '../pricing/zones.service';
import { RidesService, type Actor } from '../rides/rides.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { PushService } from '../push/push.service';
import { loadEnv } from '../../config/env';
import { OLEADA_A_TODOS, type Oleada, type WaveLogEntry } from '@tax/shared';

export const DISPATCH_QUEUE = 'dispatch';
export const WAVE_TIMEOUT_JOB = 'wave-timeout';

export interface WaveTimeoutJob {
  rideId: string;
  wave: Oleada;
  /**
   * El lanzamiento que lo programo. Si la oficina relanza la carrera, el
   * temporizador de un intento anterior no debe escalar el nuevo.
   */
  intento?: number;
}

const SYSTEM: Actor = { kind: 'system', name: 'Despacho', role: 'sistema' };

/**
 * Motor de despacho por oleadas (§5.2).
 *
 * Es un process manager: tres oleadas con radios y tiempos crecientes, con
 * temporizadores que sobreviven a un reinicio porque viven en BullMQ sobre
 * Redis, no en `setTimeout` dentro del proceso.
 *
 * La pieza crítica es `accept`: la exclusividad la decide la base de datos en
 * una sola sentencia, nunca la aplicación comparando en memoria.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);
  private readonly env = loadEnv();

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(DISPATCH_QUEUE) private readonly queue: Queue<WaveTimeoutJob>,
    private readonly fleet: FleetService,
    private readonly zones: ZonesService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly push: PushService,
    @Inject(forwardRef(() => RidesService))
    private readonly ridesService: RidesService,
  ) {}

  /* ----------------------------------------------------------- oleadas */

  /**
   * Lanza una oleada: busca candidatos en el radio de la zona, les crea una
   * oferta y programa el vencimiento.
   *
   * Si no hay nadie, no espera al temporizador: escala de inmediato, porque
   * esperar 45 segundos a nadie es tiempo regalado.
   */
  async startWave(rideId: string, wave: Oleada): Promise<void> {
    const ride = await this.ridesService.byId(rideId);

    // Una carrera sin asignar solo vuelve al despacho por `redispatch`, que
    // hace la transicion en nombre de quien relanza. Si se llegara aqui
    // directamente, el sistema no tiene permiso para sacarla de ahi.
    if (ride.status !== 'PENDING' && ride.status !== 'NOTIFIED') {
      this.logger.debug({ rideId, status: ride.status }, 'La carrera ya no admite oleadas');
      return;
    }

    if (!ride.pickupLat || !ride.pickupLng || !ride.zoneId) {
      throw new AppError('MISSING_LOCATION', 'La carrera no tiene punto de recogida');
    }

    /*
     * La oleada 1 abre un intento nuevo: al crear la carrera, y en cada
     * «Relanzar» de la oficina. Las demas siguen dentro del intento en curso.
     * Se incrementa en la propia sentencia para que dos relanzamientos
     * simultaneos no acaben con el mismo numero.
     */
    let intento = ride.intentoDespacho;
    if (wave === 1) {
      const [fila] = await this.db
        .update(rides)
        .set({ intentoDespacho: sql`${rides.intentoDespacho} + 1` })
        .where(eq(rides.id, rideId))
        .returning({ intento: rides.intentoDespacho });
      intento = fila!.intento;
    }

    const pickup = { lat: ride.pickupLat, lng: ride.pickupLng };
    const aTodos = wave === OLEADA_A_TODOS;
    // La ronda a todos usa el tiempo de la tercera: no tiene configuracion
    // propia por zona porque es una herramienta de prueba, no una oleada mas.
    const config = this.zones.waveConfig(ride.zoneId, aTodos ? 3 : wave);

    let candidates;
    let sinGps: number | undefined;

    if (aTodos) {
      /*
       * Aqui si se le vuelve a ofrecer a quien no contesto antes: no
       * contestar no es decir que no, y en pruebas con un solo telefono es
       * justo el conductor al que se quiere ver recibir el aviso. Solo se
       * excluye a quien rechazo la carrera de forma expresa, en cualquier
       * intento: un «no» a esta carrera sigue valiendo si se relanza.
       */
      const rechazaron = await this.db
        .select({ driverId: rideOffers.driverId })
        .from(rideOffers)
        .where(and(eq(rideOffers.rideId, rideId), eq(rideOffers.response, 'rejected')));

      const todos = await this.fleet.findAllAvailable(
        pickup,
        rechazaron.map((row) => row.driverId),
      );
      candidates = todos.candidates;
      sinGps = todos.sinGps;
    } else {
      /*
       * Dentro de un intento no se repite conductor: si no contesto en la
       * oleada 1, la 2 busca a otros. Pero entre intentos si: si la oficina
       * relanza, es justo para volver a probar con quien no contesto. Antes
       * se excluia a todo el que alguna vez la vio, y con pocos conductores
       * relanzar no encontraba nunca a nadie. Quien la rechazo queda fuera
       * siempre.
       */
      const alreadyOffered = await this.db
        .select({ driverId: rideOffers.driverId })
        .from(rideOffers)
        .where(
          and(
            eq(rideOffers.rideId, rideId),
            or(eq(rideOffers.intento, intento), eq(rideOffers.response, 'rejected')),
          ),
        );

      candidates = await this.fleet.findCandidates(
        pickup,
        config.radiusKm,
        ride.vehicleType,
        config.candidates,
        alreadyOffered.map((row) => row.driverId),
      );
    }

    if (candidates.length === 0) {
      this.logger.log({ rideId, wave }, 'Oleada sin candidatos: se escala de inmediato');
      await this.registrarOleada(rideId, {
        wave,
        intento,
        startedAt: new Date().toISOString(),
        expiresAt: null,
        radiusKm: aTodos ? null : config.radiusKm,
        candidates: 0,
        ...(sinGps !== undefined ? { sinGps } : {}),
      });
      await this.escalate(rideId, wave);
      return;
    }

    const expiresAt = new Date(Date.now() + config.timeoutSeconds * 1000);

    /*
     * El temporizador va ANTES que las ofertas, no despues.
     *
     * Si la cola falla al final, la carrera ya esta Notificada, los
     * conductores ya recibieron el aviso y nadie la va a vencer nunca: se
     * queda colgada para siempre sin pasar a «sin asignar». Programandolo
     * primero, si la cola falla, la oleada falla entera y el error sube.
     *
     * El identificador fijo evita dos temporizadores para la misma oleada si
     * `startWave` se llamara dos veces, y lleva el intento para que el de un
     * relanzamiento no choque con el del anterior. Va SIN dos puntos: BullMQ
     * 6 rechaza un identificador propio con «:» salvo que tenga exactamente
     * tres partes. El formato anterior, `<id>:wave:<n>`, las tenia por pura
     * casualidad; al anadirle el intento paso a cuatro y BullMQ lo rechazo.
     */
    await this.queue.add(
      WAVE_TIMEOUT_JOB,
      { rideId, wave, intento },
      {
        jobId: `${rideId}_i${intento}_w${wave}`,
        delay: config.timeoutSeconds * 1000,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    await this.db.insert(rideOffers).values(
      candidates.map((candidate) => ({
        id: uuidv7(),
        rideId,
        driverId: candidate.driverId,
        wave,
        intento,
        distanceKm: candidate.distanceKm,
        etaMinutes: candidate.etaMinutes,
        expiresAt,
        response: 'pending' as const,
      })),
    );

    // La primera oleada es la que mueve la carrera a Notificada; las
    // siguientes solo cambian el número de oleada.
    if (ride.status !== 'NOTIFIED') {
      await this.ridesService.transition(rideId, 'NOTIFIED', SYSTEM, {
        note: `Oleada ${wave}`,
        patch: { wave },
      });
    } else {
      await this.db.update(rides).set({ wave }).where(eq(rides.id, rideId));
    }

    await this.registrarOleada(rideId, {
      wave,
      intento,
      startedAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      radiusKm: aTodos ? null : config.radiusKm,
      candidates: candidates.length,
      ...(sinGps !== undefined ? { sinGps } : {}),
    });

    const zoneName = this.zones.byId(ride.zoneId)?.name;

    for (const candidate of candidates) {
      this.realtime.offerToDriver(candidate.driverId, {
        rideId,
        code: ride.code,
        pickupText: ride.pickupText,
        pickupReference: ride.pickupReference,
        dropoffText: ride.dropoffText,
        fareEstimate: ride.fareEstimate,
        passengers: ride.passengers,
        distanceKm: candidate.distanceKm,
        etaMinutes: candidate.etaMinutes,
        expiresAt: expiresAt.toISOString(),
        wave,
      });

      /*
       * El push va además del socket, no en su lugar: con la aplicación
       * abierta el socket ya entregó y el aviso solo confirma; con el
       * teléfono bloqueado es lo único que llega. Enviarlo no puede frenar
       * la oleada, así que no se espera.
       */
      void this.push
        .notifyOffer(candidate.driverId, {
          rideId,
          code: ride.code,
          zona: zoneName,
          fareEstimate: ride.fareEstimate,
          expiresAt: expiresAt.toISOString(),
        })
        .catch((error: unknown) => {
          this.logger.warn({ err: error, driverId: candidate.driverId }, 'Aviso no entregado');
        });
    }

    this.logger.log(
      { rideId, wave, candidatos: candidates.length, radioKm: config.radiusKm },
      'Oleada lanzada',
    );
  }

  /**
   * Anota la oleada en la carrera y se la cuenta al panel en vivo.
   *
   * Se anade al final del arreglo en la propia sentencia, sin leer antes:
   * dos oleadas no corren a la vez sobre la misma carrera, pero si alguna
   * vez lo hicieran, una lectura-y-escritura perderia una de las dos.
   */
  private async registrarOleada(rideId: string, entrada: WaveLogEntry): Promise<void> {
    await this.db
      .update(rides)
      .set({ waveLog: sql`${rides.waveLog} || ${JSON.stringify([entrada])}::jsonb` })
      .where(eq(rides.id, rideId));

    this.realtime.rideWave(rideId, entrada);
  }

  /**
   * Relanzar el despacho de una carrera sin asignar (§5.3).
   *
   * La maquina de estados solo deja que un OPERADOR saque una carrera de
   * «sin asignar»: es el quien decide volver a intentarlo, y asi tiene que
   * quedar en la bitacora. Antes se relanzaba llamando a `startWave`, que
   * hace las transiciones en nombre del sistema, y la maquina la rechazaba.
   * Relanzar no funciono nunca cuando encontraba a alguien: si no habia
   * nadie en el radio, pasaba en silencio; si lo habia, daba error.
   *
   * Si el relanzamiento no encuentra a nadie, la carrera vuelve sola a «sin
   * asignar» por el camino de siempre, y la bitacora cuenta que se intento.
   */
  async redispatch(rideId: string, actor: Actor): Promise<void> {
    const ride = await this.ridesService.byId(rideId);
    if (ride.status !== 'UNASSIGNED') {
      throw new AppError(
        'INVALID_TRANSITION',
        `Solo se relanza una carrera sin asignar; esta está en ${ride.status}`,
      );
    }

    await this.ridesService.transition(rideId, 'NOTIFIED', actor, { note: 'Relanzar despacho' });
    await this.startWave(rideId, 1);
  }

  /** Vence la oleada: si nadie aceptó, amplía el radio o se da por agotada. */
  async expireWave(rideId: string, wave: Oleada, intento?: number): Promise<void> {
    const ride = await this.ridesService.byId(rideId);
    if (ride.status !== 'NOTIFIED') return;

    // Un temporizador de un intento anterior no toca el actual.
    if (intento !== undefined && intento !== ride.intentoDespacho) {
      this.logger.debug({ rideId, wave, intento }, 'Temporizador de un intento anterior: se ignora');
      return;
    }

    await this.db
      .update(rideOffers)
      .set({ response: 'expired' })
      .where(
        and(
          eq(rideOffers.rideId, rideId),
          eq(rideOffers.wave, wave),
          eq(rideOffers.response, 'pending'),
        ),
      );

    await this.escalate(rideId, wave);
  }

  private async escalate(rideId: string, wave: Oleada): Promise<void> {
    if (wave < 3) {
      await this.startWave(rideId, (wave + 1) as 2 | 3);
      return;
    }

    // Tras la tercera, la ronda a todos si esta encendida (solo para pruebas).
    if (wave === 3 && this.env.OLEADA_FINAL_A_TODOS) {
      await this.startWave(rideId, OLEADA_A_TODOS);
      return;
    }

    // Agotadas las oleadas: estado Sin asignar, evento y alerta sonora en el
    // panel (§5.2, punto 5).
    const ride = await this.ridesService.byId(rideId);

    // Puede llegar aquí desde Notificada (nadie aceptó) o desde Pendiente
    // (ninguna oleada encontró candidatos). El segundo caso es el que deja a
    // la carrera muda si no se contempla.
    if (ride.status !== 'NOTIFIED' && ride.status !== 'PENDING') return;

    /*
     * La nota distingue «nadie la vio» de «la vieron y nadie la tomo»: son
     * problemas distintos —faltan conductores, o sobran y no la quieren— y
     * la oficina no los arregla igual. Se cuentan las ofertas del intento en
     * curso, porque un relanzamiento sin nadie en el radio pasa por
     * Notificada sin haber avisado a nadie. Y sin numeros: con la ronda
     * final las oleadas ya no son siempre tres.
     */
    const [ofertas] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(rideOffers)
      .where(and(eq(rideOffers.rideId, rideId), eq(rideOffers.intento, ride.intentoDespacho)));
    const nadieLaVio = ride.status === 'PENDING' || (ofertas?.n ?? 0) === 0;

    await this.ridesService.transition(rideId, 'UNASSIGNED', SYSTEM, {
      note: nadieLaVio ? 'Ninguna oleada encontró conductores' : 'Nadie aceptó la carrera',
      event: { type: 'ride.no_driver' },
    });

    this.realtime.alertOffice({
      kind: 'no_driver',
      rideId,
      code: ride.code,
      message: nadieLaVio
        ? `${ride.code}: no hay conductores disponibles`
        : `${ride.code}: nadie aceptó la carrera`,
    });
  }

  /* ---------------------------------------------------------- aceptación */

  /**
   * Aceptación de una oferta: RF-23, exclusividad garantizada por la base.
   *
   * Es una sola sentencia condicional. Si dos conductores aceptan a la vez,
   * PostgreSQL serializa los UPDATE y solo el primero encuentra la fila en
   * estado `NOTIFIED`; al segundo le devuelve cero filas y recibe «carrera ya
   * tomada». La app nunca compara quién llegó primero.
   */
  async accept(rideId: string, driverId: string, actor: Actor) {
    const eventIds: string[] = [];
    const revokedDrivers: string[] = [];

    await this.db
      .transaction(async (tx) => {
        const result = await tx.execute<{ id: string; code: string; version: number }>(sql`
          update rides
             set status = 'ASSIGNED',
                 driver_id = ${driverId},
                 assigned_at = now(),
                 version = version + 1,
                 updated_at = now()
           where id = ${rideId}
             and status = 'NOTIFIED'
             and exists (
               select 1 from ride_offers o
                where o.ride_id = ${rideId}
                  and o.driver_id = ${driverId}
                  and o.expires_at > now()
                  and o.revoked_at is null
                  and o.response = 'pending'
             )
          returning id, code, version
        `);

        const row = result.rows[0];
        if (!row) {
          // Sin fila de vuelta hay dos causas posibles, y al conductor le
          // importa la diferencia: o alguien se adelantó, o su oferta venció.
          const [ride] = await tx
            .select({ status: rides.status })
            .from(rides)
            .where(eq(rides.id, rideId))
            .limit(1);

          if (!ride) throw new AppError('NOT_FOUND', `No existe la carrera ${rideId}`);
          if (ride.status !== 'NOTIFIED') {
            throw new AppError('RIDE_ALREADY_TAKEN', 'Otro conductor aceptó la carrera primero');
          }
          throw new AppError('OFFER_NOT_VALID', 'La oferta venció o fue revocada');
        }

        // En la misma transacción: el conductor pasa a En carrera, las demás
        // ofertas se revocan y el evento entra al outbox (§5.1).
        await tx.update(drivers).set({ status: 'ON_RIDE' }).where(eq(drivers.id, driverId));

        /*
         * El historial también va aquí dentro.
         *
         * La aceptación no pasa por `RidesService.transition` —necesita la
         * sentencia atómica—, así que si no se escribe a mano, la bitácora
         * salta de «Notificada» a «Conductor en el sitio» y el momento de la
         * asignación desaparece. Es la fila que sostiene RF-44 (tiempo hasta
         * la asignación) y la que explica quién tomó la carrera.
         */
        const driver = await tx
          .select({ name: drivers.name })
          .from(drivers)
          .where(eq(drivers.id, driverId))
          .limit(1);

        await tx.insert(rideStatusHistory).values({
          id: uuidv7(),
          rideId,
          fromStatus: 'NOTIFIED',
          toStatus: 'ASSIGNED',
          actor: actor.kind,
          actorName: driver[0]?.name ?? actor.name,
          actorId: driverId,
          note: actor.kind === 'operator' ? 'Asignación manual' : undefined,
        });

        await this.audit.record(
          {
            actorId: actor.id,
            actorName: actor.name,
            role: actor.role ?? actor.kind,
            action: 'Aceptó la carrera',
            entity: 'rides',
            entityId: row.code,
            before: { status: 'NOTIFIED' },
            after: { status: 'ASSIGNED', driverId, version: row.version },
            ip: actor.ip,
          },
          tx as unknown as Database,
        );

        await tx
          .update(rideOffers)
          .set({ response: 'accepted', respondedAt: new Date() })
          .where(and(eq(rideOffers.rideId, rideId), eq(rideOffers.driverId, driverId)));

        // Se anota a quién se le retira para poder quitarle también el aviso
        // del teléfono: si no, le quedaría en pantalla una carrera que ya no
        // puede tomar.
        const revoked = await tx
          .update(rideOffers)
          .set({ response: 'revoked', revokedAt: new Date() })
          .where(
            and(
              eq(rideOffers.rideId, rideId),
              eq(rideOffers.response, 'pending'),
              isNull(rideOffers.revokedAt),
            ),
          )
          .returning({ driverId: rideOffers.driverId });

        revokedDrivers.push(...revoked.map((row) => row.driverId));

        eventIds.push(
          await this.outbox.enqueue(tx, {
            type: 'ride.assigned',
            rideId,
            rideCode: row.code,
            rideVersion: row.version,
            payload: { code: row.code, driverId },
          }),
        );

        return row;
      })
      .catch((error: unknown) => {
        /*
         * El índice parcial `one_active_ride_per_driver` es el respaldo
         * estructural de §5.1: si el conductor ya tiene una carrera activa
         * —una que se quedó colgada tras una caída, por ejemplo—, la base
         * rechaza la asignación aunque la sentencia condicional sí hubiera
         * encontrado esta carrera en Notificada.
         *
         * Sin esta traducción, el conductor recibe un 500 opaco en mitad de
         * la calle en vez de saber que debe cerrar la carrera anterior.
         */
        if (isUniqueViolation(error, 'one_active_ride_per_driver')) {
          throw new AppError(
            'DRIVER_BUSY',
            'Ya tienes una carrera activa. Termínala o llama a la oficina.',
          );
        }
        throw error;
      });

    await this.outbox.notify(eventIds);

    // Tras el commit, el socket retira la oferta de las otras pantallas en
    // menos de un segundo (§5.1), y el push la retira de los teléfonos que
    // la tengan en la pantalla bloqueada.
    this.realtime.revokeOffer(rideId);
    for (const loser of revokedDrivers) {
      void this.push.revokeOffer(loser, rideId).catch(() => undefined);
    }
    const ride = await this.ridesService.byId(rideId);
    this.realtime.rideChanged(ride);

    this.logger.log({ rideId, driverId, actor: actor.name }, 'Carrera asignada');
    return ride;
  }

  /** Rechazo explícito: no espera al vencimiento para seguir buscando. */
  async reject(rideId: string, driverId: string): Promise<void> {
    await this.db
      .update(rideOffers)
      .set({ response: 'rejected', respondedAt: new Date() })
      .where(
        and(
          eq(rideOffers.rideId, rideId),
          eq(rideOffers.driverId, driverId),
          eq(rideOffers.response, 'pending'),
        ),
      );

    const [pending] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(rideOffers)
      .where(and(eq(rideOffers.rideId, rideId), eq(rideOffers.response, 'pending')));

    // Si era el último pendiente de la oleada, se escala ya.
    if ((pending?.count ?? 0) === 0) {
      const ride = await this.ridesService.byId(rideId);
      if (ride.status === 'NOTIFIED') {
        await this.escalate(rideId, (ride.wave ?? 1) as Oleada);
      }
    }
  }

  /** Asignación manual del operador sobre una carrera sin asignar (§5.3). */
  async assignManually(rideId: string, driverId: string, actor: Actor) {
    const expiresAt = new Date(Date.now() + 120_000);

    // Se crea una oferta vigente para este conductor y se acepta con la misma
    // sentencia atómica: la asignación manual no se salta la exclusividad.
    await this.db.transaction(async (tx) => {
      await tx.update(rides).set({ status: 'NOTIFIED' }).where(eq(rides.id, rideId));
      await tx
        .insert(rideOffers)
        .values({
          id: uuidv7(),
          rideId,
          driverId,
          wave: 3,
          distanceKm: 0,
          etaMinutes: 0,
          expiresAt,
          response: 'pending',
        })
        .onConflictDoNothing();
    });

    return this.accept(rideId, driverId, actor);
  }

  async revokeOffers(rideId: string): Promise<void> {
    await this.db
      .update(rideOffers)
      .set({ response: 'revoked', revokedAt: new Date() })
      .where(and(eq(rideOffers.rideId, rideId), eq(rideOffers.response, 'pending')));

    this.realtime.revokeOffer(rideId);
  }

  async releaseDriver(driverId: string): Promise<void> {
    await this.fleet.setStatus(driverId, 'AVAILABLE');
  }
}
