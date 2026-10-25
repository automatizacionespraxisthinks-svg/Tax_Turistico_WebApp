import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { MONITOR_QUEUE, REVISAR_LINEAS_JOB, WahaMonitorService } from './waha-monitor.service';

/**
 * Revisiones periódicas.
 *
 * Cola propia y no la del outbox: si WAHA tarda en contestar, la entrega de
 * eventos a n8n no puede quedarse esperando detrás. Concurrencia 1 porque
 * dos revisiones solapadas alertarían dos veces de la misma caída.
 */
@Processor(MONITOR_QUEUE, { concurrency: 1 })
export class MonitorProcessor extends WorkerHost {
  private readonly logger = new Logger(MonitorProcessor.name);

  constructor(private readonly monitor: WahaMonitorService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name === REVISAR_LINEAS_JOB) {
      // Si quitaron WAHA_URL con la revisión ya programada, no hay nada que mirar.
      if (!this.monitor.configurado) return undefined;
      return this.monitor.revisar();
    }

    this.logger.warn({ name: job.name }, 'Trabajo de monitor desconocido');
    return undefined;
  }
}
