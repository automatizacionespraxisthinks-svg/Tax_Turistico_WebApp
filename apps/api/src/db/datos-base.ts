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

const RADIO_TIERRA_KM = 6371.0088;

/**
 * Círculo alrededor de un punto, como polígono GeoJSON (lng, lat) de
 * `lados` lados, en sentido contrario a las agujas del reloj (RFC 7946).
 *
 * Sigue siendo un polígono, no un centro y un radio: así el despacho, el mapa
 * y la búsqueda de zona usan la misma geometría que antes, solo que redonda.
 * Con 64 lados el borde se aparta del círculo verdadero menos de un 0,2 %.
 */
export function circulo(lat: number, lng: number, radioKm: number, lados = 64) {
  const dLat = (radioKm / RADIO_TIERRA_KM) * (180 / Math.PI);
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  const redondear = (n: number) => Math.round(n * 1e6) / 1e6;
  const anillo = Array.from({ length: lados }, (_, i): [number, number] => {
    const t = (2 * Math.PI * i) / lados;
    return [redondear(lng + dLng * Math.cos(t)), redondear(lat + dLat * Math.sin(t))];
  });
  anillo.push(anillo[0]!);
  return { type: 'Polygon' as const, coordinates: [anillo] };
}

/**
 * Las zonas de Paipa, como círculos.
 *
 * Antes eran rectángulos; cada radio, redondeado a 100 m, da la misma área
 * que tenía su rectángulo, así que la cobertura no crece ni se encoge: solo
 * cambia de forma. Ningún círculo se monta sobre otro: el hueco más estrecho, entre
 * Zona termal y Vereda Palermo, es de 0,44 km.
 */
export const ZONES = [
  { name: 'Centro', kind: 'urbano' as const, lat: 5.7803, lng: -73.1142, radioKm: 1.3, tortuosity: 1.25 },
  { name: 'Lago Sochagota', kind: 'urbano' as const, lat: 5.756, lng: -73.13, radioKm: 1.2, tortuosity: 1.3 },
  { name: 'Zona termal', kind: 'urbano' as const, lat: 5.735, lng: -73.148, radioKm: 1.2, tortuosity: 1.35 },
  { name: 'Vereda El Salitre', kind: 'rural' as const, lat: 5.814, lng: -73.076, radioKm: 2.6, tortuosity: 1.75 },
  { name: 'Vereda Canocas', kind: 'rural' as const, lat: 5.73, lng: -73.07, radioKm: 2.9, tortuosity: 1.9 },
  { name: 'Vereda Toibita', kind: 'rural' as const, lat: 5.815, lng: -73.17, radioKm: 2.9, tortuosity: 1.85 },
  { name: 'Vereda Palermo', kind: 'rural' as const, lat: 5.725, lng: -73.185, radioKm: 2.6, tortuosity: 2.0 },
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
        polygon: circulo(zone.lat, zone.lng, zone.radioKm),
        tortuosity: zone.tortuosity,
        waves: zone.kind === 'urbano' ? URBAN_WAVES : RURAL_WAVES,
      })
      .onConflictDoNothing();
  }
  return ZONES.length;
}
