import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { MAINTENANCE_QUEUE, PURGE_POSITIONS_JOB, RetentionService } from './retention.service';

/**
 * Trabajos de mantenimiento.
 *
 * Concurrencia 1 a propósito: son tareas pesadas para la base y solaparlas
 * sería exactamente el pico que se quiere evitar. Si una noche la purga se
 * alarga, la siguiente espera en vez de sumarse.
 */
@Processor(MAINTENANCE_QUEUE, { concurrency: 1 })
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(private readonly retention: RetentionService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name === PURGE_POSITIONS_JOB) {
      return this.retention.purgePositions();
    }

    this.logger.warn({ name: job.name }, 'Trabajo de mantenimiento desconocido');
    return undefined;
  }
}
