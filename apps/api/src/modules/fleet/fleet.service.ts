import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Point, VehicleType } from '@tax/shared';
import {
  ACTIVE_RIDE_STATUSES,
  estimateEtaMinutes,
  finDeSuspension,
  haversineKm,
  sigueSuspendido,
} from '@tax/shared';
import { DB, type Database } from '../../db/db.module';
import { REDIS, redisKeys } from '../../redis/redis.module';
import {
  driverDevices,
  driverPositions,
  driverShifts,
  drivers,
  rides,
  vehicleDrivers,
  vehicles,
} from '../../db/schema';
import { AppError } from '../../common/problem';
import { loadEnv } from '../../config/env';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { ZonesService } from '../pricing/zones.service';
import { isUniqueViolation } from '../../common/pg-errors';

/**
 * Sin suspensión en pie: nunca suspendido, o la suspensión ya se cumplió. Se
 * compara con la hora de la base, así una suspensión vence sola sin que
 * nadie tenga que quitarla.
 */
export const noSuspendido = sql`(${drivers.suspendidoHasta} is null or ${drivers.suspendidoHasta} <= now())`;

/** Un móvil al que está vinculado un conductor, según el listado maestro. */
export interface MovilVinculado {
  internalNumber: string | null;
  plate: string;
  brand: string | null;
  modelYear: number | null;
  role: 'conductor' | 'relevador';
  active: boolean;
}

export interface DriverWithPosition {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  licenseExpiresOn: string | null;
  licenseRestriction: string | null;
  moviles: MovilVinculado[];
  status: string;
  active: boolean;
  esPrueba: boolean;
  aceptaPagoElectronico: boolean;
  /** Solo mientras la suspensión sigue en pie. */
  suspendidoHasta?: Date;
  motivoSuspension?: string;
  shiftStartedAt: Date | null;
  plate: string | null;
  vehicleType: string | null;
  capacity: number | null;
  vehicleActive: boolean | null;
  position?: { lat: number; lng: number };
  positionAgeSeconds?: number;
}

export interface Candidate {
  driverId: string;
  name: string;
  code: string;
  vehicleId: string;
  plate: string;
  distanceKm: number;
  etaMinutes: number;
}

/**
 * Flota.
 *
 * Es dueño de conductores, vehículos, turnos y posición en vivo, y expone al
 * despacho una sola cosa: la búsqueda de candidatos por radio y tipo (§4.1).
 *
 * La última posición vive en Redis (GEOSEARCH responde en milisegundos sin
 * otra instancia, ADR-05); el histórico se muestrea a Postgres.
 */
@Injectable()
export class FleetService {
  private readonly env = loadEnv();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly zonesService: ZonesService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /* ------------------------------------------------------------- turnos */

