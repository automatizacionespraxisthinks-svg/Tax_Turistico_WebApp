import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { ProblemFilter } from './common/problem';
import { sha256Hex } from './common/crypto';

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: true,
      // Límite de tamaño de cuerpo: una foto del lugar va por otro endpoint
      // con su propio límite de 5 MB (§8.2).
      bodyLimit: 1024 * 1024,
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new ProblemFilter());

  await app.register(cookie, { secret: env.SESSION_SECRET });

  await app.register(helmet, {
    // CSP estricta sin unsafe-inline (§8.2). La API sirve también el panel y
    // la PWA, que se compilan sin estilos ni scripts en línea.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", ...env.PUBLIC_ORIGINS, 'wss:'],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  /**
   * Limitación de tasa en Redis, no en memoria: el contador debe sobrevivir a
   * un reinicio y, el día que haya una segunda réplica, ser compartido (§8.2).
   */
  await app.register(rateLimit, {
    global: true,
    max: 240,
    timeWindow: '1 minute',
    redis: new Redis(env.REDIS_URL, { keyPrefix: 'tax:rl:', maxRetriesPerRequest: null }),
    /**
     * Se cuenta por clave de API cuando la hay, y por IP en el resto.
     *
     * La clave va resumida, nunca tal cual: es el nombre de una clave de
     * Redis, y Redis no guarda secretos. En Postgres solo vive el hash
     * Argon2 (§8.1) y dejar el secreto entero aquí lo regalaría a cualquiera
     * que lea la base de contadores o un volcado suyo. SHA-256 basta: no hay
     * que verificar nada contra él, solo necesitar siempre el mismo cubo.
     */
    keyGenerator: (request) => {
      const apiKey = request.headers['x-api-key'] as string | undefined;
      return apiKey ? `k:${sha256Hex(apiKey)}` : request.ip;
    },
    // La PWA del conductor manda posición cada 10 s; no puede chocar con el
    // límite pensado para el agente.
    allowList: (request) => request.url === '/v1/driver/position',
  });

  app.enableCors({
    origin: env.PUBLIC_ORIGINS,
    credentials: true,
    // Explícitos: @fastify/cors solo admite GET, HEAD y POST por defecto, y el
    // panel y la PWA viven en otro dominio. Sin esto, activar o desactivar un
    // conductor (PATCH) o quitar una línea (DELETE) fallaban en el navegador
    // con «Failed to fetch» antes de llegar a la API.
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'x-api-key', 'idempotency-key'],
  });

  // Dokploy manda SIGTERM: hay que cerrar colas, socket y pool antes de irse.
  app.enableShutdownHooks();

  // El adaptador de Nest registra su propio parser de JSON durante `init`,
  // así que hay que sustituirlo después: varios comandos del conductor
  // (cerrar turno, aceptar, rechazar) no llevan cuerpo, y el parser por
  // defecto responde 400 a un `content-type: application/json` vacío.
  await app.init();
  const fastify = app.getHttpAdapter().getInstance();
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 1024 * 1024 },
    (_request, body: string | Buffer, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      if (text.trim() === '') return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (error) {
        done(error as Error);
      }
    },
  );

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

void bootstrap();
