import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  counterAt,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totp,
  verifyTotp,
} from '../common/totp';

/**
 * El segundo factor de la oficina contra los vectores de los estándares.
 *
 * Esto es lo que justifica haber escrito el TOTP en vez de traer una
 * dependencia: RFC 4226 y RFC 6238 publican sus propios casos de prueba, así
 * que la implementación no se valida «a ojo» sino contra el documento. Si
 * alguno de estos falla, el teléfono del operador no va a generar los mismos
 * códigos que el servidor y nadie va a poder entrar.
 */

/** La semilla de los dos RFC: «12345678901234567890» en ASCII, 20 bytes. */
const SEED = Buffer.from('12345678901234567890', 'ascii');

describe('base32 (RFC 4648)', () => {
  // Los vectores del §10, sin el relleno que `otpauth://` no usa.
  const vectores: [string, string][] = [
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  it.each(vectores)('codifica «%s» como %s', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
  });

  it.each(vectores)('descodifica %2$s como «%1$s»', (plain, encoded) => {
    expect(base32Decode(encoded).toString('ascii')).toBe(plain);
  });

  it('tolera minúsculas, espacios y relleno, que es como los teclea una persona', () => {
    expect(base32Decode('mzxw 6ytb oi==').toString('ascii')).toBe('foobar');
  });

  it('rechaza un secreto con caracteres fuera del alfabeto', () => {
    // El alfabeto no tiene 0, 1 ni 8 justamente para que nadie los confunda.
    expect(() => base32Decode('MZXW0YTB')).toThrow();
  });
});

describe('HOTP (RFC 4226, apéndice D)', () => {
  const esperados = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];

  it.each(esperados.map((code, counter) => [counter, code]))(
    'contador %i produce %s',
    (counter, code) => {
      expect(hotp(SEED, counter as number)).toBe(code);
    },
  );
});

describe('TOTP (RFC 6238, apéndice B)', () => {
  // La tabla del RFC usa ocho dígitos; las aplicaciones del teléfono usan
  // seis, así que se comprueba con ocho para poder compararla tal cual.
  const vectores: [number, string][] = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ];

  it.each(vectores)('en el segundo %i el código es %s', (seconds, code) => {
    expect(totp(SEED, (seconds as number) * 1000, 8)).toBe(code);
  });

  it('el contador avanza cada 30 segundos', () => {
    expect(counterAt(59_000)).toBe(1);
    expect(counterAt(89_000)).toBe(2);
    expect(counterAt(1_111_111_109_000)).toBe(37_037_036);
  });
});

describe('verificación', () => {
  const ahora = 1_234_567_890_000;

  it('acepta el código del momento', () => {
    expect(verifyTotp(SEED, totp(SEED, ahora), { atMs: ahora })).toMatchObject({ valid: true });
  });

  it('acepta el intervalo anterior y el siguiente: los relojes se van', () => {
    expect(verifyTotp(SEED, totp(SEED, ahora - 30_000), { atMs: ahora }).valid).toBe(true);
    expect(verifyTotp(SEED, totp(SEED, ahora + 30_000), { atMs: ahora }).valid).toBe(true);
  });

  it('rechaza más allá de la ventana', () => {
    expect(verifyTotp(SEED, totp(SEED, ahora - 90_000), { atMs: ahora }).valid).toBe(false);
    expect(verifyTotp(SEED, totp(SEED, ahora + 90_000), { atMs: ahora }).valid).toBe(false);
  });

  it('rechaza lo que no son seis dígitos sin llegar a calcular nada', () => {
    for (const basura of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
      expect(verifyTotp(SEED, basura, { atMs: ahora }).valid).toBe(false);
    }
  });

  it('no admite el mismo código dos veces', () => {
    const code = totp(SEED, ahora);
    const primera = verifyTotp(SEED, code, { atMs: ahora });
    expect(primera.valid).toBe(true);

    // Dentro de sus 30 segundos el código sigue siendo correcto, pero ya se
    // usó: quien lo vea por encima del hombro llega tarde.
    const segunda = verifyTotp(SEED, code, { atMs: ahora, lastCounter: primera.counter });
    expect(segunda.valid).toBe(false);
  });

  it('tampoco admite un código anterior al último usado', () => {
    const usado = counterAt(ahora);
    const anterior = totp(SEED, ahora - 30_000);
    expect(verifyTotp(SEED, anterior, { atMs: ahora, lastCounter: usado }).valid).toBe(false);
  });
});

describe('altas', () => {
  it('el secreto son 20 bytes legibles en base32', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('dos altas no comparten secreto', () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  it('el URI lleva emisor y cuenta, que es lo que muestra el teléfono', () => {
    const uri = otpauthUri('ana@taxturistico.local', 'JBSWY3DPEHPK3PXP');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);

    const parsed = new URL(uri);
    expect(decodeURIComponent(parsed.pathname)).toBe('/Tax Turístico:ana@taxturistico.local');
    expect(parsed.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(parsed.searchParams.get('issuer')).toBe('Tax Turístico');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
  });
});
