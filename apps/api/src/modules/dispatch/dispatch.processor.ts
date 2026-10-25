import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DISPATCH_QUEUE, DispatchService, WAVE_TIMEOUT_JOB, type WaveTimeoutJob } from './dispatch.service';

/**
 * Temporizadores de oleada.
 *
 * Están en BullMQ y no en memoria precisamente para que sobrevivan a un
 * reinicio del contenedor: si el proceso cae con una oleada en vuelo, al
 * levantar se vence igual y la carrera sigue su camino (§5, process manager
 * con temporizadores persistentes).
 */
@Processor(DISPATCH_QUEUE, { concurrency: 8 })
export class DispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(DispatchProcessor.name);

  constructor(private readonly dispatch: DispatchService) {
    super();
  }

  async process(job: Job<WaveTimeoutJob>): Promise<void> {
    if (job.name !== WAVE_TIMEOUT_JOB) return;

    const { rideId, wave, intento } = job.data;
    try {
      await this.dispatch.expireWave(rideId, wave, intento);
    } catch (error) {
      // Se registra y se deja caer: reintentar un vencimiento ya procesado
      // podría saltarse una oleada.
      this.logger.error({ err: error, rideId, wave }, 'Fallo al vencer la oleada');
    }
  }
}
