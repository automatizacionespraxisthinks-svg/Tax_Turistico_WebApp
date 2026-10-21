import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { CreateRideInput, Point, RideStatus, TransitionActor } from '@tax/shared';
import { canTransition, formatRideCode } from '@tax/shared';
import { DB, type Database, type Tx } from '../../db/db.module';
import {
  customers,
  drivers,
  rideAddressEdits,
  rideOffers,
  rideStatusHistory,
  rides,
} from '../../db/schema';
import { AppError } from '../../common/problem';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../integrations/outbox.service';
import { FaresService } from '../pricing/fares.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { isUniqueViolation } from '../../common/pg-errors';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

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

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly fares: FaresService,
    private readonly realtime: RealtimeGateway,
    @Inject(forwardRef(() => DispatchService))
    private readonly dispatch: DispatchService,
  ) {}

  /* ------------------------------------------------------------- creación */

  async create(input: CreateRideInput, actor: Actor) {
    if (!input.pickup.point) {
      throw new AppError(
        'MISSING_LOCATION',
        'Hace falta la ubicación del punto de recogida para despachar',
      );
    }

    const quote = await this.fares.quote(input.pickup.point, input.dropoff?.point);
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
            pickupLat: input.pickup.point!.lat,
            pickupLng: input.pickup.point!.lng,
            dropoffText: input.dropoff?.text,
            dropoffLat: input.dropoff?.point?.lat,
            dropoffLng: input.dropoff?.point?.lng,
            zoneId: quote.originZoneId,
            vehicleType: input.vehicleType,
            passengers: input.passengers,
            fareEstimate: quote.amount,
            fareRuleVersion: quote.ruleVersion,
            etaMinutes: quote.etaMinutes,
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
              pickup: input.pickup,
              dropoff: input.dropoff,
              fareEstimate: quote.amount,
              fareApproximate: true,
              zone: quote.originZoneName,
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
            after: { code, status: 'PENDING', fareEstimate: quote.amount },
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
      })
      .from(rides)
      .innerJoin(customers, eq(customers.id, rides.customerId));
  }

  private static flatten(row: {
    ride: typeof rides.$inferSelect;
    customerName: string | null;
    customerPhone: string;
  }) {
    return { ...row.ride, customerName: row.customerName, customerPhone: row.customerPhone };
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

    return { ...RidesService.flatten(row), history, offers };
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
   * RF-11. Cambiar el punto puede cambiar la zona y, con ella, la tarifa; por
   * eso se recalcula y se avisa a n8n con `ride.eta_updated`, en vez de dejar
   * al cliente con un número que ya no es.
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
    const quote = await this.fares.quote(
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
          zoneId: quote.originZoneId,
          fareEstimate: quote.amount,
          fareRuleVersion: quote.ruleVersion,
          etaMinutes: quote.etaMinutes,
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
            fareEstimate: quote.amount,
            etaMinutes: quote.etaMinutes,
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
          before: { pickupText: ride.pickupText, fareEstimate: ride.fareEstimate },
          after: { pickupText: update.text, fareEstimate: quote.amount },
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
