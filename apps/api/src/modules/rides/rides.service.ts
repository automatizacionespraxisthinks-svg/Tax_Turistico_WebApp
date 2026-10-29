import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { CreateRideInput, Point, RideStatus, TransitionActor } from '@tax/shared';
import { canTransition, formatRideCode, haversineKm, tieneNomenclatura } from '@tax/shared';
import { DB, type Database, type Tx } from '../../db/db.module';
import {
  customers,
  drivers,
  rideAddressEdits,
  rideOffers,
  rideStatusHistory,
  rides,
  vehicles,
} from '../../db/schema';
import { AppError } from '../../common/problem';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../integrations/outbox.service';
import { TrayectosService } from '../pricing/trayectos.service';
import { GeocodingService } from '../pricing/geocoding.service';
import { ZonesService } from '../pricing/zones.service';
import { CatalogoService } from '../pricing/catalogo.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { isUniqueViolation } from '../../common/pg-errors';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { FotosService } from './fotos.service';

export interface Actor {
  kind: TransitionActor;
  name: string;
  id?: string;
  role?: string;
  ip?: string;
}

export interface TransitionOptions {
  note?: string;
  at?: Point;
  /** Cambios adicionales sobre la fila de la carrera. */
  patch?: Partial<typeof rides.$inferInsert>;
  /** Evento que se publica hacia n8n dentro de la misma transacción. */
  event?: { type: Parameters<OutboxService['enqueue']>[1]['type']; payload?: Record<string, unknown> };
}

/**
 * Carreras.
 *
 * Es dueño del ciclo de vida, de la edición de dirección (RF-11) y del
 * historial de estados (§4.1).
 *
 * TODO cambio de estado pasa por `transition()`. Es a propósito: la tabla de
 * transiciones de `@tax/shared` se comprueba en un único sitio, y en la misma
 * transacción se escriben el historial, la auditoría y el evento del outbox.
 * Un atajo que actualice `rides.status` por fuera se saltaría las tres cosas.
 */
