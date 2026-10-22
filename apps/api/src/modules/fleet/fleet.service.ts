import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Point, VehicleType } from '@tax/shared';
import { estimateEtaMinutes } from '@tax/shared';
import { DB, type Database } from '../../db/db.module';
import { REDIS, redisKeys } from '../../redis/redis.module';
import { driverDevices, driverPositions, driverShifts, drivers, vehicles } from '../../db/schema';
import { AppError } from '../../common/problem';
import { loadEnv } from '../../config/env';
import { ZonesService } from '../pricing/zones.service';
import { isUniqueViolation } from '../../common/pg-errors';

export interface DriverWithPosition {
  id: string;
  code: string;
  name: string;
  phone: string;
  status: string;
  active: boolean;
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
  ) {}

  /* ------------------------------------------------------------- turnos */

  async openShift(driverId: string, plate: string): Promise<{ shiftId: string }> {
    const [vehicle] = await this.db
      .select()
      .from(vehicles)
      .where(and(eq(vehicles.plate, plate.toUpperCase()), eq(vehicles.active, true)))
      .limit(1);

    if (!vehicle) throw new AppError('NOT_FOUND', `No hay un vehículo activo con placa ${plate}`);

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
   * Turno abierto del conductor, si lo hay.
   *
   * Lo necesita la PWA al arrancar: sin esto, un conductor cuyo turno quedó
   * abierto —app reinstalada, celular cambiado— ve la pantalla de «fuera de
   * turno» y al intentar abrirlo choca contra el índice único, sin salida.
   */
  async currentShift(
    driverId: string,
  ): Promise<{ shiftId: string; plate: string; startedAt: Date } | null> {
    const [shift] = await this.db
      .select({
        shiftId: driverShifts.id,
        plate: vehicles.plate,
        startedAt: driverShifts.startedAt,
      })
      .from(driverShifts)
      .innerJoin(vehicles, eq(vehicles.id, driverShifts.vehicleId))
      .where(and(eq(driverShifts.driverId, driverId), isNull(driverShifts.endedAt)))
      .limit(1);

    return shift ?? null;
  }

  /** Lo que el conductor lleva hoy: carreras finalizadas y suma de tarifas. */
  async todayTotals(driverId: string): Promise<{ rides: number; earned: number }> {
    const result = await this.db.execute<{ rides: number; earned: number }>(sql`
      select count(*)::int as rides,
             coalesce(sum(fare_estimate), 0)::int as earned
        from rides
       where driver_id = ${driverId}
         and status = 'COMPLETED'
         and finished_at >= date_trunc('day', now())
    `);

    return result.rows[0] ?? { rides: 0, earned: 0 };
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
  async findCandidates(
    pickup: Point,
    radiusKm: number,
    vehicleType: VehicleType,
    limit: number,
    exclude: string[] = [],
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
      // de Postgres (ocupados, tipo distinto, GPS viejo).
      'COUNT',
      Math.max(limit * 4, 20),
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
        status: drivers.status,
        active: drivers.active,
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

    const now = Date.now();

    return rows.map((row, index) => {
      const position = positions[index];
      const recordedAt = ages?.[index]?.[1] as string | null | undefined;

      return {
        ...row,
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

