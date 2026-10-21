import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Segundo factor de la oficina: TOTP, RFC 6238 (§8.1).
 *
 * Escrito aquí en vez de traer una dependencia porque son treinta líneas de
 * algo que el estándar especifica al detalle y que trae sus propios vectores
 * de prueba: `totp.spec.ts` los comprueba todos. Una dependencia para esto
 * sería más superficie y menos certeza.
 *
 * Los parámetros son los que usan Google Authenticator, Aegis y 1Password, y
 * no son negociables porque el teléfono no los aprende de ninguna parte: los
 * da por supuestos. SHA-1 aquí no es una debilidad —HMAC-SHA1 sigue siendo
 * sólido y el código vive 30 segundos—, es compatibilidad.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;

/* ------------------------------------------------------------- base32 --- */

/**
 * Base32 de RFC 4648 sin relleno. Es lo que leen los lectores de QR y lo que
 * el operador puede teclear a mano si la cámara no coopera; por eso el
 * alfabeto no tiene ni `0`, ni `1`, ni `8`.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(encoded: string): Buffer {
  // Se tolera lo que escribe una persona: minúsculas, espacios y el relleno
  // que algunas aplicaciones añaden al exportar.
  const clean = encoded.toUpperCase().replace(/[\s=]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const character of clean) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) throw new Error('Secreto base32 inválido');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/* --------------------------------------------------------------- HOTP --- */

/**
 * HOTP, RFC 4226 §5.3: HMAC del contador, truncamiento dinámico y módulo.
 *
 * El truncamiento no toma unos bytes fijos: el último nibble del HMAC dice
 * desde dónde leer. Es lo que evita que un código filtre siempre la misma
 * parte del hash.
 */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Intervalo de 30 s al que pertenece un instante. Es el contador de HOTP. */
export function counterAt(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / PERIOD_SECONDS);
}

export function totp(secret: Buffer, atMs: number = Date.now(), digits = DIGITS): string {
  return hotp(secret, counterAt(atMs), digits);
}

/* ------------------------------------------------------- verificación --- */

export interface TotpCheck {
  valid: boolean;
  /** Intervalo que coincidió; hay que guardarlo para no admitirlo dos veces. */
  counter?: number;
}

/**
 * Verifica un código admitiendo deriva de reloj.
 *
 * `window = 1` acepta el intervalo anterior y el siguiente: minuto y medio en
 * total. Los relojes de los teléfonos se van, y un operador que teclea el
 * código justo cuando cambia no debería quedarse fuera. Más ventana que esa
 * solo multiplica los códigos válidos a la vez.
 *
 * `lastCounter` es la protección contra reenvío: dentro de sus 30 segundos un
 * código es válido muchas veces, así que si alguien lo ve por encima del
 * hombro —o lo captura un proxy— le sirve hasta que caduque. Guardando el
 * último intervalo aceptado, cada código vale exactamente una vez.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  options: { atMs?: number; window?: number; lastCounter?: number | null } = {},
): TotpCheck {
  const presented = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(presented)) return { valid: false };

  const window = options.window ?? 1;
  const current = counterAt(options.atMs ?? Date.now());

  for (let drift = -window; drift <= window; drift++) {
    const counter = current + drift;
    if (options.lastCounter != null && counter <= options.lastCounter) continue;

    // Comparación en tiempo constante: una normal filtra cuántos dígitos
    // acertó, y con seis dígitos eso es información aprovechable.
    const expected = Buffer.from(hotp(secret, counter));
    const given = Buffer.from(presented);
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      return { valid: true, counter };
    }
  }

  return { valid: false };
}

/* -------------------------------------------------------------- altas --- */

/** 20 bytes: el tamaño del bloque de SHA-1 y lo que recomienda RFC 4226 §4. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * URI `otpauth://` que se pinta como QR.
 *
 * La etiqueta lleva emisor y cuenta —`Tax Turístico:ana@…`— porque es lo que
 * la aplicación del teléfono muestra en la lista. Con varias cuentas de
 * varios sitios, «ana@…» a secas no le dice nada a nadie.
 */
export function otpauthUri(account: string, secretBase32: string, issuer = 'Tax Turístico'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
