import { describe, expect, it } from 'vitest';
import { nombreClaro, recogidaSinSentido } from '@tax/shared';

/** Casos reales de producción (21/11/2026) y sus vecinos. */
describe('nombreClaro', () => {
  it.each(['Alexander Acho', 'Maja🌺💝', 'Daya ~', 'Diego Andrés García Becerra', 'Ana', 'freddy'])('sirve: %s', (n) => {
    expect(nombreClaro(n)).toBe(true);
  });
  it.each(['Dd', '.', '+57 318 555 5550', 'Usuario', '', null, 'xx', 'aaa', '🌺💝', 'Jj Kk'])('no sirve: %s', (n) => {
    expect(nombreClaro(n)).toBe(false);
  });
});

describe('recogidaSinSentido', () => {
  it.each(['disponible', 'Disponible', 'aquí', 'mi casa', 'Punto indicado por el cliente', 'Sin dirección', 'en efectivo por favor', 'ya', '', 'donde estoy'])(
    'no es una dirección: %s',
    (t) => expect(recogidaSinSentido(t)).toBe(true),
  );
  it.each([
    'detrás del Zue',
    'Calle 25 # 18-40',
    'terminal',
    'auditorio Pablo Solano',
    'Vereda Cruz de Bonza, al lado de la escuela',
    'casa azul frente al parque',
    'Cerca de Calle 25, Paipa',
  ])('sí es una dirección: %s', (t) => expect(recogidaSinSentido(t)).toBe(false));
});
