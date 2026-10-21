import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, lte, or, isNull, desc } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { OutboxEventType } from '@tax/shared';
import { nextBackoffSeconds } from '@tax/shared';
import { DB, type Database, type Tx } from '../../db/db.module';
import { outboxEvents } from '../../db/schema';
import { loadEnv } from '../../config/env';

export const OUTBOX_QUEUE = 'outbox';
/** Nombre del trabajo de barrido periódico; lo atiende el mismo procesador. */
export const SWEEP_JOB = 'sweep';

export interface OutboxJobData {
  eventId: string;
}

export interface EnqueueInput {
  type: OutboxEventType;
  rideId?: string;
  rideCode?: string;
  rideVersion?: number;
  payload: Record<string, unknown>;
}

/**
 * Transactional Outbox (ADR-06).
 *
 * `enqueue` SIEMPRE recibe la transacción que está cambiando el dominio: el
 * evento y el cambio se confirman o se descartan juntos. Esa es toda la
 * garantía de la sección 6 del contexto —el agente nunca promete algo que no
 * ocurrió, y nada de lo que ocurrió se queda sin avisar—, y se pierde entera
 * si alguien llama a esto fuera de una transacción.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private readonly env = loadEnv();

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(OUTBOX_QUEUE) private readonly queue: Queue<OutboxJobData>,
  ) {}

  /** Inserta el evento dentro de la transacción del llamador. */
  async enqueue(tx: Tx, input: EnqueueInput): Promise<string> {
    const eventId = uuidv7();

    await tx.insert(outboxEvents).values({
      eventId,
      type: input.type,
      rideId: input.rideId,
      rideCode: input.rideCode,
      rideVersion: input.rideVersion,
      payload: input.payload,
      status: 'pending',
      nextAttemptAt: new Date(),
    });

    return eventId;
  }

  /**
   * Despierta al relay después de confirmar la transacción.
   *
   * Se llama FUERA del `transaction()`: si se encolara dentro, el trabajador
   * podría leer la fila antes del commit y no encontrarla. Y si este aviso se
   * pierde (proceso caído entre el commit y aquí), el barrido periódico lo
   * recoge igual: el aviso es una optimización, no la garantía.
   */
  async notify(eventIds: string[]): Promise<void> {
    await Promise.all(
      eventIds.map((eventId) =>
        this.queue.add('deliver', { eventId }, { jobId: eventId, removeOnComplete: true }),
      ),
    );
  }

  /* ------------------------------------------------------- estado del relay */

  async markDelivered(eventId: string): Promise<void> {
    await this.db
      .update(outboxEvents)
      .set({ status: 'delivered', deliveredAt: new Date(), lastError: null })
      .where(eq(outboxEvents.eventId, eventId));
  }

  /**
   * Programa el siguiente intento o entierra el evento.
   * El backoff (1 s → 15 min) está en `@tax/shared`, para que el panel pueda
   * mostrar el mismo cálculo sin duplicarlo.
   */
  async markFailed(eventId: string, attempts: number, error: string): Promise<'retry' | 'dead'> {
    if (attempts >= this.env.OUTBOX_MAX_ATTEMPTS) {
      await this.db
        .update(outboxEvents)
        .set({ status: 'dead', attempts, lastError: error, nextAttemptAt: null })
        .where(eq(outboxEvents.eventId, eventId));

      this.logger.error(
        { eventId, attempts },
        'Evento a cola muerta: el agente no habrá confirmado esta carrera',
      );
      return 'dead';
    }

    const delaySeconds = nextBackoffSeconds(attempts + 1);
    const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000);

    await this.db
      .update(outboxEvents)
      .set({ status: 'pending', attempts, lastError: error, nextAttemptAt })
      .where(eq(outboxEvents.eventId, eventId));

    await this.queue.add(
      'deliver',
      { eventId },
      { jobId: `${eventId}:${attempts}`, delay: delaySeconds * 1000, removeOnComplete: true },
    );

    return 'retry';
  }

  /**
   * Eventos pendientes cuyo turno ya pasó.
   *
   * Es la red de seguridad frente a reinicios: los avisos de `notify` viven
   * en Redis, pero la verdad está en Postgres. Un barrido periódico vuelve a
   * encolar lo que se quedó atrás.
   */
  async claimDue(limit = 50): Promise<string[]> {
    const rows = await this.db
      .select({ eventId: outboxEvents.eventId })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.status, 'pending'),
          or(isNull(outboxEvents.nextAttemptAt), lte(outboxEvents.nextAttemptAt, new Date())),
        ),
      )
      .orderBy(outboxEvents.createdAt)
      .limit(limit);

    return rows.map((row) => row.eventId);
  }

  /** Reintento manual desde el panel para un evento de la cola muerta. */
  async revive(eventId: string): Promise<void> {
    await this.db
      .update(outboxEvents)
      .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null })
      .where(eq(outboxEvents.eventId, eventId));

    await this.queue.add('deliver', { eventId }, { removeOnComplete: true });
  }

  async list(status?: 'pending' | 'delivering' | 'delivered' | 'dead', limit = 100) {
    const query = this.db
      .select()
      .from(outboxEvents)
      .orderBy(desc(outboxEvents.createdAt))
      .limit(limit);

    return status ? query.where(eq(outboxEvents.status, status)) : query;
  }
}
