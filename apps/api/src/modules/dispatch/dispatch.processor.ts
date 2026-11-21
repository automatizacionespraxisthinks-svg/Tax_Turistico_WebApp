import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import {
  AUTO_RELAUNCH_JOB,
  AVISO_REENVIO_JOB,
  DISPATCH_QUEUE,
  DispatchService,
  EXPIRE_UNASSIGNED_JOB,
  WAVE_TIMEOUT_JOB,
  type AutoRelaunchJob,
  type AvisoReenvioJob,
  type WaveTimeoutJob,
} from './dispatch.service';

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

  async process(job: Job<WaveTimeoutJob | AutoRelaunchJob | AvisoReenvioJob>): Promise<void> {
    if (job.name === AVISO_REENVIO_JOB) {
      const { rideId, wave, intento } = job.data as AvisoReenvioJob;
      try {
        await this.dispatch.reenviarAvisos(rideId, wave, intento);
      } catch (error) {
        this.logger.warn({ err: error, rideId }, 'Falló el reenvío de avisos');
      }
      return;
    }

    if (job.name === AUTO_RELAUNCH_JOB) {
      const { rideId, intento } = job.data as AutoRelaunchJob;
      try {
        await this.dispatch.autoRelaunch(rideId, intento);
      } catch (error) {
        // Si falla, la carrera sigue sin asignar y el barrido la vuelve a
        // relanzar (o la cierra, con BUSCAR_HASTA_CANCELAR apagado).
        this.logger.error({ err: error, rideId }, 'Fallo el relanzamiento automático');
      }
      return;
    }

    if (job.name === EXPIRE_UNASSIGNED_JOB) {
      await this.dispatch.expireStaleUnassigned();
      return;
    }

    if (job.name !== WAVE_TIMEOUT_JOB) return;

    const { rideId, wave, intento } = job.data as WaveTimeoutJob;
    try {
      await this.dispatch.expireWave(rideId, wave, intento);
    } catch (error) {
      // Se registra y se deja caer: reintentar un vencimiento ya procesado
      // podría saltarse una oleada.
      this.logger.error({ err: error, rideId, wave }, 'Fallo al vencer la oleada');
    }
  }
}
