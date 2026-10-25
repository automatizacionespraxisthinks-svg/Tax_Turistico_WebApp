import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { EXPORTS_QUEUE, ExportsService } from './exports.service';

/**
 * Genera las exportaciones, de una en una.
 *
 * Cola propia: un informe de un mes tarda segundos y no puede quedar delante
 * de una oleada de despacho ni de la entrega de un evento a n8n. Concurrencia
 * 1 porque dos informes grandes a la vez son justo el pico de memoria que el
 * contenedor no tiene.
 */
@Processor(EXPORTS_QUEUE, { concurrency: 1 })
export class ExportsProcessor extends WorkerHost {
  constructor(private readonly exports: ExportsService) {
    super();
  }

  async process(job: Job<{ exportId: string }>): Promise<void> {
    await this.exports.generar(job.data.exportId);
  }
}
