import { uuidv7 } from 'uuidv7';
import type { Database } from './db.module';
import * as schema from './schema';

/**
 * Lo que la operación necesita para existir: las zonas de Paipa con su factor
 * de tortuosidad y sus oleadas, y la tabla de tarifas vigente.
 *
 * Vive aparte del sembrado de desarrollo a propósito. Ese otro crea además
 * conductores de mentira con un PIN conocido y un usuario de oficina con una
 * contraseña de ejemplo, y ejecutarlo contra producción sería abrirle la
 * puerta a cualquiera que haya leído el repositorio. Separando los datos, el
 * sembrado de producción no puede crear esas cosas ni por descuido.
 *
 * Las zonas y las tarifas sí son reales y las confirma la empresa; aquí están
 * las vigentes al desplegar.
 */

/** Rectángulo alrededor de un punto, en GeoJSON (lng, lat). */
export function box(lat: number, lng: number, dLat: number, dLng: number) {
  return {
    type: 'Polygon' as const,
    coordinates: [
      [
        [lng - dLng, lat + dLat],
        [lng + dLng, lat + dLat],
        [lng + dLng, lat - dLat],
        [lng - dLng, lat - dLat],
        [lng - dLng, lat + dLat],
      ] as [number, number][],
    ],
  };
}

export const ZONES = [
  { name: 'Centro', kind: 'urbano' as const, lat: 5.7803, lng: -73.1142, dLat: 0.01, dLng: 0.011, tortuosity: 1.25 },
  { name: 'Lago Sochagota', kind: 'urbano' as const, lat: 5.756, lng: -73.13, dLat: 0.009, dLng: 0.01, tortuosity: 1.3 },
  { name: 'Zona termal', kind: 'urbano' as const, lat: 5.735, lng: -73.148, dLat: 0.009, dLng: 0.01, tortuosity: 1.35 },
  { name: 'Vereda El Salitre', kind: 'rural' as const, lat: 5.814, lng: -73.076, dLat: 0.02, dLng: 0.022, tortuosity: 1.75 },
  { name: 'Vereda Canocas', kind: 'rural' as const, lat: 5.73, lng: -73.07, dLat: 0.022, dLng: 0.024, tortuosity: 1.9 },
  { name: 'Vereda Toibita', kind: 'rural' as const, lat: 5.815, lng: -73.17, dLat: 0.022, dLng: 0.024, tortuosity: 1.85 },
  { name: 'Vereda Palermo', kind: 'rural' as const, lat: 5.725, lng: -73.185, dLat: 0.022, dLng: 0.02, tortuosity: 2.0 },
];

/** En lo urbano la oleada 1 es estrecha y rápida; en vereda, ancha y paciente. */
export const URBAN_WAVES = [
  { wave: 1 as const, radiusKm: 1.5, candidates: 3, timeoutSeconds: 45 },
  { wave: 2 as const, radiusKm: 3.5, candidates: 5, timeoutSeconds: 60 },
  { wave: 3 as const, radiusKm: 12, candidates: 12, timeoutSeconds: 90 },
];

export const RURAL_WAVES = [
  { wave: 1 as const, radiusKm: 5, candidates: 3, timeoutSeconds: 70 },
  { wave: 2 as const, radiusKm: 10, candidates: 6, timeoutSeconds: 90 },
  { wave: 3 as const, radiusKm: 20, candidates: 14, timeoutSeconds: 120 },
];

export async function sembrarZonas(db: Database): Promise<number> {
  for (const zone of ZONES) {
    await db
      .insert(schema.zones)
      .values({
        id: uuidv7(),
        name: zone.name,
        kind: zone.kind,
        polygon: box(zone.lat, zone.lng, zone.dLat, zone.dLng),
        tortuosity: zone.tortuosity,
        waves: zone.kind === 'urbano' ? URBAN_WAVES : RURAL_WAVES,
      })
      .onConflictDoNothing();
  }
  return ZONES.length;
}
