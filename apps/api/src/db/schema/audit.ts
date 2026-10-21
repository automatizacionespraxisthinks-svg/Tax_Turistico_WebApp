import { bigserial, index, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Bitácora de solo inserción con hash encadenado (§6, RNF Auditoría).
 *
 * Cada fila incluye el hash de la anterior, así que modificar o borrar una
 * rompe la cadena y se nota. El usuario de base de datos de la aplicación no
 * tiene permisos de UPDATE ni DELETE sobre esta tabla; eso se concede en la
 * migración, no en el código.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    /** Secuencia: el orden de la cadena debe ser total y sin huecos. */
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    actorId: uuid('actor_id'),
    actorName: text('actor_name').notNull(),
    role: text('role').notNull(),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    ip: inet('ip'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    /** Hash de la fila anterior; la primera lleva el hash de génesis. */
    prevHash: text('prev_hash').notNull(),
    /** SHA-256 de esta fila más `prevHash`. */
    hash: text('hash').notNull(),
  },
  (table) => [
    index('audit_log_entity_idx').on(table.entity, table.entityId),
    index('audit_log_at_idx').on(table.at),
  ],
);
