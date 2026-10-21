import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { OUTBOX_QUEUE, SWEEP_JOB, OutboxService } from './outbox.service';
import { OutboxProcessor } from './outbox.processor';
import { OutboxController } from './outbox.controller';
import { WahaController } from './waha.controller';

/**
 * Integraciones.
 *
 * Es dueño del outbox y de la entrega de webhooks a n8n, y de los adaptadores
 * de Chatwoot y WAHA (capa anticorrupción). La flecha de eventos hacia fuera
 * sale de aquí, nunca directamente del módulo de Carreras (§4).
 */
@Module({
  imports: [BullModule.registerQueue({ name: OUTBOX_QUEUE })],
  controllers: [OutboxController, WahaController],
  providers: [OutboxService, OutboxProcessor],
  exports: [OutboxService],
})
export class IntegrationsModule implements OnApplicationBootstrap {
  constructor(@InjectQueue(OUTBOX_QUEUE) private readonly queue: Queue) {}

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
  }
}
