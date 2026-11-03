import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { zoneKind } from './enums';
import type { WaveConfig } from '@tax/shared';

/** Polígono GeoJSON, sin PostGIS: la geometría se resuelve en la app con Turf (ADR-04). */
export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: [number, number][][];
}

export const zones = pgTable(
  'zones',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    /** Solo urbano o rural: el tipo decide la regla tarifaria. */
    kind: zoneKind('kind').notNull(),
    polygon: jsonb('polygon').$type<GeoJsonPolygon>().notNull(),
    /** Factor de tortuosidad para el ETA; se recalibra cada semana con los
        tiempos reales de recogida (ADR-08). */
    tortuosity: doublePrecision('tortuosity').notNull().default(1.4),
    /** Radio, candidatos y vencimiento de cada oleada, editables desde el
        panel (§5.2). */
    waves: jsonb('waves').$type<WaveConfig[]>().notNull(),
    /**
     * El punto de partida de las carreras que no se pudieron ubicar: su
     * centro es donde arrancan las oleadas cuando no hay dirección ni
     * ubicación que sirva. Una sola zona, elegida en el panel. Antes se
     * tomaba «la primera zona urbana», en el orden en que la base las
     * devolviera, y en producción salía Lago Sochagota en vez del Centro.
     */
    esReferencia: boolean('es_referencia').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('zones_name_key').on(table.name),
    // A lo sumo una: el índice lo garantiza aunque dos personas la cambien a la vez.
    uniqueIndex('zones_una_referencia').on(table.esReferencia).where(sql`${table.esReferencia}`),
  ],
);

/**
 * Catálogo de lugares: la segunda capa de geocodificación, cuando el cliente
 * no manda ubicación de WhatsApp (§7 del contexto, driver «ubicación rural
 * imprecisa»).
 */
export const places = pgTable(
  'places',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    kind: zoneKind('kind').notNull(),
    zoneId: uuid('zone_id').references(() => zones.id),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    /** Cómo lo nombran los clientes: «el parque», «la terminal». */
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
    /** Veces que el catálogo resolvió una dirección con este lugar; ordena
        los candidatos que ve el agente. */
    uses: integer('uses').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('places_zone_idx').on(table.zoneId),
    index('places_name_idx').on(table.name),
  ],
);
