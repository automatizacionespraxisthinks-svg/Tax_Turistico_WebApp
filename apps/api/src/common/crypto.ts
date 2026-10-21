import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/**
 * Primitivas criptográficas de la API.
 *
 * Tres usos distintos, que no se deben mezclar:
 *  - contraseñas, PIN y claves de API → Argon2id (lento a propósito);
 *  - firma de webhooks → HMAC-SHA256 con comparación en tiempo constante;
 *  - columnas sensibles → AES-256-GCM, porque el disco del VPS no se puede
 *    cifrar en Hetzner Cloud (§8.2).
 */

/* ------------------------------------------------------------- contraseñas */

const ARGON_OPTIONS = {
  // Parámetros moderados: el VPS es compartido y el presupuesto de memoria
  // del contenedor es de 512 MB.
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashSecret(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
}

export async function verifySecret(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hashValue, plain);
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- firmas --- */

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Firma de los webhooks salientes (§7.1):
 * `v1=HMAC-SHA256(secret, timestamp + "." + body)`.
 */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Comparación en tiempo constante: una comparación normal filtra el prefijo. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verifica una firma entrante. Rechaza también las de más de cinco minutos,
 * para que una petición capturada no se pueda reenviar más tarde (§7.1).
 */
export function verifyWebhook(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  maxAgeSeconds = 300,
): boolean {
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - sentAt);
  if (ageSeconds > maxAgeSeconds) return false;
  return safeEqual(signWebhook(secret, timestamp, body), signature);
}

/* ------------------------------------------------- cifrado de columnas --- */

const IV_BYTES = 12;

/** AES-256-GCM. Devuelve `iv.tag.ciphertext` en base64url. */
export function encryptColumn(keyHex: string, plain: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptColumn(keyHex: string, stored: string): string {
  const [ivPart, tagPart, dataPart] = stored.split('.');
  if (!ivPart || !tagPart || !dataPart) throw new Error('Columna cifrada con formato inválido');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(keyHex, 'hex'),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/* ------------------------------------------------------------- tokens --- */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Hexadecimal, para lo que tenga que sobrevivir a un `split`.
 * base64url incluye `-` y `_`, así que no sirve como parte de un
 * identificador separado por guiones bajos.
 */
export function randomHex(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
}
