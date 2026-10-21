import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Observable, from, of, switchMap, tap } from 'rxjs';
import type { FastifyRequest } from 'fastify';
import { DB, type Database } from '../db/db.module';
import { idempotencyKeys } from '../db/schema';
import { AppError } from './problem';
import { sha256Hex } from './crypto';

/** Las claves se guardan 24 h (§7.1). */
const TTL_HOURS = 24;

/**
 * Idempotencia de entrada (§7.1).
 *
 * n8n deriva la clave de la conversación más el ID del mensaje de
 * confirmación del cliente, nunca de la hora: con la hora al minuto, dos
 * mensajes seguidos se fusionarían en una sola carrera y un reintento a
 * caballo entre dos minutos crearía dos.
 *
 * La misma clave con el mismo cuerpo devuelve la respuesta original sin
 * volver a ejecutar nada. Con un cuerpo distinto es un 409: significa que
 * quien llama está reutilizando una clave por error.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(DB) private readonly db: Database) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const key = request.headers['idempotency-key'];

    if (typeof key !== 'string' || key.length === 0) return next.handle();

    const bodyHash = sha256Hex(JSON.stringify(request.body ?? {}));

    return from(this.lookup(key)).pipe(
      switchMap((existing) => {
        if (existing) {
          if (existing.bodyHash !== bodyHash) {
            throw new AppError(
              'IDEMPOTENCY_MISMATCH',
              'Esa clave de idempotencia ya se usó con un cuerpo distinto',
            );
          }
          return of(existing.responseBody ?? {});
        }

        return next.handle().pipe(
          tap((response) => {
            // No se espera: guardar la respuesta no debe retrasar la del
            // cliente. Si falla, lo peor que pasa es que un reintento
            // vuelva a ejecutar, y las operaciones ya son reintentables.
            void this.store(key, bodyHash, response);
          }),
        );
      }),
    );
  }

  private async lookup(key: string) {
    const [row] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .limit(1);

    if (!row) return null;
    if (row.expiresAt <= new Date()) return null;
    return row;
  }

  private async store(key: string, bodyHash: string, response: unknown): Promise<void> {
    await this.db
      .insert(idempotencyKeys)
      .values({
        key,
        bodyHash,
        responseStatus: 200,
        responseBody: response as Record<string, unknown>,
        expiresAt: new Date(Date.now() + TTL_HOURS * 3600_000),
      })
      .onConflictDoNothing();
  }
}
