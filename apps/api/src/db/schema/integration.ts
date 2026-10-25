import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { outboxEventType, outboxStatus } from './enums';

/**
 * Transactional Outbox (ADR-06).
 *
 * El evento se inserta en la MISMA transacción que cambia la carrera, así que
 * no existe un evento de algo que no ocurrió ni un cambio sin evento. Un
 * trabajo de BullMQ lo entrega después, con reintentos y backoff.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    /** Identificador que viaja en la cabecera X-Tax-Event-Id; n8n lo guarda
        para descartar repetidos (§7.1). */
    eventId: uuid('event_id').primaryKey(),
    type: outboxEventType('type').notNull(),
    rideId: uuid('ride_id'),
    rideCode: text('ride_code'),
    /** Versión de la carrera en el momento del evento: n8n ignora un evento
        con versión menor a la ya procesada (§7.1, «Orden»). */
    rideVersion: integer('ride_version'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: outboxStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /* El relay busca lo pendiente cuyo turno ya llegó. */
    index('outbox_pending_idx').on(table.status, table.nextAttemptAt),
    index('outbox_ride_idx').on(table.rideId, table.rideVersion),
  ],
);

/**
 * Claves de idempotencia (§7.1).
 *
 * La clave la deriva n8n de la conversación más el ID del mensaje de
 * confirmación del cliente, no de la hora. Se guarda 24 h junto al hash del
 * cuerpo: la misma clave con un cuerpo distinto es un 409.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    /** SHA-256 del cuerpo de la petición. */
    bodyHash: text('body_hash').notNull(),
    /** Respuesta que se devolvió la primera vez, para repetirla tal cual. */
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idempotency_expires_idx').on(table.expiresAt)],
);

/**
 * Las líneas de WhatsApp, tal como las ve el monitor (§10.4).
 *
 * Cada sesión de WAHA es una línea; el identificador es el nombre de la
 * sesión. La tabla la escribe el monitor cada minuto: antes solo la llenaba
 * el sembrado de desarrollo, y en producción la página de estado salía vacía.
 */
export const wahaSessions = pgTable(
  'waha_sessions',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    /** Nulo mientras la sesión no tiene número vinculado (pide el QR). */
    phone: text('phone'),
    /**
     * Lo último que se vio, traducido (`WahaSessionStatus`): `working`,
     * `scan_qr`, `failed`… o, puestos por el monitor, `no_response` y `missing`.
     */
    status: text('status').notNull(),
    /**
     * Si la línea se da por conectada. No es lo mismo que `status`: un
     * STARTING suelto o un WAHA que no contesta una vez no la tumban, porque
     * un reinicio de WAHA dura segundos y alertaría de caída y de vuelta.
     * Solo cambia cuando el monitor está seguro, y es lo que dispara alertas.
     */
    connected: boolean('connected').notNull().default(true),
    /** Desde cuándo está en el estado actual de `connected`. */
    statusSince: timestamp('status_since', { withTimezone: true }),
    lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
    messagesToday: integer('messages_today').notNull().default(0),
  },
  (table) => [uniqueIndex('waha_sessions_phone_key').on(table.phone)],
);
