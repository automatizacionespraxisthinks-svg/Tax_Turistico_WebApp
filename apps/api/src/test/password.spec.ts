import { describe, expect, it } from 'vitest';
import { PASSWORD_MIN_LENGTH, evaluatePassword } from '@tax/shared';

/**
 * La política de contraseñas de la oficina.
 *
 * Lo que estas pruebas fijan no es una lista de reglas sino una postura: que
 * una frase larga sin símbolos vale más que un `Taxi2026!`, y que lo que se
 * rechaza es lo que de verdad se adivina —el nombre, la empresa, las de
 * siempre—, no la falta de un carácter raro.
 */

const PERSONA = { email: 'marcela.ruiz@taxturistico.co', name: 'Marcela Ruiz' };

describe('longitud', () => {
  it(`exige al menos ${PASSWORD_MIN_LENGTH} caracteres`, () => {
    const corta = evaluatePassword('Ab3$xY9z', PERSONA);
    expect(corta.ok).toBe(false);
    expect(corta.problemas.join(' ')).toContain(String(PASSWORD_MIN_LENGTH));
  });

  it('acepta una frase larga aunque no tenga ni un símbolo', () => {
    // El caso que justifica toda la política: esto es mucho más difícil de
    // adivinar que cualquier `Taxi2026!` y se recuerda sin apuntarlo.
    expect(evaluatePassword('el jardin de mi abuela en marzo', PERSONA).ok).toBe(true);
  });

  it('rechaza lo absurdamente largo, que solo sirve para hacer sufrir a Argon2', () => {
    expect(evaluatePassword('a'.repeat(200), PERSONA).ok).toBe(false);
  });
});

describe('lo que de verdad se adivina', () => {
  it('rechaza palabras de la empresa y de la ciudad', () => {
    for (const mala of ['taxturistico2026', 'paipaboyaca123456', 'elTaxiDePaipa2026']) {
      expect(evaluatePassword(mala, PERSONA).ok, mala).toBe(false);
    }
  });

  it('rechaza el nombre y el correo de la persona', () => {
    expect(evaluatePassword('marcela-la-mejor-2026', PERSONA).ok).toBe(false);
    expect(evaluatePassword('ruiz-tiene-la-clave-99', PERSONA).ok).toBe(false);
  });

  it('no se deja engañar por tildes ni mayúsculas', () => {
    expect(evaluatePassword('MARCÉLA-una-clave-larga', PERSONA).ok).toBe(false);
  });

  it('rechaza las de cualquier lista de más usadas', () => {
    for (const mala of ['password-segura-2026', 'micontrasena-larga-1', 'qwertyuiop-y-mas-aun']) {
      expect(evaluatePassword(mala, PERSONA).ok, mala).toBe(false);
    }
  });

  it('rechaza repeticiones y secuencias del teclado', () => {
    expect(evaluatePassword('xxxxxxxxxxxxxx', PERSONA).ok).toBe(false);
    expect(evaluatePassword('mi clave asdfgh buena', PERSONA).ok).toBe(false);
    expect(evaluatePassword('mi clave 12345 buena', PERSONA).ok).toBe(false);
  });

  it('sin contexto de la persona, sigue juzgando lo demás', () => {
    expect(evaluatePassword('una frase larga y tranquila').ok).toBe(true);
    expect(evaluatePassword('corta').ok).toBe(false);
  });
});

describe('la fuerza orienta, no bloquea', () => {
  it('crece con la longitud antes que con los símbolos', () => {
    const conSimbolos = evaluatePassword('Abc1$ xyz9%Q', PERSONA).fuerza;
    const masLarga = evaluatePassword('una frase bastante mas larga que la otra', PERSONA).fuerza;
    expect(masLarga).toBeGreaterThan(conSimbolos);
  });

  it('nunca pasa de 1 si hay algún problema', () => {
    expect(evaluatePassword('taxturistico es una empresa muy larga', PERSONA).fuerza).toBeLessThanOrEqual(1);
  });

  it('se mantiene entre 0 y 4', () => {
    for (const clave of ['', 'a', 'abc', 'una clave normal y corriente', 'x'.repeat(120)]) {
      const { fuerza } = evaluatePassword(clave, PERSONA);
      expect(fuerza).toBeGreaterThanOrEqual(0);
      expect(fuerza).toBeLessThanOrEqual(4);
    }
  });
});

describe('detalles que molestan al copiar y pegar', () => {
  it('rechaza espacios al principio o al final', () => {
    expect(evaluatePassword('  una frase larga y buena  ', PERSONA).ok).toBe(false);
  });

  it('pero permite espacios en medio, que es lo que hace una frase', () => {
    expect(evaluatePassword('una frase larga y buena', PERSONA).ok).toBe(true);
  });
});
