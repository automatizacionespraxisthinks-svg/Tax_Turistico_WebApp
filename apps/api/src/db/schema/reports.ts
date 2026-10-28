import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './bytea';

export type ExportKind = 'resumen' | 'carreras';
export type ExportFormat = 'xlsx' | 'pdf';
export type ExportStatus = 'pending' | 'running' | 'ready' | 'failed';

export interface ExportParams {
  /**
   * El periodo, hacia atrás desde que se pidió: 1 son las últimas 24 horas.
   * Lo usan las exportaciones de *Carreras*; las de *Reportes* llevan
   * `desde` y `hasta`.
   */
  days?: number;
  /** Días de Paipa, `AAAA-MM-DD`, con los dos extremos incluidos. */
  desde?: string;
  hasta?: string;
  /** Solo en `carreras`: los filtros de la vista desde la que se pidió. */
  statuses?: string[];
  zoneId?: string;
  query?: string;
  /** Los filtros del tablero de Reportes. */
  zoneIds?: string[];
  zoneKind?: 'urbano' | 'rural';
  driverId?: string;
  lines?: string[];
  excludeTests?: boolean;
  /** Cómo se llamaba el filtro en el panel, para el título del archivo. */
  filterLabel?: string;
}

/**
 * Exportaciones de Reportes (§4.1).
 *
 * Se generan en segundo plano y el archivo se guarda aquí mismo, en la base,
 * no en un volumen: así no hay que montar ni respaldar nada aparte en
 * Dokploy, y una exportación son decenas o cientos de KB. Se borran a los
 * siete días; son copias de datos que siguen en `rides`, no un archivo.
 */
export const reportExports = pgTable(
  'report_exports',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').$type<ExportKind>().notNull(),
    format: text('format').$type<ExportFormat>().notNull(),
    params: jsonb('params').$type<ExportParams>().notNull(),
    /** Lo que se lee en la lista: «Resumen · últimos 7 días». */
    title: text('title').notNull(),
    /** Con el que se descarga: sin tildes ni espacios. */
    fileName: text('file_name').notNull(),
    status: text('status').$type<ExportStatus>().notNull().default('pending'),
    error: text('error'),
    sizeBytes: integer('size_bytes'),
    content: bytea('content'),
    requestedById: uuid('requested_by_id'),
    requestedByName: text('requested_by_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('report_exports_created_idx').on(table.createdAt)],
);