@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);

  /**
   * Mas alla de esto, la lectura del GPS no se cree. Paipa-Bogota son unos
   * 180 km, asi que un intermunicipal largo sigue cabiendo; lo que no cabe
   * es un (0, 0), que da la vuelta al mundo.
   */
  private static readonly DISTANCIA_MAXIMA_KM = 300;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly trayectos: TrayectosService,
    private readonly geocoding: GeocodingService,
    private readonly zones: ZonesService,
    @Inject(CatalogoService) private readonly catalogo: CatalogoService,
    private readonly realtime: RealtimeGateway,
    private readonly fotos: FotosService,
    @Inject(forwardRef(() => DispatchService))
    private readonly dispatch: DispatchService,
  ) {}

  /* ------------------------------------------------------------- creación */

  async create(input: CreateRideInput, actor: Actor) {
    /*
     * El punto de recogida, por orden de confianza.
     *
     * Si el cliente compartio su ubicacion, esa manda: es exacta al metro y
     * no hay nada que adivinar. Si solo escribio una direccion, la resuelve
     * el geocodificador —aqui, nunca el agente de n8n, que podria cambiarle
     * un digito sin que se note— y lo que devuelve ya viene comprobado
     * contra las zonas con servicio.
     */
    let point = input.pickup.point;
    let pickupSource: 'compartida' | 'catalogo' | 'geocodificada' | 'sin_ubicar' = 'compartida';
    let direccionResuelta: string | undefined;

    /*
     * Sin ubicación compartida hay dos ayudas, y el orden depende de cómo lo
     * dijo el cliente. Con nomenclatura («Calle 25 #18-40») manda el
     * geocodificador, que llega a la puerta. Sin ella («frente a la
     * terminal») manda el catálogo de lugares: sus palabras clave son como
     * la gente de Paipa nombra los sitios, y el geocodificador no las conoce.
     * La referencia también cuenta, porque es donde el cliente suele nombrar
     * el lugar.
     */
    type Hallazgo = { point: Point; source: 'catalogo' | 'geocodificada'; direccion: string };
    const delCatalogo = async (): Promise<Hallazgo | null> => {
      const texto = [input.pickup.text, input.pickup.reference].filter(Boolean).join('. ');
      const lugar = await this.catalogo.reconocer(texto);
      return lugar ? { point: lugar.point, source: 'catalogo', direccion: lugar.name } : null;
    };
    const delGeocodificador = async (): Promise<Hallazgo | null> => {
      const hallada = await this.geocoding.resolve(input.pickup.text);
      return hallada ? { point: hallada.point, source: 'geocodificada', direccion: hallada.formatted } : null;
    };

    if (!point) {
      const ayudas = tieneNomenclatura(input.pickup.text)
        ? [delGeocodificador, delCatalogo]
        : [delCatalogo, delGeocodificador];
      for (const ayuda of ayudas) {
        const hallazgo = await ayuda();
        if (hallazgo) {
          point = hallazgo.point;
          pickupSource = hallazgo.source;
          direccionResuelta = hallazgo.direccion;
          break;
        }
      }
    }

    /*
     * Si no se pudo ubicar, la carrera se crea igual.
     *
     * El cliente da una direccion y el conductor la lee: asi se ha despachado
     * toda la vida y no hace falta un mapa para eso. Lo unico que necesita
     * coordenadas es el despacho, porque las oleadas son radios y un radio
     * necesita un centro; para eso basta el centro del pueblo.
     *
     * Rechazar la carrera seria lo peor de los dos mundos: el cliente se
     * queda sin taxi por un geocodificador que no entendio una nomenclatura
     * que el conductor habria leido sin problema. Queda marcada como
     * `sin_ubicar` para que en el panel se vea que ese punto del mapa es el
     * del pueblo y no el del cliente.
     */
    if (!point) {
      point = this.zones.puntoDeReferencia();
      pickupSource = 'sin_ubicar';
    }

    if (!point) {
      // Solo si no hay ni una zona configurada: eso es un sistema sin montar.
      throw new AppError('MISSING_LOCATION', 'No hay zonas configuradas para despachar');
    }

    const trayecto = this.trayectos.medir(point, input.dropoff?.point);
    const rideId = uuidv7();
    const pendingEvents: string[] = [];

    const created = await this.db
      .transaction(async (tx) => {
        const customerId = await this.upsertCustomer(tx, input.customerPhone, input.customerName);

        // El código legible sale de una secuencia de la base: dos peticiones
        // simultáneas no pueden obtener el mismo número.
        // `execute` devuelve el QueryResult de pg, no un array de filas.
        const sequence = await tx.execute<{ next: string }>(
          sql`select nextval('ride_code_seq') as next`,
        );
        const code = formatRideCode(
          new Date().getFullYear(),
          Number(sequence.rows[0]?.next ?? 0),
        );

        const [ride] = await tx
          .insert(rides)
          .values({
            id: rideId,
            code,
            status: 'PENDING',
            version: 1,
            customerId,
            pickupText: input.pickup.text,
            pickupReference: input.pickup.reference,
            pickupLat: point.lat,
            pickupLng: point.lng,
            pickupSource,
            dropoffText: input.dropoff?.text,
            dropoffLat: input.dropoff?.point?.lat,
            dropoffLng: input.dropoff?.point?.lng,
            // Solo cuenta como dicho por el cliente si trae coordenadas: un
            // destino en palabras no sirve para medir nada.
            dropoffSource: input.dropoff?.point ? 'cliente' : undefined,
            zoneId: trayecto.originZoneId,
            vehicleType: input.vehicleType,
            passengers: input.passengers,
            etaMinutes: trayecto.etaMinutes,
            notes: input.notes,
          })
          .returning();

        await tx.insert(rideStatusHistory).values({
          id: uuidv7(),
          rideId,
          fromStatus: null,
          toStatus: 'PENDING',
          actor: actor.kind,
          actorName: actor.name,
          actorId: actor.id,
        });

        pendingEvents.push(
          await this.outbox.enqueue(tx, {
            type: 'ride.created',
            rideId,
            rideCode: code,
            rideVersion: 1,
            payload: {
              code,
              pickup: { ...input.pickup, point },
              pickupSource,
              // Para que el agente pueda confirmarle al cliente lo que se
              // entendio, sin tener que geocodificar el por su cuenta.
              direccionResuelta,
              dropoff: input.dropoff,
              zone: trayecto.originZoneName,
            },
          }),
        );

        await this.audit.record(
          {
            actorId: actor.id,
            actorName: actor.name,
            role: actor.role ?? actor.kind,
            action: 'Creó carrera',
            entity: 'rides',
            entityId: code,
            after: { code, status: 'PENDING' },
            ip: actor.ip,
          },
          tx as unknown as Database,
        );

        return ride;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, 'one_active_ride_per_customer')) {
          throw new AppError(
            'RIDE_ALREADY_ACTIVE',
            'Este teléfono ya tiene una carrera activa. El operador puede autorizar otra.',
          );
        }
        throw error;
      });

    // Fuera de la transacción: antes del commit el trabajador no vería la fila.
    await this.outbox.notify(pendingEvents);
    this.realtime.rideChanged(created);

    // La foto del lugar baja después, sin que nadie la espere.
    if (input.pickupPhotoUrl) {
      this.fotos.enSegundoPlano(rideId, input.pickupPhotoUrl, actor, (ride) => this.realtime.rideChanged(ride));
    }

    // El despacho arranca en segundo plano; crear la carrera no debe esperar
    // a que se resuelva la primera oleada (objetivo: oferta visible < 3 s).
    void this.dispatch.startWave(rideId, 1).catch((error: unknown) => {
      this.logger.error({ err: error, rideId }, 'No se pudo lanzar la oleada 1');
    });

    return created;
  }

  private async upsertCustomer(tx: Tx, phone: string, name?: string): Promise<string> {
    const [existing] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.phone, phone))
      .limit(1);

    if (existing) {
      if (name) await tx.update(customers).set({ name }).where(eq(customers.id, existing.id));
      return existing.id;
    }

    const id = uuidv7();
    await tx.insert(customers).values({ id, phone, name });
    return id;
  }

  /* ---------------------------------------------------------- transición */

  /**
   * Único camino para cambiar el estado de una carrera.
   *
   * Comprueba la transición contra la tabla del dominio, escribe historial y
   * auditoría, publica el evento y avisa por socket. Devuelve la carrera ya
   * actualizada.
   */
  /**
   * Lo que se guarda al finalizar: destino y distancia.
   *
   * Casi nadie dice a donde va por WhatsApp; lo dice ya montado en el carro.
   * Por eso el destino se da por conocido cuando el taxi para: la posicion
   * del conductor al marcar finalizada es el destino. Si el cliente si lo
   * habia dicho, ese manda y la posicion del conductor no lo pisa.
   *
   * Nada de esto puede impedir cerrar una carrera. Sin GPS, con una lectura
   * absurda o con las zonas cambiadas, el conductor cierra igual y la
   * carrera queda sin distancia: un informe incompleto es mucho menos malo
   * que un taxista atrapado en una pantalla con el cliente ya bajandose.
   */
  async cierreDeCarrera(
    ride: typeof rides.$inferSelect,
    at: Point | undefined,
  ): Promise<{ patch: Partial<typeof rides.$inferInsert>; note?: string }> {
    const loDijoElCliente = ride.dropoffLat != null && ride.dropoffLng != null;
    const destino = loDijoElCliente
      ? { lat: ride.dropoffLat!, lng: ride.dropoffLng! }
      : at;

    if (!destino || ride.pickupLat == null || ride.pickupLng == null) {
      return {
        patch: {},
        note: loDijoElCliente ? undefined : 'Finalizó sin ubicación: queda sin distancia',
      };
    }

    /*
     * Si la recogida nunca se ubico, su punto es el centro del pueblo, no
     * donde estaba el cliente. Medir desde ahi daria una distancia falsa, y
     * una distancia falsa en un informe es peor que una casilla vacia.
     */
    if (ride.pickupSource === 'sin_ubicar') {
      return { patch: {}, note: 'Sin distancia: la recogida nunca se ubicó en el mapa' };
    }

    const origen = { lat: ride.pickupLat, lng: ride.pickupLng };

    /*
     * Guarda contra lecturas basura. Un GPS que devuelve (0, 0) pone el
     * destino en el golfo de Guinea: serian miles de kilometros, y ese numero
     * acabaria en un informe como si fuera cierto.
     */
    const enLineaRecta = haversineKm(origen, destino);
    if (enLineaRecta > RidesService.DISTANCIA_MAXIMA_KM) {
      return {
        patch: {},
        note: `Ubicación descartada: ${Math.round(enLineaRecta)} km del origen`,
      };
    }

    let trayecto;
    try {
      trayecto = this.trayectos.medir(origen, destino);
    } catch (error) {
      // La zona de origen ya no existe o cambió: se cierra igual.
      this.logger.warn({ rideId: ride.id, error }, 'No se pudo medir la carrera al finalizar');
      return { patch: {}, note: 'No se pudo calcular la distancia al finalizar' };
    }

    const patch: Partial<typeof rides.$inferInsert> = { distanceKm: trayecto.distanceKm };

    if (loDijoElCliente) return { patch };

    patch.dropoffLat = destino.lat;
    patch.dropoffLng = destino.lng;
    patch.dropoffSource = 'conductor';
    patch.dropoffText = ride.dropoffText ?? 'Donde terminó la carrera';

    return { patch, note: 'Destino tomado de donde finalizó el conductor' };
  }

  async transition(
    rideId: string,
    to: RideStatus,
    actor: Actor,
    options: TransitionOptions = {},
  ) {
    const eventIds: string[] = [];

    const updated = await this.db.transaction(async (tx) => {
      // `for update` serializa dos cambios simultáneos sobre la misma carrera:
      // el segundo espera y vuelve a leer el estado ya cambiado.
      const [current] = await tx
        .select()
        .from(rides)
        .where(eq(rides.id, rideId))
        .for('update')
        .limit(1);

      if (!current) throw new AppError('NOT_FOUND', `No existe la carrera ${rideId}`);

      if (!canTransition(current.status, to, actor.kind)) {
        throw new AppError(
          'INVALID_TRANSITION',
          `${actor.kind} no puede pasar de ${current.status} a ${to}`,
        );
      }

      const version = current.version + 1;
      const [next] = await tx
        .update(rides)
        .set({ ...options.patch, status: to, version, updatedAt: new Date() })
        .where(eq(rides.id, rideId))
        .returning();

      await tx.insert(rideStatusHistory).values({
        id: uuidv7(),
        rideId,
        fromStatus: current.status,
        toStatus: to,
        actor: actor.kind,
        actorName: actor.name,
        actorId: actor.id,
        lat: options.at?.lat,
        lng: options.at?.lng,
        note: options.note,
      });

      if (options.event) {
        eventIds.push(
          await this.outbox.enqueue(tx, {
            type: options.event.type,
            rideId,
            rideCode: current.code,
            rideVersion: version,
            payload: { code: current.code, status: to, ...options.event.payload },
          }),
        );
      }

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role ?? actor.kind,
          action: `Cambió estado a ${to}`,
          entity: 'rides',
          entityId: current.code,
          before: { status: current.status, version: current.version },
          after: { status: to, version },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );

      return next;
    });

    await this.outbox.notify(eventIds);
    this.realtime.rideChanged(updated);
    return updated;
  }

  /* ------------------------------------------------------------ consultas */

  async byId(rideId: string) {
    const [ride] = await this.db.select().from(rides).where(eq(rides.id, rideId)).limit(1);
    if (!ride) throw new AppError('NOT_FOUND', `No existe la carrera ${rideId}`);
    return ride;
  }

  /**
   * Carrera con el cliente incorporado.
   *
   * El panel necesita el nombre en cada fila; sin el join tendría que pedir
   * el cliente de cada carrera por separado, que con doscientas filas son
   * doscientas peticiones.
   */
  private withCustomer() {
    return this.db
      .select({
        ride: rides,
        customerName: customers.name,
        customerPhone: customers.phone,
        customerEsPrueba: customers.esPrueba,
      })
      .from(rides)
      .innerJoin(customers, eq(customers.id, rides.customerId));
  }

  private static flatten(row: {
    ride: typeof rides.$inferSelect;
    customerName: string | null;
    customerPhone: string;
    customerEsPrueba: boolean;
  }) {
    return {
      ...row.ride,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      customerEsPrueba: row.customerEsPrueba,
    };
  }

  /**
   * Marca un teléfono como del equipo de pruebas. Vale para todas sus
   * carreras, también las de antes: Reportes las saca al contar.
   */
  async marcarClienteDePrueba(customerId: string, esPrueba: boolean, actor: Actor) {
    const [antes] = await this.db
      .select({ phone: customers.phone, esPrueba: customers.esPrueba })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    if (!antes) throw new AppError('NOT_FOUND', 'Ese cliente no existe');
    if (antes.esPrueba === esPrueba) return { esPrueba };

    await this.db.transaction(async (tx) => {
      await tx.update(customers).set({ esPrueba }).where(eq(customers.id, customerId));
      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role ?? actor.kind,
          action: esPrueba ? 'Marcó un teléfono como de prueba' : 'Quitó la marca de prueba a un teléfono',
          entity: 'customers',
          entityId: antes.phone,
          before: { esPrueba: antes.esPrueba },
          after: { esPrueba },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });
    return { esPrueba };
  }

  async detail(rideId: string) {
    const [row] = await this.withCustomer().where(eq(rides.id, rideId)).limit(1);
    if (!row) throw new AppError('NOT_FOUND', `No existe la carrera ${rideId}`);

    const [history, offers] = await Promise.all([
      this.db
        .select()
        .from(rideStatusHistory)
        .where(eq(rideStatusHistory.rideId, rideId))
        .orderBy(rideStatusHistory.at),
      this.db
        .select({
          driverId: rideOffers.driverId,
          driverName: drivers.name,
          wave: rideOffers.wave,
          intento: rideOffers.intento,
          sentAt: rideOffers.sentAt,
          expiresAt: rideOffers.expiresAt,
          etaMinutes: rideOffers.etaMinutes,
          distanceKm: rideOffers.distanceKm,
          response: rideOffers.response,
        })
        .from(rideOffers)
        .innerJoin(drivers, eq(drivers.id, rideOffers.driverId))
        .where(eq(rideOffers.rideId, rideId))
        .orderBy(rideOffers.sentAt),
    ]);

    /*
     * Quién la lleva, con lo que el cliente necesita para reconocer el taxi:
     * nombre, código interno y placa. El flujo de avisos de n8n lo lee de
     * aquí; antes tenía que buscarlo entre las ofertas, y la placa no estaba.
     */
    const [driver] = row.ride.driverId
      ? await this.db
          .select({
            id: drivers.id,
            code: drivers.code,
            name: drivers.name,
            plate: vehicles.plate,
            movil: vehicles.internalNumber,
          })
          .from(drivers)
          .leftJoin(vehicles, eq(vehicles.id, sql`${row.ride.vehicleId}::uuid`))
          .where(eq(drivers.id, row.ride.driverId))
          .limit(1)
      : [];

    return { ...RidesService.flatten(row), driver: driver ?? null, history, offers };
  }

  async list(status?: RideStatus[], limit = 100) {
    const query = this.withCustomer().orderBy(desc(rides.createdAt)).limit(limit);
    const rows = await (status?.length ? query.where(inArray(rides.status, status)) : query);
    return rows.map(RidesService.flatten);
  }

  /**
   * Estado del conductor al abrir o recargar la PWA.
   *
   * Sin esto, un conductor que recarga en mitad de una carrera vería la
   * pantalla de espera: el socket solo trae lo que pasa de ahora en adelante,
   * no lo que ya estaba pasando.
   */
  async driverSession(driverId: string) {
    // Con la carrera ya aceptada, el conductor sí ve el teléfono del cliente:
    // lo necesita para avisar que llegó. Antes de aceptar, no (§8.1).
    const [active] = await this.withCustomer()
      .where(
        and(
          eq(rides.driverId, driverId),
          inArray(rides.status, ['ASSIGNED', 'DRIVER_ARRIVED', 'IN_PROGRESS']),
        ),
      )
      .limit(1);

    if (active) {
      return { activeRide: RidesService.flatten(active), pendingOffer: null };
    }

    // Una oferta viva que el conductor no vio porque estaba sin cobertura.
    // La oferta NO lleva cliente: el conductor decide con la dirección, la
    // distancia y la tarifa, no con quién es.
    const [offer] = await this.db
      .select({
        rideId: rideOffers.rideId,
        wave: rideOffers.wave,
        distanceKm: rideOffers.distanceKm,
        etaMinutes: rideOffers.etaMinutes,
        expiresAt: rideOffers.expiresAt,
        ride: rides,
      })
      .from(rideOffers)
      .innerJoin(rides, eq(rides.id, rideOffers.rideId))
      .where(
        and(
          eq(rideOffers.driverId, driverId),
          eq(rideOffers.response, 'pending'),
          isNull(rideOffers.revokedAt),
          gt(rideOffers.expiresAt, new Date()),
          eq(rides.status, 'NOTIFIED'),
        ),
      )
      .orderBy(desc(rideOffers.sentAt))
      .limit(1);

    return { activeRide: null, pendingOffer: offer ?? null };
  }

  /* ----------------------------------------------- edición de dirección */

  /**
   * RF-11. Cambiar el punto puede cambiar la zona y el tiempo estimado; por
   * eso se recalcula y se avisa a n8n con `ride.eta_updated`.
   */
  async updateAddress(
    rideId: string,
    update: { text: string; reference?: string; point?: Point },
    actor: Actor,
  ) {
    const ride = await this.byId(rideId);

    if (ride.status === 'COMPLETED' || ride.status === 'CANCELLED') {
      throw new AppError('INVALID_TRANSITION', 'La carrera ya terminó');
    }

    const point = update.point ?? { lat: ride.pickupLat!, lng: ride.pickupLng! };
    const trayecto = this.trayectos.medir(
      point,
      ride.dropoffLat && ride.dropoffLng ? { lat: ride.dropoffLat, lng: ride.dropoffLng } : undefined,
    );

    const eventIds: string[] = [];

    const updated = await this.db.transaction(async (tx) => {
      const [next] = await tx
        .update(rides)
        .set({
          pickupText: update.text,
          pickupReference: update.reference,
          pickupLat: point.lat,
          pickupLng: point.lng,
          zoneId: trayecto.originZoneId,
          etaMinutes: trayecto.etaMinutes,
          version: ride.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(rides.id, rideId))
        .returning();

      await tx.insert(rideAddressEdits).values({
        id: uuidv7(),
        rideId,
        field: 'pickup',
        previousValue: ride.pickupText,
        newValue: update.text,
        actor: actor.kind,
        actorName: actor.name,
      });

      eventIds.push(
        await this.outbox.enqueue(tx, {
          type: 'ride.eta_updated',
          rideId,
          rideCode: ride.code,
          rideVersion: ride.version + 1,
          payload: {
            code: ride.code,
            pickup: { text: update.text, reference: update.reference, point },
            etaMinutes: trayecto.etaMinutes,
          },
        }),
      );

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role ?? actor.kind,
          action: 'Editó dirección de recogida',
          entity: 'rides',
          entityId: ride.code,
          before: { pickupText: ride.pickupText },
          after: { pickupText: update.text },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );

      return next;
    });

    await this.outbox.notify(eventIds);
    this.realtime.rideChanged(updated);
    return updated;
  }

  async cancel(rideId: string, reason: string, actor: Actor) {
    const ride = await this.byId(rideId);

    const updated = await this.transition(rideId, 'CANCELLED', actor, {
      note: reason,
      patch: { cancelReason: reason, finishedAt: new Date() },
      event: { type: 'ride.cancelled', payload: { reason } },
    });

    // Las ofertas vivas dejan de tener sentido y el conductor queda libre.
    await this.dispatch.revokeOffers(rideId);
    if (ride.driverId) await this.dispatch.releaseDriver(ride.driverId);

    return updated;
  }
}
