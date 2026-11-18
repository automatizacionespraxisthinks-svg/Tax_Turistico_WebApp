import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { OPEN_RIDE_STATUSES } from '@tax/shared';
import { DB, type Database } from '../../db/db.module';
import {
  customers,
  drivers,
  idempotencyKeys,
  outboxEvents,
  rideAddressEdits,
  ridePhotos,
  rides,
  vehicles,
} from '../../db/schema';
import { AppError } from '../../common/problem';
import { AuditService } from '../audit/audit.service';
import type { Actor } from './rides.service';

/** El teléfono con solo los dos últimos dígitos: lo que va a la bitácora. */
const enmascarar = (telefono: string) => `${'•'.repeat(Math.max(0, telefono.length - 2))}${telefono.slice(-2)}`;

/**
 * Derechos del titular de los datos (Ley 1581 de 2012, art. 8, 14 y 15;
 * 17/11/2026).
 *
 * El cliente que pide un taxi es titular de sus datos: su teléfono, su
 * nombre, dónde lo recogieron y a dónde iba. Puede pedir conocerlos (una
 * consulta: la ley da 10 días hábiles) y que se supriman (un reclamo: 15
 * días hábiles). Antes no había cómo responder ninguna de las dos desde el
 * sistema.
 *
 * - **Consultar** devuelve todo lo que el sistema guarda de esa persona, para
 *   entregárselo.
 * - **Suprimir** borra lo que la identifica y deja lo que no: la carrera
 *   sigue contando en las cifras (fecha, zona, conductor, estado), pero sin
 *   teléfono, nombre, direcciones, notas ni foto, y con la recogida
 *   redondeada a ~1 km. La autorización que dio se conserva como prueba de
 *   que el tratamiento fue legítimo mientras duró.
 *
 * Lo que vive fuera de esta base —la conversación en Chatwoot y la memoria
 * del agente en n8n— se borra allá; la respuesta lo recuerda.
 */
@Injectable()
export class TitularesService {
  private readonly logger = new Logger(TitularesService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Lo básico de un titular, buscado por su teléfono. */
  async buscar(telefono: string) {
    const [cliente] = await this.db
      .select({
        id: customers.id,
        telefono: customers.phone,
        nombre: customers.name,
        desde: customers.createdAt,
        autorizacionVersion: customers.consentVersion,
        autorizacionFecha: customers.consentAt,
        autorizacionCanal: customers.consentChannel,
        suprimidoAt: customers.suprimidoAt,
      })
      .from(customers)
      .where(eq(customers.phone, telefono))
      .limit(1);
    if (!cliente) throw new AppError('NOT_FOUND', 'No hay ningún cliente con ese teléfono');

    const [cuenta] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        abiertas: sql<number>`count(*) filter (where ${inArray(rides.status, OPEN_RIDE_STATUSES)})::int`,
        ultima: sql<Date | null>`max(${rides.createdAt})`,
      })
      .from(rides)
      .where(eq(rides.customerId, cliente.id));

