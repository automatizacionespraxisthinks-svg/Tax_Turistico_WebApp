import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { zoneKind } from './enums';
import type { FareSurcharge } from '@tax/shared';

/**
 * Tabla de precios versionada.
 *
 * Cada fila referencia el acto administrativo de la alcaldía que la autoriza
 * y tiene vigencia propia; una carrera guarda la versión con la que se
 * calculó, de modo que un cambio de tarifa no reescribe el histórico (§9.2).
 */
export const fareRules = pgTable(
  'fare_rules',
  {
    id: uuid('id').primaryKey(),
    version: text('version').notNull(),
    originKind: zoneKind('origin_kind').notNull(),
    destinationKind: zoneKind('destination_kind').notNull(),
    baseFare: integer('base_fare').notNull(),
    perKm: integer('per_km').notNull(),
    minimumFare: integer('minimum_fare').notNull(),
    surcharges: jsonb('surcharges').$type<FareSurcharge[]>().notNull().default([]),
    /** Acto administrativo vigente que fija estas tarifas. */
    legalReference: text('legal_reference').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('fare_rules_version_pair_key').on(
      table.version,
      table.originKind,
      table.destinationKind,
    ),
    index('fare_rules_effective_idx').on(table.effectiveFrom, table.effectiveTo),
  ],
);
