import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { OUTBOX_QUEUE, SWEEP_JOB, OutboxService } from './outbox.service';
import { OutboxProcessor } from './outbox.processor';
import { OutboxController } from './outbox.controller';
import { WahaController } from './waha.controller';
import { MONITOR_QUEUE, REVISAR_LINEAS_JOB, WahaMonitorService } from './waha-monitor.service';
import { MonitorProcessor } from './monitor.processor';

/**
 * Integraciones.
 *
 * Es dueño del outbox y de la entrega de webhooks a n8n, y de los adaptadores
 * de Chatwoot y WAHA (capa anticorrupción). La flecha de eventos hacia fuera
 * sale de aquí, nunca directamente del módulo de Carreras (§4).
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: OUTBOX_QUEUE }),
    BullModule.registerQueue({ name: MONITOR_QUEUE }),
  ],
  controllers: [OutboxController, WahaController],
  providers: [OutboxService, OutboxProcessor, WahaMonitorService, MonitorProcessor],
  exports: [OutboxService, WahaMonitorService],
})
export class IntegrationsModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(IntegrationsModule.name);

  constructor(
    @InjectQueue(OUTBOX_QUEUE) private readonly queue: Queue,
    @InjectQueue(MONITOR_QUEUE) private readonly monitorQueue: Queue,
    private readonly monitor: WahaMonitorService,
  ) {}

  /**
   * Barrido periódico del outbox.
   *
   * Los avisos puntuales viven en Redis; esto garantiza que un evento
   * confirmado en Postgres acabe entregándose aunque el proceso se reiniciara
   * justo después del commit.
   */
  async onApplicationBootstrap(): Promise<void> {
    // `upsertJobScheduler` es idempotente: aunque el proceso reinicie varias
    // veces, queda un único barrido programado con ese identificador.
    await this.queue.upsertJobScheduler(
      'outbox-sweep',
      { every: 30_000 },
      { name: SWEEP_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: true } },
    );

    /*
     * La revisión de las líneas, cada minuto. Sin WAHA_URL se borra la
     * programación en vez de dejarla girando en vacío: la programación vive
     * en Redis y sobreviviría al cambio de configuración.
     */
    if (!this.monitor.configurado) {
      await this.monitorQueue.removeJobScheduler(REVISAR_LINEAS_JOB);
      this.logger.warn('Sin WAHA_URL: el monitor de líneas de WhatsApp está apagado');
      return;
    }
    await this.monitorQueue.upsertJobScheduler(
      REVISAR_LINEAS_JOB,
      { every: 60_000 },
      { name: REVISAR_LINEAS_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
    this.logger.log('Monitor de líneas de WhatsApp: revisión cada minuto');

    // Y una ya: la programación conserva su ritmo entre reinicios, así que
    // tras un despliegue podía pasar un minuto sin saber nada de las líneas.
    void this.monitor.revisar().catch((error: unknown) => {
      this.logger.error({ err: error }, 'La primera revisión de las líneas falló');
    });
  }
}
