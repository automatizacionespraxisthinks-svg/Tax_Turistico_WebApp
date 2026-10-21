import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { loadEnv } from '../../config/env';
import { AuditService } from '../audit/audit.service';

export const MAINTENANCE_QUEUE = 'maintenance';
export const PURGE_POSITIONS_JOB = 'purge-positions';

export interface PurgeResult {
  removed: number;
  batches: number;
  ms: number;
  /** Falso si quedó trabajo para la próxima noche. */
  complete: boolean;
  reason?: 'tope' | 'bloqueo' | 'error';
}

/**
 * Retención de datos (§9.3).
 *
 * De momento solo el histórico de GPS, que es el único que crece rápido y el
 * más sensible: `driver_positions` es el recorrido minuto a minuto de 62
 * personas, y pasados unos meses no sirve para operar pero sigue siendo un
 * riesgo si alguien se lleva un volcado de la base.
 *
 * La regla que gobierna el diseño es que esto **no se puede notar**. Corre de
 * madrugada, pero una madrugada con una carrera en curso es una carrera en
 * curso, así que el borrado va por lotes pequeños con pausas en medio en vez
 * de una sentencia enorme: transacciones cortas, WAL repartido, bloqueos que
 * duran milisegundos y hueco para que autovacuum vaya detrás recuperando el
 * espacio.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);
  private readonly env = loadEnv();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async purgePositions(): Promise<PurgeResult> {
    const { POSITION_RETENTION_DAYS, POSITION_PURGE_BATCH, POSITION_PURGE_PAUSE_MS } = this.env;
    const max = this.env.POSITION_PURGE_MAX_ROWS;

    const started = Date.now();
    let removed = 0;
    let batches = 0;
    let complete = true;
    let reason: PurgeResult['reason'];

    for (;;) {
      if (removed >= max) {
        // Se para en seco y lo que quede se lleva mañana. Es preferible a una
        // purga que se alargue hasta la hora punta de la mañana.
        complete = false;
        reason = 'tope';
        break;
      }

      // El último lote se recorta para no pasarse del tope.
      const size = Math.min(POSITION_PURGE_BATCH, max - removed);

      let lote: number;
      try {
        const result = await this.db.execute<{ removed: string }>(
          sql`select purge_driver_positions(${POSITION_RETENTION_DAYS}, ${size}) as removed`,
        );
        lote = Number(result.rows[0]?.removed ?? 0);
      } catch (error) {
        /*
         * Lo normal aquí es `lock_not_available`: la función se rinde a los
         * dos segundos en vez de encolarse detrás de otra consulta. No se
         * reintenta en bucle, que sería insistir justo cuando la base está
         * ocupada; se deja para la próxima ejecución. Las filas no se van a
         * ninguna parte.
         */
        complete = false;
        reason = isLockTimeout(error) ? 'bloqueo' : 'error';
        this.logger.warn(
          { err: error instanceof Error ? error.message : error, removed, batches },
          'Purga interrumpida: continúa en la próxima ejecución',
        );
        break;
      }

      if (lote === 0) break;

      removed += lote;
      batches++;

      if (POSITION_PURGE_PAUSE_MS > 0) await pause(POSITION_PURGE_PAUSE_MS);
    }

    const ms = Date.now() - started;

    if (removed > 0) {
      /*
       * Queda constancia en la bitácora: borrar datos personales por
       * retención es una operación sobre datos personales, y tiene que poder
       * demostrarse que se hizo, cuándo y con qué plazo. La bitácora es de
       * solo inserción con hash encadenado, así que esta fila tampoco se
       * puede retocar después.
       */
      await this.audit.record({
        actorName: 'Sistema',
        role: 'system',
        action: 'Borrado por retención',
        entity: 'driver_positions',
        after: {
          filas: removed,
          lotes: batches,
          plazoDias: POSITION_RETENTION_DAYS,
          duracionMs: ms,
          completo: complete,
          motivo: reason ?? null,
        },
      });
    }

    this.logger.log(
      { filas: removed, lotes: batches, ms, completo: complete, motivo: reason },
      removed > 0 ? 'Histórico de GPS purgado' : 'Nada que purgar',
    );

    return { removed, batches, ms, complete, reason };
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** SQLSTATE 55P03: no se pudo tomar el bloqueo dentro del `lock_timeout`. */
function isLockTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && 'code' in current && current.code === '55P03') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
