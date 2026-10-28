import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { desc, eq, gte, lt, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DB, type Database } from '../../db/db.module';
import {
  reportExports,
  type ExportFormat,
  type ExportKind,
  type ExportParams,
} from '../../db/schema';
import { AppError } from '../../common/problem';
import { leerPeriodo, textoDelPeriodo, ZONA_HORARIA } from './exports.data';
import { generarExcel } from './exports.xlsx';
import { generarPdf } from './exports.pdf';
import { ReportsService, filtrosDeParams } from './reports.service';

export const EXPORTS_QUEUE = 'exportaciones';
export const GENERAR_JOB = 'generar';

/** Cuánto se guarda un archivo generado. Son copias: los datos siguen en `rides`. */
const DIAS_DE_RETENCION = 7;

export const CONTENT_TYPE: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

export interface Solicitud {
  kind: ExportKind;
  format: ExportFormat;
  params: ExportParams;
}

/** La fecha de hoy en Paipa, para el nombre del archivo: `2026-10-25`. */
const hoy = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

/** Sin tildes ni espacios: hay programas que se lían con ellos al guardar. */
const paraArchivo = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Exportaciones de Reportes (§4.1).
 *
 * Pedir una exportación crea una fila y un trabajo en la cola; el trabajo
 * lee el periodo, genera el archivo y lo guarda en la misma fila. El panel
 * pregunta por la fila hasta que está lista y entonces la descarga. Así un
 * informe de un mes no ocupa la petición HTTP ni la deja a merced de un
 * proxy con prisa.
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(EXPORTS_QUEUE) private readonly queue: Queue<{ exportId: string }>,
    private readonly reports: ReportsService,
  ) {}

  async solicitar(solicitud: Solicitud, pedidoPor: { id: string; name: string }) {
    if (solicitud.format === 'pdf' && solicitud.kind !== 'resumen') {
      throw new AppError('VALIDATION_FAILED', 'El PDF es del resumen del periodo; las carreras sueltas van en Excel');
    }

    const periodo = textoDelPeriodo(solicitud.params);
    const filtro = solicitud.params.filterLabel;
    const titulo =
      solicitud.kind === 'resumen'
        ? `Resumen de operación · ${periodo}${filtro ? ` · ${filtro}` : ''}`
        : `Carreras${filtro ? ` ${filtro.toLowerCase()}` : ''} · ${periodo}`;
    const fileName = `${paraArchivo(titulo)}-${hoy()}.${solicitud.format}`;

    const id = uuidv7();
    await this.db.insert(reportExports).values({
      id,
      kind: solicitud.kind,
      format: solicitud.format,
      params: solicitud.params,
      title: titulo,
      fileName,
      requestedById: pedidoPor.id,
      requestedByName: pedidoPor.name,
    });

    // Un intento: si falla, la fila dice por qué y se pide otra. Reintentar
    // solo repetiría el mismo error con el mismo periodo.
    await this.queue.add(GENERAR_JOB, { exportId: id }, { jobId: id, attempts: 1, removeOnComplete: true, removeOnFail: 100 });
    return this.uno(id);
  }

  /** Las de los últimos días, sin el contenido: la lista no descarga nada. */
  async lista() {
    return this.db
      .select(this.columnas())
      .from(reportExports)
      .where(gte(reportExports.createdAt, new Date(Date.now() - DIAS_DE_RETENCION * 86_400_000)))
      .orderBy(desc(reportExports.createdAt))
      .limit(50);
  }

  async uno(id: string) {
    const [fila] = await this.db.select(this.columnas()).from(reportExports).where(eq(reportExports.id, id)).limit(1);
    if (!fila) throw new AppError('NOT_FOUND', 'Esa exportación no existe o ya caducó');
    return fila;
  }

  async archivo(id: string) {
    const [fila] = await this.db
      .select({
        status: reportExports.status,
        format: reportExports.format,
        fileName: reportExports.fileName,
        content: reportExports.content,
      })
      .from(reportExports)
      .where(eq(reportExports.id, id))
      .limit(1);
    if (!fila) throw new AppError('NOT_FOUND', 'Esa exportación no existe o ya caducó');
    if (fila.status !== 'ready' || !fila.content) {
      throw new AppError('NOT_FOUND', 'El archivo todavía no está listo');
    }
    return { content: fila.content, fileName: fila.fileName, contentType: CONTENT_TYPE[fila.format] };
  }

  /** Lo que hace el trabajo de la cola. */
  async generar(id: string): Promise<void> {
    const [fila] = await this.db.select().from(reportExports).where(eq(reportExports.id, id)).limit(1);
    if (!fila || fila.status === 'ready') return;

    await this.db.update(reportExports).set({ status: 'running' }).where(eq(reportExports.id, id));
    const inicio = Date.now();

    try {
      // El resumen pedido desde Reportes sale del mismo tablero que se veía en
      // pantalla: el resumen en palabras y la tabla de conductores con sus
      // ofertas y turnos, no solo las carreras.
      const desdeElTablero = fila.kind === 'resumen' && fila.params.desde && fila.params.hasta;
      const armado = desdeElTablero ? await this.reports.tableroConPeriodo(filtrosDeParams(fila.params)) : null;
      const periodo = armado?.periodo ?? (await leerPeriodo(this.db, fila.params));
      const opciones = {
        titulo: fila.title,
        pedidoPor: fila.requestedByName,
        tablero: armado?.tablero,
        filtros: fila.params.filterLabel,
      };
      const contenido =
        fila.format === 'pdf'
          ? await generarPdf(periodo, opciones)
          : await generarExcel(periodo, { ...opciones, tipo: fila.kind });

      await this.db
        .update(reportExports)
        .set({ status: 'ready', content: contenido, sizeBytes: contenido.length, finishedAt: new Date(), error: null })
        .where(eq(reportExports.id, id));

      this.logger.log(
        { id, formato: fila.format, carreras: periodo.filas.length, kb: Math.round(contenido.length / 1024), ms: Date.now() - inicio },
        'Exportación generada',
      );
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      await this.db
        .update(reportExports)
        .set({ status: 'failed', error: mensaje.slice(0, 500), finishedAt: new Date() })
        .where(eq(reportExports.id, id));
      this.logger.error({ id, err: error }, 'La exportación falló');
    } finally {
      await this.limpiar();
    }
  }

  /** Borra las que pasaron su plazo; se aprovecha cada exportación nueva. */
  private async limpiar(): Promise<void> {
    await this.db
      .delete(reportExports)
      .where(lt(reportExports.createdAt, sql`now() - make_interval(days => ${DIAS_DE_RETENCION})`));
  }

  private columnas() {
    return {
      id: reportExports.id,
      kind: reportExports.kind,
      format: reportExports.format,
      title: reportExports.title,
      fileName: reportExports.fileName,
      status: reportExports.status,
      error: reportExports.error,
      sizeBytes: reportExports.sizeBytes,
      requestedByName: reportExports.requestedByName,
      createdAt: reportExports.createdAt,
      finishedAt: reportExports.finishedAt,
    };
  }
}