    return { ...cliente, carreras: cuenta?.total ?? 0, abiertas: cuenta?.abiertas ?? 0, ultimaCarrera: cuenta?.ultima ?? null };
  }

  /**
   * Todo lo que el sistema guarda del titular, para entregárselo (consulta).
   * Queda en la bitácora quién lo sacó y cuándo.
   */
  async consultar(customerId: string, actor: Actor) {
    const [cliente] = await this.db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
    if (!cliente) throw new AppError('NOT_FOUND', 'El cliente no existe');

    const carreras = await this.db
      .select({
        codigo: rides.code,
        pedida: rides.createdAt,
        estado: rides.status,
        recogida: rides.pickupText,
        referencia: rides.pickupReference,
        latitud: rides.pickupLat,
        longitud: rides.pickupLng,
        destino: rides.dropoffText,
        pasajeros: rides.passengers,
        pagoElectronico: rides.pagoElectronico,
        notas: rides.notes,
        motivoDeCancelacion: rides.cancelReason,
        conductor: drivers.name,
        placa: vehicles.plate,
        tieneFoto: sql<boolean>`${rides.pickupPhotoAt} is not null`,
      })
      .from(rides)
      .leftJoin(drivers, eq(drivers.id, rides.driverId))
      .leftJoin(vehicles, eq(vehicles.id, rides.vehicleId))
      .where(eq(rides.customerId, customerId))
      .orderBy(desc(rides.createdAt));

    await this.audit.record({
      actorId: actor.id,
      actorName: actor.name,
      role: actor.role ?? actor.kind,
      action: 'Entregó los datos de un cliente (consulta del titular)',
      entity: 'customers',
      entityId: customerId,
      after: { telefono: enmascarar(cliente.phone), carreras: carreras.length },
      ip: actor.ip,
    });

    return {
      generado: new Date().toISOString(),
      responsable: 'Tax Turístico S.A.S.',
      titular: {
        telefono: cliente.suprimidoAt ? null : cliente.phone,
        nombre: cliente.name,
        clienteDesde: cliente.createdAt,
        autorizacion: cliente.consentVersion
          ? { version: cliente.consentVersion, fecha: cliente.consentAt, canal: cliente.consentChannel }
          : null,
        datosSuprimidos: cliente.suprimidoAt,
      },
      carreras,
      fueraDeEsteSistema:
        'La conversación de WhatsApp vive en Chatwoot y en la memoria del asistente (n8n); se consulta allá.',
    };
  }

  /**
   * Suprime lo que identifica al titular (reclamo de supresión). No se puede
   * con una carrera abierta: el conductor necesita el teléfono y la
   * dirección para llegar. Todo va en una transacción: o se borra todo, o
   * nada.
   */
  async suprimir(customerId: string, motivo: string, actor: Actor) {
    const resultado = await this.db.transaction(async (tx) => {
      const [cliente] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, customerId))
        .for('update')
        .limit(1);
      if (!cliente) throw new AppError('NOT_FOUND', 'El cliente no existe');
      if (cliente.suprimidoAt) throw new AppError('VALIDATION_FAILED', 'Los datos de este cliente ya se suprimieron');

      const suyas = await tx
        .select({ id: rides.id, status: rides.status })
        .from(rides)
        .where(eq(rides.customerId, customerId));
      if (suyas.some((r) => (OPEN_RIDE_STATUSES as string[]).includes(r.status))) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Tiene una carrera abierta: espera a que termine o cancélala antes de suprimir sus datos.',
        );
      }
      const ids = suyas.map((r) => r.id);

      if (ids.length > 0) {
        // La carrera queda para las cifras, sin lo que identifica a la persona.
        await tx
          .update(rides)
          .set({
            pickupText: '[suprimido]',
            pickupReference: null,
            pickupLink: null,
            pickupLat: sql`round(${rides.pickupLat}::numeric, 2)::float8`,
            pickupLng: sql`round(${rides.pickupLng}::numeric, 2)::float8`,
            dropoffText: null,
            dropoffLat: null,
            dropoffLng: null,
            notes: null,
            cancelReason: sql`case when ${rides.cancelReason} is null then null else '[suprimido]' end`,
            pickupPhotoAt: null,
          })
          .where(inArray(rides.id, ids));
        await tx.delete(ridePhotos).where(inArray(ridePhotos.rideId, ids));
        await tx
          .update(rideAddressEdits)
          .set({ previousValue: null, newValue: '[suprimido]' })
          .where(inArray(rideAddressEdits.rideId, ids));
        // Lo que se le mandó a n8n de esas carreras ya se entregó: no hace
        // falta guardar la dirección ni el teléfono.
        await tx
          .update(outboxEvents)
          .set({ payload: { suprimido: true } })
          .where(and(inArray(outboxEvents.rideId, ids), inArray(outboxEvents.status, ['delivered', 'dead'])));
      }

      // Respuestas guardadas para reintentos: llevan el teléfono.
      await tx.delete(idempotencyKeys).where(sql`${idempotencyKeys.responseBody}::text like ${`%${cliente.phone}%`}`);

      await tx
        .update(customers)
        .set({
          phone: `suprimido:${cliente.id}`,
          name: null,
          lastLat: null,
          lastLng: null,
          suprimidoAt: new Date(),
        })
        .where(eq(customers.id, customerId));

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role ?? actor.kind,
          action: 'Suprimió los datos de un cliente (reclamo del titular)',
          entity: 'customers',
          entityId: customerId,
          after: { telefono: enmascarar(cliente.phone), carreras: ids.length, motivo: motivo.trim().slice(0, 200) },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );

      return { carreras: ids.length };
    });

    this.logger.log({ customerId, carreras: resultado.carreras }, 'Datos de un cliente suprimidos');
    return {
      ok: true,
      carreras: resultado.carreras,
      pendienteFuera:
        'Falta borrar la conversación en Chatwoot y la memoria del asistente en n8n: el sistema no las guarda.',
    };
  }
}
