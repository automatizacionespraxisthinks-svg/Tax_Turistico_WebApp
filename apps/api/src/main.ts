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
import { AppError, ProblemFilter } from './common/problem';
import { sha256Hex } from './common/crypto';

/** Rutas donde se prueba una credencial: el acceso del conductor y el de la oficina. */
function esAcceso(url: string): boolean {
  const ruta = url.split('?')[0];
  return ruta === '/v1/auth/driver' || ruta === '/v1/auth/session';
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: env.TRUST_PROXY,
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
    /*
     * Los accesos tienen su propio tope, mucho más bajo y siempre por IP: es
     * donde se prueban PIN y contraseñas (17/11/2026).
     */
    max: (request) => (esAcceso(request.url) ? 20 : 240),
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
      /*
       * En los accesos nunca por clave: cada `X-Api-Key` inventada abría un
       * cubo nuevo, y con una distinta por petición no había límite para
       * probar PIN (17/11/2026). Fuera de los accesos una clave falsa no
       * consigue nada —la guarda la rechaza—, así que ahí se mantiene.
       */
      if (esAcceso(request.url)) return `acceso:${request.ip}`;
      const apiKey = request.headers['x-api-key'] as string | undefined;
      return apiKey ? `k:${sha256Hex(apiKey)}` : request.ip;
    },
    /*
     * La PWA del conductor manda posición cada `POSITION_REPORT_*` —dos
     * segundos por defecto, 30 peticiones por minuto y conductor—, y todos
     * los taxis de una misma red salen con la misma IP. No puede chocar con
     * el límite, que está pensado para el agente.
     */
    allowList: (request) => request.url === '/v1/driver/position',
    /*
     * Un 429 de verdad, con el formato de los demás errores (17/11/2026). Lo
     * que lanzaba el plugin no lo reconocía el filtro de errores y salía como
     * un 500: el límite frenaba, pero quien llamaba creía que la API falló.
     */
    errorResponseBuilder: (_request, contexto) =>
      new AppError('RATE_LIMITED', `Demasiadas peticiones. Espera ${Math.ceil(contexto.ttl / 1000)} s y vuelve a intentarlo.`),
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
  // La foto del lugar llega como archivo: el cuerpo es la imagen tal cual.
  // Con su propio límite, el de 5 MB del §8.2, y el resto sigue en 1 MB.
  fastify.addContentTypeParser(
    /^image\/(jpeg|png|webp)$/,
    { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
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
