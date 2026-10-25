import { z } from 'zod';

/**
 * Configuración del proceso.
 *
 * Todo entra por variables de entorno de Dokploy; nada de secretos en el
 * repositorio (§8.2). Si falta algo o viene mal, el proceso no arranca: es
 * preferible no levantar a levantar a medias y fallar en la primera carrera.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /** Base `tax` dentro del PostgreSQL 16 existente, con usuario propio. */
  DATABASE_URL: z.string().url(),
  /** El pool se limita a 10 conexiones para convivir en el VPS (§4.2). */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /** Redis 7 existente, usuario ACL `tax` limitado al prefijo `tax:`. */
  REDIS_URL: z.string().url(),
  REDIS_PREFIX: z.string().default('tax:'),

  /** Webhooks hacia n8n, firmados con HMAC-SHA256 (§7.1). */
  N8N_WEBHOOK_URL: z.string().url().optional(),
  N8N_WEBHOOK_SECRET: z.string().min(32).optional(),
  /** Reintentos del relay del outbox: 1 s → 15 min, 10 intentos. */
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(10),

  /**
   * Web Push (ADR-07): despierta la PWA instalada cuando el socket está
   * caído. Sin claves, la API funciona igual y solo avisa por socket; es
   * degradación, no fallo.
   */
  VAPID_PUBLIC_KEY: z.string().min(20).optional(),
  VAPID_PRIVATE_KEY: z.string().min(20).optional(),
  /** Contacto que el servicio de push usa si hay un problema con los envíos. */
  VAPID_SUBJECT: z.string().startsWith('mailto:').default('mailto:soporte@taxturistico.co'),

  /** Cookie de sesión de la oficina. */
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(12),

  /** Clave de cifrado a nivel de aplicación para columnas sensibles
      (documento del conductor, secreto TOTP): 32 bytes en hexadecimal. */
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'Debe ser 32 bytes en hexadecimal'),

  /**
   * Clave de la API de Geocoding de Google.
   *
   * Es opcional a propósito. Sin ella la API no adivina direcciones: exige
   * que la carrera llegue con coordenadas, como antes. Es preferible pedir
   * la ubicación a mandar un taxi a un punto inventado.
   */
  GOOGLE_GEOCODING_API_KEY: z.string().min(20).optional(),

  /**
   * Tras la tercera oleada, una ronda más a todos los conductores
   * disponibles, sin mirar distancia, tipo de vehículo ni antigüedad del
   * GPS. Es para probar los avisos con pocos conductores: con uno solo en
   * turno lejos del punto, las tres oleadas por radio no lo encuentran
   * nunca y no se puede ver una notificación de verdad.
   *
   * Encendida por defecto mientras se prueba. Para volver al comportamiento
   * por radio, `OLEADA_FINAL_A_TODOS=false` en el entorno de la API.
   */
  OLEADA_FINAL_A_TODOS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((valor) => valor === 'true'),

  /**
   * WAHA, para vigilar las líneas de WhatsApp (§10.4). Dentro de Dokploy es
   * el nombre del servicio en la red interna, p. ej. `http://tax-turistico-waha-xxxx:3000`.
   *
   * Opcional: sin ella el monitor no arranca y el panel lo dice. Antes la
   * página de estado prometía «revisión cada minuto» sin que nada revisara.
   */
  WAHA_URL: z.string().url().optional(),
  /** La clave que WAHA exige en `X-Api-Key`, si tiene una configurada. */
  WAHA_API_KEY: z.string().min(8).optional(),

  /** Orígenes autorizados del panel y de la PWA. */
  PUBLIC_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:5174')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),

  /** Posición: antigüedad máxima para considerar a un conductor (§5.2). */
  POSITION_MAX_AGE_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
  /** Radio en el que «Llegué» no cuenta como excepción (§5.3). */
  ARRIVAL_RADIUS_METERS: z.coerce.number().int().min(20).max(1000).default(150),

  /*
   * Borrado del histórico de GPS (§9.3).
   *
   * La tabla `driver_positions` es el recorrido minuto a minuto de toda la
   * plantilla, así que no se guarda más de lo necesario. El plazo del
   * documento son seis meses, y el propio documento lo marca «a confirmar
   * con la empresa»: cambiarlo es una decisión suya, no del código.
   */
  POSITION_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
  /** Filas por lote. Pequeño para no inflar el WAL ni retener bloqueos. */
  POSITION_PURGE_BATCH: z.coerce.number().int().min(100).max(50_000).default(5_000),
  /** Pausa entre lotes: deja respirar al despacho y a autovacuum. */
  POSITION_PURGE_PAUSE_MS: z.coerce.number().int().min(0).max(60_000).default(2_000),
  /**
   * Tope por ejecución. La primera purga sobre meses de atraso podría durar
   * horas; con el tope se reparte en varias noches y ninguna se desmadra.
   */
  POSITION_PURGE_MAX_ROWS: z.coerce.number().int().min(1_000).default(2_000_000),
  /** De madrugada, hora de Colombia: es cuando casi no hay carreras. */
  POSITION_PURGE_CRON: z.string().default('0 4 * * *'),
  PURGE_TIMEZONE: z.string().default('America/Bogota'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuración inválida:\n${detail}`);
  }

  cached = parsed.data;
  return cached;
}

export const ENV = Symbol('ENV');