  async openShift(driverId: string, plate: string): Promise<{ shiftId: string }> {
    await this.exigirNoSuspendido(driverId);

    const [vehicle] = await this.db
      .select()
      .from(vehicles)
      .where(and(eq(vehicles.plate, plate.toUpperCase()), eq(vehicles.active, true)))
      .limit(1);

    if (!vehicle) throw new AppError('NOT_FOUND', `No hay un vehículo activo con placa ${plate}`);

    await this.relevar(vehicle.id, vehicle.plate, driverId);

    const shiftId = uuidv7();

    // Los índices parciales `one_open_shift_per_*` garantizan que no haya dos
    // turnos abiertos del mismo conductor ni del mismo vehículo; si los hay,
    // la base rechaza la inserción y aquí se traduce a un error legible.
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(driverShifts).values({ id: shiftId, driverId, vehicleId: vehicle.id });
        await tx.update(drivers).set({ status: 'AVAILABLE' }).where(eq(drivers.id, driverId));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError('DRIVER_BUSY', 'Ya hay un turno abierto para este conductor o vehículo');
      }
      throw error;
    }

    return { shiftId };
  }

  /**
   * Relevo: un carro lo manejan varios conductores —el titular y sus
   * relevadores— con la misma placa, y lo normal es que quien entrega el
   * carro olvide cerrar su turno en la PWA.
   *
   * Si el carro sigue con el turno abierto de otro, ese turno se cierra y el
   * que llega abre el suyo: el carro solo puede estar en una mano a la vez, y
   * la que manda es la de quien lo tiene ahora. La única excepción es una
   * carrera en curso: entonces el carro está ocupado de verdad y no se le
   * quita a nadie a mitad de camino.
   */
  private async relevar(vehicleId: string, plate: string, driverId: string): Promise<void> {
    const [otro] = await this.db
      .select({ driverId: driverShifts.driverId, name: drivers.name })
      .from(driverShifts)
      .innerJoin(drivers, eq(drivers.id, driverShifts.driverId))
      .where(and(eq(driverShifts.vehicleId, vehicleId), isNull(driverShifts.endedAt)))
      .limit(1);

    if (!otro || otro.driverId === driverId) return;

    if (await this.tieneCarreraActiva(otro.driverId)) {
      throw new AppError(
        'DRIVER_BUSY',
        `El móvil ${plate} está en una carrera con ${otro.name}. Cuando la termine, vuelve a intentarlo.`,
      );
    }

    await this.closeShift(otro.driverId);
    this.realtime.turnoCerrado(otro.driverId, `Otro conductor tomó el móvil ${plate}. Tu turno quedó cerrado.`);
  }

  /** Si tiene una carrera asignada, en el punto o en curso. */
  async tieneCarreraActiva(driverId: string): Promise<boolean> {
    const [fila] = await this.db
      .select({ id: rides.id })
      .from(rides)
      .where(and(eq(rides.driverId, driverId), inArray(rides.status, ACTIVE_RIDE_STATUSES)))
      .limit(1);
    return fila !== undefined;
  }

  /** Hasta cuándo está suspendido, o nulo si no lo está (o ya se cumplió). */
  async suspensionDe(driverId: string): Promise<Date | null> {
    const [fila] = await this.db
      .select({ hasta: drivers.suspendidoHasta })
      .from(drivers)
      .where(eq(drivers.id, driverId))
      .limit(1);
    return fila?.hasta && sigueSuspendido(fila.hasta) ? fila.hasta : null;
  }

  async exigirNoSuspendido(driverId: string): Promise<void> {
    const hasta = await this.suspensionDe(driverId);
    if (hasta) {
      throw new AppError(
        'DRIVER_SUSPENDED',
        `Estás suspendido hasta el ${finDeSuspension(hasta)}; para cualquier duda, llama a la oficina.`,
      );
    }
  }

  async closeShift(driverId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(driverShifts)
        .set({ endedAt: new Date() })
        .where(and(eq(driverShifts.driverId, driverId), isNull(driverShifts.endedAt)));

      await tx.update(drivers).set({ status: 'OFF_SHIFT' }).where(eq(drivers.id, driverId));
    });

    // Fuera de turno no se guarda posición: se borra la que hubiera (§9.2).
    await this.redis.zrem(redisKeys.driverPositions, driverId);
    await this.redis.del(redisKeys.driverMeta(driverId));
  }

  /**
   * Pausa y reanudación del turno.
   *
   * La pausa existía solo en el teléfono: la PWA se pintaba «En pausa» y no
   * se lo decía a nadie, así que el conductor seguía `AVAILABLE` en la base,
   * el despacho le seguía ofreciendo carreras y la siguiente recuperación de
   * estado le devolvía la pantalla a «esperando carrera».
   *
   * Va como UPDATE condicional y no como lectura-y-escritura a propósito. El
   * despacho pone `ON_RIDE` desde otro proceso; entre un `select` y un
   * `update` cabe perfectamente una asignación, y el conductor se quedaría
   * «en pausa» con una carrera asignada que nadie le mostraría. Al exigir el
   * estado de partida en el `where`, o la fila era la que creíamos o no se
   * toca nada.
   */
  async pauseShift(driverId: string): Promise<void> {
    await this.cambiarEstadoDeTurno(driverId, 'AVAILABLE', 'PAUSED');
  }

  async resumeShift(driverId: string): Promise<void> {
    await this.cambiarEstadoDeTurno(driverId, 'PAUSED', 'AVAILABLE');
  }

  private async cambiarEstadoDeTurno(
    driverId: string,
    desde: 'AVAILABLE' | 'PAUSED',
    hasta: 'AVAILABLE' | 'PAUSED',
  ): Promise<void> {
    const cambiadas = await this.db
      .update(drivers)
      .set({ status: hasta })
      .where(and(eq(drivers.id, driverId), eq(drivers.status, desde)))
      .returning({ id: drivers.id });

    if (cambiadas.length > 0) return;

    /*
     * No cambió nada. Puede ser que ya estuviera en el estado pedido —dos
     * toques seguidos, o el reenvío de la cola al volver la señal— y eso no
     * es un error: el resultado es el que el conductor quería. Lo demás sí.
     */
    const [actual] = await this.db
      .select({ status: drivers.status })
      .from(drivers)
      .where(eq(drivers.id, driverId))
      .limit(1);

    if (!actual) throw new AppError('NOT_FOUND', 'El conductor no existe');
    if (actual.status === hasta) return;

    if (actual.status === 'ON_RIDE') {
      throw new AppError('DRIVER_BUSY', 'No se puede pausar con una carrera en curso');
    }

    throw new AppError('DRIVER_OFF_SHIFT', 'No hay un turno abierto para pausar');
  }

  /**
   * Turno abierto del conductor, si lo hay.
   *
   * Lo necesita la PWA al arrancar: sin esto, un conductor cuyo turno quedó
   * abierto —app reinstalada, celular cambiado— ve la pantalla de «fuera de
   * turno» y al intentar abrirlo choca contra el índice único, sin salida.
   */
  async currentShift(
    driverId: string,
  ): Promise<{ shiftId: string; plate: string; startedAt: Date; paused: boolean } | null> {
    const [shift] = await this.db
      .select({
        shiftId: driverShifts.id,
        plate: vehicles.plate,
        startedAt: driverShifts.startedAt,
        status: drivers.status,
      })
      .from(driverShifts)
      .innerJoin(vehicles, eq(vehicles.id, driverShifts.vehicleId))
      .innerJoin(drivers, eq(drivers.id, driverShifts.driverId))
      .where(and(eq(driverShifts.driverId, driverId), isNull(driverShifts.endedAt)))
      .limit(1);

    if (!shift) return null;

    // La pausa viaja con el turno porque es justo cuando importa: al abrir la
    // aplicación hay que devolver al conductor a la pantalla que dejó, no a
    // «esperando carrera».
    const { status, ...resto } = shift;
    return { ...resto, paused: status === 'PAUSED' };
  }

  /**
   * Carreras que el conductor lleva hoy. Hoy en Paipa: la base corre en UTC,
   * y a las siete de la tarde allí ya es el día siguiente.
   */
  async todayTotals(driverId: string): Promise<{ rides: number }> {
    const result = await this.db.execute<{ rides: number }>(sql`
      select count(*)::int as rides
        from rides
       where driver_id = ${driverId}
         and status = 'COMPLETED'
         and finished_at >= date_trunc('day', now() at time zone 'America/Bogota') at time zone 'America/Bogota'
    `);

    return result.rows[0] ?? { rides: 0 };
  }

  private async openShiftOf(driverId: string): Promise<{ id: string; vehicleId: string } | null> {
    const [shift] = await this.db
      .select({ id: driverShifts.id, vehicleId: driverShifts.vehicleId })
      .from(driverShifts)
      .where(and(eq(driverShifts.driverId, driverId), isNull(driverShifts.endedAt)))
      .limit(1);
    return shift ?? null;
  }

  /* ----------------------------------------------------------- posición */

  /**
   * Registra la posición del conductor.
   *
   * Solo con turno abierto (§9.2). Redis guarda la última; a Postgres se
   * muestrea cada 30 s fuera de carrera y cada 10 s en carrera, que es lo que
   * fija la retención del histórico (§6).
   */
  async recordPosition(
    driverId: string,
    point: Point,
    options: { rideId?: string; accuracyMeters?: number } = {},
  ): Promise<void> {
    const shift = await this.openShiftOf(driverId);
    if (!shift) throw new AppError('DRIVER_OFF_SHIFT', 'No se registra GPS sin turno abierto');

    const now = Date.now();
    const metaKey = redisKeys.driverMeta(driverId);

    await this.redis
      .multi()
      .geoadd(redisKeys.driverPositions, point.lng, point.lat, driverId)
      .hset(metaKey, { at: String(now), rideId: options.rideId ?? '' })
      // Si el conductor deja de reportar, la clave caduca y deja de aparecer
      // como candidato aunque el proceso no se entere.
      .expire(metaKey, 15 * 60)
      .exec();

    const sampleEverySeconds = options.rideId ? 10 : 30;
    const lastSampled = Number((await this.redis.hget(metaKey, 'sampledAt')) ?? 0);

    if (now - lastSampled >= sampleEverySeconds * 1000) {
      await this.redis.hset(metaKey, 'sampledAt', String(now));
      await this.db.insert(driverPositions).values({
        id: uuidv7(),
        driverId,
        shiftId: shift.id,
        lat: point.lat,
        lng: point.lng,
        accuracyMeters: options.accuracyMeters,
        rideId: options.rideId,
      });
    }
  }

  /** Antigüedad en segundos de la última posición conocida. */
  async positionAgeSeconds(driverId: string): Promise<number | null> {
    const at = await this.redis.hget(redisKeys.driverMeta(driverId), 'at');
    if (!at) return null;
    return Math.round((Date.now() - Number(at)) / 1000);
  }

  /* --------------------------------------------------------- candidatos */

  /**
   * Candidatos para una oleada (§5.2).
   *
   * Dos pasos a propósito: Redis responde «quién está cerca» en milisegundos,
   * y Postgres decide «quién puede» con los datos que mandan (estado, tipo de
   * vehículo, turno). Hacerlo al revés obligaría a recorrer toda la flota.
   */
  /**
   * Todos los conductores disponibles, sin mirar distancia.
   *
   * Es la ronda final para pruebas (`OLEADA_FINAL_A_TODOS`): no filtra por
   * radio, ni por tipo de vehiculo, ni por lo vieja que este su posicion.
   * Con un solo conductor en turno lejos del punto, las tres oleadas por
   * radio no lo encuentran nunca, y no habria forma de ver un aviso de
   * verdad llegando a un telefono.
   *
   * Lo unico que exige es que el conductor haya mandado alguna posicion en
   * este turno, porque sin ella no hay distancia ni tiempo que ofrecerle, y
   * la oferta los guarda. Los que estan disponibles pero nunca mandaron GPS
   * se cuentan aparte en `sinGps`: si no, el panel diria «nadie disponible»
   * mientras el conductor esta en turno, y parece un fallo del despacho.
   */
  async findAllAvailable(
    pickup: Point,
    exclude: string[] = [],
    pagoElectronico = false,
  ): Promise<{ candidates: Candidate[]; sinGps: number }> {
    const rows = await this.db
      .select({
        driverId: drivers.id,
        name: drivers.name,
        code: drivers.code,
        vehicleId: vehicles.id,
        plate: vehicles.plate,
      })
      .from(drivers)
      .innerJoin(driverShifts, and(eq(driverShifts.driverId, drivers.id), isNull(driverShifts.endedAt)))
      .innerJoin(vehicles, eq(vehicles.id, driverShifts.vehicleId))
      .where(
        and(
          eq(drivers.status, 'AVAILABLE'),
          eq(drivers.active, true),
          noSuspendido,
          pagoElectronico ? eq(drivers.aceptaPagoElectronico, true) : undefined,
          eq(vehicles.active, true),
        ),
      );

    const excluidos = new Set(exclude);
    const disponibles = rows.filter((row) => !excluidos.has(row.driverId));
    if (disponibles.length === 0) return { candidates: [], sinGps: 0 };

    // Una sola ida a Redis para todas las posiciones, como en el mapa.
    const posiciones = await this.redis.geopos(
      redisKeys.driverPositions,
      ...disponibles.map((row) => row.driverId),
    );

    const zona = this.zonesService.classify(pickup);
    const tortuosidad = zona?.tortuosity ?? 1.5;

    const candidates: Candidate[] = [];
    let sinGps = 0;

    disponibles.forEach((row, i) => {
      const posicion = posiciones[i];
      if (!posicion || !posicion[0] || !posicion[1]) {
        sinGps++;
        return;
      }
      const distanceKm = haversineKm(pickup, { lat: Number(posicion[1]), lng: Number(posicion[0]) });
      candidates.push({
        driverId: row.driverId,
        name: row.name,
        code: row.code,
        vehicleId: row.vehicleId,
        plate: row.plate,
        distanceKm: Math.round(distanceKm * 100) / 100,
        etaMinutes: estimateEtaMinutes(distanceKm, tortuosidad),
      });
    });

    return {
      candidates: candidates.sort((a, b) => a.etaMinutes - b.etaMinutes),
      sinGps,
    };
  }

  /**
   * Con `pagoElectronico`, solo los que lo aceptan: es un filtro más, como el
   * tipo de vehículo, y no cambia las oleadas ni sus radios por zona.
   */
  async findCandidates(
    pickup: Point,
    radiusKm: number,
    vehicleType: VehicleType,
    limit: number,
    exclude: string[] = [],
    pagoElectronico = false,
  ): Promise<Candidate[]> {
    const nearby = (await this.redis.geosearch(
      redisKeys.driverPositions,
      'FROMLONLAT',
      pickup.lng,
      pickup.lat,
      'BYRADIUS',
      radiusKm,
      'km',
      'ASC',
      'WITHDIST',
      // Se pide holgura porque muchos de los cercanos se caerán en el filtro
      // de Postgres (ocupados, tipo distinto, GPS viejo, sin pago electrónico).
      'COUNT',
      Math.max(limit * (pagoElectronico ? 8 : 4), 20),
    )) as [string, string][];

    const excluded = new Set(exclude);
    const distanceByDriver = new Map<string, number>();
    for (const entry of nearby) {
      const [driverId, distance] = entry;
      if (!excluded.has(driverId)) distanceByDriver.set(driverId, Number(distance));
    }

    if (distanceByDriver.size === 0) return [];

    const ids = [...distanceByDriver.keys()];

    const rows = await this.db
      .select({
        driverId: drivers.id,
        name: drivers.name,
        code: drivers.code,
        vehicleId: vehicles.id,
        plate: vehicles.plate,
      })
      .from(drivers)
      .innerJoin(driverShifts, and(eq(driverShifts.driverId, drivers.id), isNull(driverShifts.endedAt)))
      .innerJoin(vehicles, eq(vehicles.id, driverShifts.vehicleId))
      .where(
        and(
          inArray(drivers.id, ids),
          eq(drivers.status, 'AVAILABLE'),
          eq(drivers.active, true),
          noSuspendido,
          pagoElectronico ? eq(drivers.aceptaPagoElectronico, true) : undefined,
          eq(vehicles.active, true),
          eq(vehicles.type, vehicleType),
        ),
      );

    const zone = this.zonesService.classify(pickup);
    const tortuosity = zone?.tortuosity ?? 1.5;

    const candidates: Candidate[] = [];
    for (const row of rows) {
      // Una posición vieja no sirve para prometer un ETA (§5.2).
      const age = await this.positionAgeSeconds(row.driverId);
      if (age === null || age > this.env.POSITION_MAX_AGE_SECONDS) continue;

      const distanceKm = distanceByDriver.get(row.driverId) ?? 0;
      candidates.push({
        driverId: row.driverId,
        name: row.name,
        code: row.code,
        vehicleId: row.vehicleId,
        plate: row.plate,
        distanceKm: Math.round(distanceKm * 100) / 100,
        etaMinutes: estimateEtaMinutes(distanceKm, tortuosity),
      });
    }

    // Se ordena por ETA, no por distancia: en vereda, dos kilómetros de
    // destapado pesan más que tres de pavimento.
    return candidates.sort((a, b) => a.etaMinutes - b.etaMinutes).slice(0, limit);
  }

  /**
   * Flota completa con la posición en vivo, para el mapa del panel.
   *
   * Las posiciones se piden a Redis en un solo `GEOPOS` en vez de una
   * consulta por conductor: con 62 taxis la diferencia entre una ida y 62 es
   * la que se nota en el refresco del mapa.
   */
  async listWithPositions(): Promise<DriverWithPosition[]> {
    const rows = await this.db
      .select({
        id: drivers.id,
        code: drivers.code,
        name: drivers.name,
        phone: drivers.phone,
        licenseExpiresOn: drivers.licenseExpiresOn,
        licenseRestriction: drivers.licenseRestriction,
        status: drivers.status,
        active: drivers.active,
        esPrueba: drivers.esPrueba,
        aceptaPagoElectronico: drivers.aceptaPagoElectronico,
        suspendidoHasta: drivers.suspendidoHasta,
        motivoSuspension: drivers.motivoSuspension,
        shiftStartedAt: driverShifts.startedAt,
        plate: vehicles.plate,
        vehicleType: vehicles.type,
        capacity: vehicles.capacity,
        vehicleActive: vehicles.active,
      })
      .from(drivers)
      .leftJoin(driverShifts, and(eq(driverShifts.driverId, drivers.id), isNull(driverShifts.endedAt)))
      .leftJoin(vehicles, eq(vehicles.id, driverShifts.vehicleId))
      .orderBy(drivers.code);

    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    const positions = await this.redis.geopos(redisKeys.driverPositions, ...ids);

    // Un pipeline para las antigüedades: igual que arriba, una ida en vez de
    // una por conductor.
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hget(redisKeys.driverMeta(id), 'at');
    const ages = await pipeline.exec();

    /*
     * Qué conductores tienen celular vivo.
     *
     * El panel lo daba por cierto siempre —estaba escrito a mano como `true`
     * en su mapeador—, así que la alerta «dispositivo sin registrar» no se
     * encendía nunca y la ficha decía «Sí» incluso para alguien a quien le
     * acababan de revocar el teléfono. Una consulta más, en vez de una por
     * conductor.
     */
    const conDispositivo = await this.db
      .selectDistinct({ driverId: driverDevices.driverId })
      .from(driverDevices)
      .where(and(inArray(driverDevices.driverId, ids), isNull(driverDevices.revokedAt)));
    const registrados = new Set(conDispositivo.map((row) => row.driverId));

    // Los móviles de cada uno, del listado maestro: una consulta para todos.
    const vinculos = await this.db
      .select({
        driverId: vehicleDrivers.driverId,
        role: vehicleDrivers.role,
        internalNumber: vehicles.internalNumber,
        plate: vehicles.plate,
        brand: vehicles.brand,
        modelYear: vehicles.modelYear,
        active: vehicles.active,
      })
      .from(vehicleDrivers)
      .innerJoin(vehicles, eq(vehicles.id, vehicleDrivers.vehicleId))
      .where(inArray(vehicleDrivers.driverId, ids))
      .orderBy(vehicles.internalNumber);
    const movilesDe = new Map<string, MovilVinculado[]>();
    for (const { driverId, ...movil } of vinculos) {
      movilesDe.set(driverId, [...(movilesDe.get(driverId) ?? []), movil]);
    }

    const now = Date.now();

    return rows.map(({ suspendidoHasta, motivoSuspension, ...row }, index) => {
      const position = positions[index];
      const recordedAt = ages?.[index]?.[1] as string | null | undefined;
      // Una suspensión cumplida no se manda: para el panel ya no existe.
      const suspendido = suspendidoHasta && sigueSuspendido(suspendidoHasta) ? suspendidoHasta : undefined;

      return {
        ...row,
        suspendidoHasta: suspendido,
        motivoSuspension: suspendido ? (motivoSuspension ?? undefined) : undefined,
        moviles: movilesDe.get(row.id) ?? [],
        deviceRegistered: registrados.has(row.id),
        position:
          position && position[0] && position[1]
            ? { lat: Number(position[1]), lng: Number(position[0]) }
            : undefined,
        positionAgeSeconds: recordedAt ? Math.round((now - Number(recordedAt)) / 1000) : undefined,
      };
    });
  }

  async setStatus(driverId: string, status: 'AVAILABLE' | 'ON_RIDE' | 'PAUSED'): Promise<void> {
    await this.db.update(drivers).set({ status }).where(eq(drivers.id, driverId));
  }
}

