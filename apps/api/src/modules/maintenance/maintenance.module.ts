import { Module, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { loadEnv } from '../../config/env';
import { MAINTENANCE_QUEUE, PURGE_POSITIONS_JOB, RetentionService } from './retention.service';
import { MaintenanceProcessor } from './maintenance.processor';
import { MaintenanceController } from './maintenance.controller';

/**
 * Mantenimiento: lo que hay que hacer periódicamente y nadie pide.
 *
 * Hoy solo la retención del histórico de GPS (§9.3). Tiene cola propia en vez
 * de compartir la del despacho porque son trabajos de naturaleza opuesta: el
 * despacho son segundos y no puede esperar detrás de una purga de minutos.
 */
@Module({
  imports: [BullModule.registerQueue({ name: MAINTENANCE_QUEUE })],
  controllers: [MaintenanceController],
  providers: [RetentionService, MaintenanceProcessor],
  exports: [RetentionService],
})
export class MaintenanceModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceModule.name);

  constructor(@InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    const env = loadEnv();

    /*
     * `upsertJobScheduler` es idempotente: reiniciar el proceso no acumula
     * programaciones. La zona horaria es explícita porque el contenedor corre
     * en UTC y «las cuatro de la mañana» tiene que ser las cuatro en Paipa,
     * no las once de la noche.
     */
    await this.queue.upsertJobScheduler(
      'purga-posiciones',
      { pattern: env.POSITION_PURGE_CRON, tz: env.PURGE_TIMEZONE },
      {
        name: PURGE_POSITIONS_JOB,
        data: {},
        opts: { removeOnComplete: 30, removeOnFail: 30 },
      },
    );

    this.logger.log(
      { cron: env.POSITION_PURGE_CRON, tz: env.PURGE_TIMEZONE, dias: env.POSITION_RETENTION_DAYS },
      'Purga del histórico de GPS programada',
    );
  }
}
