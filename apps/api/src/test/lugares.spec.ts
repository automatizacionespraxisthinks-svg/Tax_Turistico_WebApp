import { describe, expect, it } from 'vitest';
import {
  buscarLugar,
  nuevoLugarSchema,
  normalizarParaBuscar,
  poligonoCircular,
  poligonosSeTocan,
  tieneNomenclatura,
} from '@tax/shared';

const LUGARES = [
  { id: 'terminal', name: 'Terminal de transporte', aliases: ['la terminal', 'terminal de buses'], uses: 3 },
  { id: 'duitama', name: 'Terminal de Duitama', aliases: [], uses: 1 },
  { id: 'parque', name: 'Parque principal', aliases: ['el parque', 'la plaza'], uses: 10 },
  { id: 'pacho', name: 'Tienda Don Pacho', aliases: ['donde don pacho'], uses: 0 },
];

describe('catálogo de lugares', () => {
  it('compara sin tildes, mayúsculas ni signos', () => {
    expect(normalizarParaBuscar('  ¡Frente a la Iglesia, Señor!  ')).toBe('frente a la iglesia senor');
  });

  it('reconoce un lugar por su palabra clave dentro de lo que dijo el cliente', () => {
    expect(buscarLugar('Estoy frente a LA TERMINAL, al lado de la panadería', LUGARES)?.lugar.id).toBe('terminal');
    expect(buscarLugar('Recójanme donde Don Pacho por favor', LUGARES)?.lugar.id).toBe('pacho');
    expect(buscarLugar('en la plaza', LUGARES)?.palabra).toBe('la plaza');
  });

  it('solo palabras enteras: «parque» no está en «parqueadero»', () => {
    expect(buscarLugar('en el parqueadero del hotel', LUGARES)).toBeNull();
  });

  it('gana la coincidencia más larga, que es la más precisa', () => {
    expect(buscarLugar('voy a la terminal de Duitama', LUGARES)?.lugar.id).toBe('duitama');
  });

  it('no inventa: sin coincidencia no hay lugar', () => {
    expect(buscarLugar('Calle 25 #18-40', LUGARES)).toBeNull();
  });

  it('distingue una dirección con nomenclatura de una que no la tiene', () => {
    expect(tieneNomenclatura('Calle 25 #18-40, Centro')).toBe(true);
    expect(tieneNomenclatura('cra 10 no. 5-20')).toBe(true);
    expect(tieneNomenclatura('Diagonal 3 con transversal 2')).toBe(true);
    expect(tieneNomenclatura('frente a la terminal')).toBe(false);
    expect(tieneNomenclatura('donde Don Pacho, casa 3')).toBe(false);
  });

  it('rechaza palabras clave de menos de tres letras', () => {
    expect(nuevoLugarSchema.safeParse({ name: 'Parque', aliases: ['el'], point: { lat: 5.78, lng: -73.11 } }).success).toBe(false);
    expect(nuevoLugarSchema.parse({ name: 'Parque', point: { lat: 5.78, lng: -73.11 } }).aliases).toEqual([]);
  });
});

describe('zonas circulares', () => {
  it('el círculo compartido es el mismo que guardó la migración 0014', () => {
    const centro = poligonoCircular(5.7803, -73.1142, 1.3);
    expect(centro.coordinates[0]).toHaveLength(65);
    expect(centro.coordinates[0]![0]).toEqual([-73.102449, 5.7803]);
    expect(centro.coordinates[0]![1]).toEqual([-73.102506, 5.781446]);
    expect(centro.coordinates[0]![64]).toEqual(centro.coordinates[0]![0]);
  });

  it('detecta cuándo dos zonas se montan', () => {
    const puntos = (lat: number, lng: number, r: number) =>
      poligonoCircular(lat, lng, r).coordinates[0]!.map(([x, y]) => ({ lat: y, lng: x }));
    const centro = puntos(5.7803, -73.1142, 1.3);
    expect(poligonosSeTocan(centro, puntos(5.7803, -73.1, 1))).toBe(true);
    // Lago Sochagota, a 3,2 km: no se tocan.
    expect(poligonosSeTocan(centro, puntos(5.756, -73.13, 1.2))).toBe(false);
  });
});
