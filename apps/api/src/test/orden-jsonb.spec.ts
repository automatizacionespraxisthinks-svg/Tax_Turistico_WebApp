import { describe, expect, it } from 'vitest';
import { ordenJsonb, sello, selloValido } from '../modules/audit/audit.service';

/**
 * El orden de claves con que la bitácora calcula el hash tiene que ser el
 * mismo en que `jsonb` las devuelve; si no, la verificación ve filas rotas
 * que nadie tocó (la primera, un «Aceptó la carrera» del 21/10/2026).
 */
describe('ordenJsonb', () => {
  it('ordena como jsonb: más cortas primero y, a igual largo, por bytes', () => {
    const ordenado = ordenJsonb({ status: 'ASSIGNED', driverId: 'x', version: 3 }) as Record<string, unknown>;
    expect(Object.keys(ordenado)).toEqual(['status', 'version', 'driverId']);
    expect(Object.keys(ordenJsonb({ bb: 1, a: 2, ab: 3 }) as object)).toEqual(['a', 'ab', 'bb']);
  });

  it('ordena también dentro de objetos y listas', () => {
    const ordenado = ordenJsonb({ pedido: { numero: 1, de: 5 }, lista: [{ zz: 1, a: 2 }] }) as {
      pedido: object;
      lista: object[];
    };
    expect(Object.keys(ordenado.pedido)).toEqual(['de', 'numero']);
    expect(Object.keys(ordenado.lista[0]!)).toEqual(['a', 'zz']);
  });

  it('deja igual lo que no es objeto', () => {
    expect(ordenJsonb(null)).toBeNull();
    expect(ordenJsonb('texto')).toBe('texto');
    expect(ordenJsonb(4)).toBe(4);
  });
});

describe('selloValido', () => {
  const base = {
    prevHash: 'a'.repeat(64),
    actorName: 'Jairo',
    role: 'conductor',
    action: 'Aceptó la carrera',
    entity: 'rides',
    entityId: 'R-2026-000057',
    before: { status: 'NOTIFIED' },
    at: new Date('2026-10-21T18:22:20.065Z'),
  };

  it('una fila vieja, sellada en el orden en que se armó, se reconoce aunque jsonb la reordene', () => {
    // Sellada como lo hacía el código: status, driverId, version.
    const hash = sello({ ...base, after: { status: 'ASSIGNED', driverId: 'd1', version: 3 } });
    // Leída de la base: status, version, driverId.
    expect(selloValido({ ...base, after: { status: 'ASSIGNED', version: 3, driverId: 'd1' } }, hash)).toBe(true);
  });

  it('con objetos anidados de la misma forma también', () => {
    const ola = (wave: number, radiusKm: number) => ({ wave, radiusKm, candidates: 3, timeoutSeconds: 70 });
    const hash = sello({ ...base, before: null, after: { waves: [ola(1, 4), ola(2, 9)], tortuosity: 1.8 } });
    const leida = ordenJsonb({ waves: [ola(1, 4), ola(2, 9)], tortuosity: 1.8 });
    expect(selloValido({ ...base, before: null, after: leida }, hash)).toBe(true);
  });

  it('una fila alterada no pasa, en ningún orden', () => {
    const hash = sello({ ...base, after: { status: 'ASSIGNED', driverId: 'd1', version: 3 } });
    expect(selloValido({ ...base, after: { status: 'ASSIGNED', version: 3, driverId: 'd2' } }, hash)).toBe(false);
    expect(selloValido({ ...base, actorName: 'Otro', after: { status: 'ASSIGNED', version: 3, driverId: 'd1' } }, hash)).toBe(false);
  });

  it('una fila nueva se sella en el orden de jsonb', () => {
    const after = ordenJsonb({ status: 'ASSIGNED', driverId: 'd1', version: 3 });
    const hash = sello({ ...base, before: ordenJsonb(base.before), after });
    expect(selloValido({ ...base, after }, hash)).toBe(true);
  });
});
