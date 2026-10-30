import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { loadEnv } from '../../config/env';
import { RequierePermiso, SessionGuard } from '../identity/guards';
import { MAINTENANCE_QUEUE, PURGE_POSITIONS_JOB } from './retention.service';

/**
 * Mantenimiento desde la oficina: solo administradores (§8.1).
 *
 * Existe por dos razones prácticas: poder comprobar que la retención se está
 * aplicando sin entrar a la base, y poder lanzarla a mano el día que haga
 * falta —una auditoría, un cambio de plazo— sin esperar a la madrugada.
 */
@Controller('v1/admin/maintenance')
@UseGuards(SessionGuard)
@RequierePermiso('sistema.tecnico')
export class MaintenanceController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
  ) {}

  /** Qué plazo rige y cuánto queda por borrar ahora mismo. */
  @Get('retention')
  async retention() {
    const env = loadEnv();

    const result = await this.db.execute<{ caducadas: string; total: string; mas_antigua: Date | null }>(
      sql`select
            count(*) filter (
              where recorded_at < now() - make_interval(days => ${env.POSITION_RETENTION_DAYS})
            )::text as caducadas,
            count(*)::text as total,
            min(recorded_at) as mas_antigua
          from driver_positions`,
    );

    const row = result.rows[0];

    return {
      posiciones: {
        plazoDias: env.POSITION_RETENTION_DAYS,
        total: Number(row?.total ?? 0),
        caducadas: Number(row?.caducadas ?? 0),
        masAntigua: row?.mas_antigua ?? null,
      },
      programada: { cron: env.POSITION_PURGE_CRON, zona: env.PURGE_TIMEZONE },
    };
  }

  /**
   * Lanza la purga ahora. Devuelve 202: el trabajo va por la cola, con sus
   * lotes y sus pausas, igual que el de la madrugada.
   */
  @Post('purge-positions')
  @HttpCode(202)
  async purgeNow() {
    const job = await this.queue.add(
      PURGE_POSITIONS_JOB,
      {},
      { removeOnComplete: 30, removeOnFail: 30 },
    );
    return { encolado: true, jobId: job.id };
  }
}
