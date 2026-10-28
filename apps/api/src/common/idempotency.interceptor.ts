import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq, sql } from 'drizzle-orm';
import { type Observable, catchError, concatMap, from, of, switchMap } from 'rxjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DB, type Database } from '../db/db.module';
import { idempotencyKeys } from '../db/schema';
import { AppError } from './problem';
import { sha256Hex } from './crypto';

/** Las claves se guardan 24 h (§7.1). */
const TTL_HOURS = 24;

/**
 * `response_status` mientras la primera petición sigue en curso. Cualquier
 * otro valor quiere decir que ya respondió y su respuesta está guardada.
 */
const EN_CURSO = 0;
const LISTA = 200;

/** Cuánto espera una repetición a que termine la primera, y cada cuánto mira. */
const ESPERA_MAXIMA_MS = 15_000;
const PAUSA_MS = 200;

/**
 * Una reserva que sigue «en curso» pasado este tiempo es de un proceso que se
 * cayó a mitad de camino: la siguiente petición la toma y vuelve a ejecutar.
 */
const RESERVA_HUERFANA_S = 60;

const HUELLA = 'tax:idempotencia:huella';

/**
 * Qué parte del cuerpo identifica la petición. Sin esto se compara el cuerpo
 * entero; con esto, solo lo que devuelve la función.
 */
export const HuellaDeIdempotencia = (huella: (cuerpo: unknown) => unknown) => SetMetadata(HUELLA, huella);

