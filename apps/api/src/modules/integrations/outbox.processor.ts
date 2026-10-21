import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { outboxEvents } from '../../db/schema';
import { loadEnv } from '../../config/env';
import { signWebhook } from '../../common/crypto';
import { OUTBOX_QUEUE, SWEEP_JOB, OutboxService, type OutboxJobData } from './outbox.service';

/**
 * Relay del outbox hacia n8n (§7.1).
 *
 * Entrega al menos una vez, con cabeceras firmadas. El receptor deduplica por
 * `X-Tax-Event-Id` y descarta eventos con `ride_version` menor a la procesada,
 * así que repetir una entrega es inofensivo y perderla no lo sería.
 *
 * Concurrencia 4: el presupuesto de CPU del contenedor es medio vCPU y estas
 * llamadas son de espera, no de cálculo.
 */
@Processor(OUTBOX_QUEUE, { concurrency: 4 })
export class OutboxProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboxProcessor.name);
  private readonly env = loadEnv();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly outbox: OutboxService,
  ) {
    super();
  }

  /**
   * Un solo trabajador atiende la cola, así que ramifica por nombre de
   * trabajo: dos `@Processor` sobre la misma cola competirían por los mismos
   * mensajes y cada uno recibiría la mitad de los del otro tipo.
   */
  async process(job: Job<OutboxJobData>): Promise<void> {
    if (job.name === SWEEP_JOB) {
      await this.sweep();
      return;
    }
    await this.deliver(job.data.eventId);
  }

  /**
   * Red de seguridad frente a reinicios: vuelve a encolar lo que quedó
   * pendiente en Postgres y cuyo turno ya pasó.
   */
  private async sweep(): Promise<void> {
    const due = await this.outbox.claimDue(50);
    if (due.length === 0) return;
    this.logger.debug({ count: due.length }, 'Reencolando eventos pendientes');
    await this.outbox.notify(due);
  }

  private async deliver(eventId: string): Promise<void> {
    const [event] = await this.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventId, eventId))
      .limit(1);

    if (!event) return;
    if (event.status === 'delivered' || event.status === 'dead') return;

    if (!this.env.N8N_WEBHOOK_URL || !this.env.N8N_WEBHOOK_SECRET) {
      // Sin destino configurado no se entierra el evento: queda pendiente
      // para cuando exista, en vez de perderse en silencio.
      this.logger.warn({ eventId }, 'Sin N8N_WEBHOOK_URL: el evento queda en cola');
      return;
    }

    await this.db
      .update(outboxEvents)
      .set({ status: 'delivering' })
      .where(eq(outboxEvents.eventId, eventId));

    const body = JSON.stringify({
      eventId: event.eventId,
      type: event.type,
      rideId: event.rideId,
      rideCode: event.rideCode,
      rideVersion: event.rideVersion,
      occurredAt: event.createdAt.toISOString(),
      data: event.payload,
    });

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const attempts = event.attempts + 1;

    try {
      // Tiempo límite: un n8n colgado no puede bloquear a un trabajador.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(this.env.N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tax-event-id': event.eventId,
          'x-tax-timestamp': timestamp,
          'x-tax-signature': signWebhook(this.env.N8N_WEBHOOK_SECRET, timestamp, body),
        },
        body,
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`);
      }

      await this.outbox.markDelivered(eventId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = await this.outbox.markFailed(eventId, attempts, message);

      // No se relanza: el reintento ya está programado en la base y en la
      // cola. Dejar que BullMQ reintentara además duplicaría los envíos.
      this.logger.warn({ eventId, attempts, outcome, err: message }, 'Entrega fallida');
    }
  }
}