/** JSON con las claves en orden: el mismo objeto da siempre el mismo texto. */
function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (valor && typeof valor === 'object') {
    return `{${Object.keys(valor)
      .sort()
      .filter((k) => (valor as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonico((valor as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor ?? null);
}

/**
 * Idempotencia de entrada (§7.1).
 *
 * n8n deriva la clave de la conversación más el ID del mensaje del cliente
 * (`wa-1842-msg-98213`), nunca de la hora: con la hora al minuto, dos mensajes
 * seguidos se fusionarían en una sola carrera y un reintento a caballo entre
 * dos minutos crearía dos.
 *
 * La clave se **reserva antes** de ejecutar, no se guarda después de
 * responder. Antes se guardaba sin esperar, justo después de contestar, y una
 * repetición que llegara en ese hueco de milisegundos no la encontraba:
 * volvía a crear la carrera y chocaba con «este teléfono ya tiene una carrera
 * activa». El agente de n8n, que vuelve a llamar ante cualquier error, recibía
 * ese 409 en vez de su carrera. Ahora:
 *
 * - Clave nueva: se reserva, se ejecuta y se guarda la respuesta antes de
 *   contestar.
 * - Clave con respuesta guardada: se devuelve tal cual, sin ejecutar nada.
 * - Clave reservada por una petición que sigue en curso: se espera a que
 *   termine y se devuelve su respuesta.
 * - Si la ejecución falla, la reserva se suelta: el error no se guarda, y un
 *   reintento vuelve a intentarlo.
 *
 * Con la misma clave y una petición distinta es un 409: quien llama está
 * reutilizando una clave por error. Qué cuenta como «distinta» lo decide la
 * huella de cada ruta (`HuellaDeIdempotencia`); por defecto, el cuerpo entero.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const cabecera = request.headers['idempotency-key'];

    if (typeof cabecera !== 'string' || cabecera.length === 0) return next.handle();

    // La misma clave en dos rutas distintas son dos peticiones distintas: sin
    // el prefijo, cancelar con la clave de una creación devolvería la carrera.
    const key = `${request.method} ${request.routeOptions?.url ?? request.url}|${cabecera}`;
    const huella = this.reflector.get<((cuerpo: unknown) => unknown) | undefined>(HUELLA, context.getHandler());
    const bodyHash = sha256Hex(canonico(huella ? huella(request.body) : (request.body ?? {})));

    const repetida = (respuesta: unknown) => {
      void http.getResponse<FastifyReply>().header('idempotent-replayed', 'true');
      return of(respuesta);
    };

    return from(this.reservar(key, bodyHash)).pipe(
      switchMap((reserva) => {
        if (reserva.tipo === 'otra') {
          throw new AppError('IDEMPOTENCY_MISMATCH', 'Esa clave de idempotencia ya se usó con una petición distinta');
        }
        if (reserva.tipo === 'lista') return repetida(reserva.respuesta);
        if (reserva.tipo === 'en_curso') {
          return from(this.esperar(key)).pipe(switchMap((respuesta) => repetida(respuesta)));
        }

        return next.handle().pipe(
          // Se guarda ANTES de contestar: cuando el cliente tiene la
          // respuesta, una repetición ya la encuentra.
          concatMap(async (respuesta) => {
            try {
              await this.guardar(key, respuesta);
            } catch (error) {
              // La carrera ya existe: un fallo al guardar no puede volverse un
              // error para quien llamó. Lo peor es que un reintento no la
              // encuentre, como antes de esta reserva.
              this.logger.error({ key, err: error }, 'No se pudo guardar la respuesta idempotente');
            }
            return respuesta;
          }),
          catchError((error: unknown) =>
            from(this.soltar(key)).pipe(
              switchMap(() => {
                throw error;
              }),
            ),
          ),
        );
      }),
    );
  }

  /**
   * Intenta quedarse con la clave. La toma si no existe, si caducó o si su
   * dueña lleva demasiado «en curso» sin responder. La base decide quién
   * llegó primero: dos peticiones a la vez no pueden reservar las dos.
   */
  private async reservar(
    key: string,
    bodyHash: string,
  ): Promise<
    | { tipo: 'nueva' }
    | { tipo: 'lista'; respuesta: unknown }
    | { tipo: 'en_curso' }
    | { tipo: 'otra' }
  > {
    const tomada = await this.db.execute<{ key: string }>(sql`
      insert into idempotency_keys (key, body_hash, response_status, response_body, created_at, expires_at)
      values (${key}, ${bodyHash}, ${EN_CURSO}, null, now(), now() + make_interval(hours => ${TTL_HOURS}))
      on conflict (key) do update
         set body_hash = excluded.body_hash,
             response_status = excluded.response_status,
             response_body = null,
             created_at = now(),
             expires_at = excluded.expires_at
       where idempotency_keys.expires_at <= now()
          or (idempotency_keys.response_status = ${EN_CURSO}
              and idempotency_keys.created_at < now() - make_interval(secs => ${RESERVA_HUERFANA_S}))
      returning key
    `);
    if (tomada.rows.length > 0) return { tipo: 'nueva' };

    const [fila] = await this.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)).limit(1);
    // Se soltó entre el insert y esta lectura: la ejecución anterior falló.
    if (!fila) return this.reservar(key, bodyHash);
    if (fila.bodyHash !== bodyHash) return { tipo: 'otra' };
    if (fila.responseStatus === EN_CURSO) return { tipo: 'en_curso' };
    return { tipo: 'lista', respuesta: fila.responseBody ?? {} };
  }

  /** Espera a que la primera petición termine y devuelve su respuesta. */
  private async esperar(key: string): Promise<unknown> {
    const limite = Date.now() + ESPERA_MAXIMA_MS;
    while (Date.now() < limite) {
      await new Promise((resolver) => setTimeout(resolver, PAUSA_MS));
      const [fila] = await this.db
        .select({ status: idempotencyKeys.responseStatus, body: idempotencyKeys.responseBody })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, key))
        .limit(1);
      // La primera falló y soltó la clave: que esta lo reintente desde cero
      // sería otra ejecución a ciegas; mejor que quien llama reintente.
      if (!fila) break;
      if (fila.status !== EN_CURSO) return fila.body ?? {};
    }
    throw new AppError(
      'IDEMPOTENCY_IN_PROGRESS',
      'Esa misma petición todavía se está procesando o acaba de fallar; reintente en unos segundos',
    );
  }

  private async guardar(key: string, respuesta: unknown): Promise<void> {
    await this.db
      .update(idempotencyKeys)
      .set({ responseStatus: LISTA, responseBody: (respuesta ?? {}) as Record<string, unknown> })
      .where(eq(idempotencyKeys.key, key));
  }

  private async soltar(key: string): Promise<void> {
    try {
      await this.db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    } catch (error) {
      // Si no se puede soltar, la reserva caduca sola a los 60 s.
      this.logger.warn({ key, err: error }, 'No se pudo soltar la clave de idempotencia');
    }
  }
}
