import { z } from 'zod';

export const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type Point = z.infer<typeof pointSchema>;

export const ZONE_KINDS = ['urbano', 'rural', 'vereda', 'referencia'] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

export interface Zone {
  id: string;
  name: string;
  kind: Exclude<ZoneKind, 'referencia'>;
  /** Polígono simplificado en coordenadas geográficas (GeoJSON-like). */
  polygon: Point[];
  /** Factor de tortuosidad usado para el ETA: distancia recta × factor (ADR-08). */
  tortuosity: number;
  /** Parámetros de despacho por oleada, editables desde el panel (§5.2). */
  waves: WaveConfig[];
  activeDrivers: number;
}

export interface WaveConfig {
  wave: 1 | 2 | 3;
  radiusKm: number;
  /** Número de conductores a los que se ofrece simultáneamente. */
  candidates: number;
  /** Segundos antes de vencer la oleada. */
  timeoutSeconds: number;
}

export interface Place {
  id: string;
  name: string;
  kind: ZoneKind;
  zoneId: string;
  point: Point;
  aliases: string[];
  /** Veces que el catálogo resolvió una dirección con este lugar. */
  uses: number;
}

const EARTH_RADIUS_KM = 6371;

/** Distancia en línea recta (haversine). Turf.js hace lo mismo en la API. */
export function haversineKm(a: Point, b: Point): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Círculo alrededor de un punto, como polígono GeoJSON (lng, lat) de `lados`
 * lados, en sentido contrario a las agujas del reloj (RFC 7946).
 *
 * Las zonas son círculos guardados como polígonos: así el despacho, el mapa y
 * la búsqueda de zona usan la misma geometría de siempre. La misma función
 * dibuja la vista previa en el panel y crea la zona en la API, de modo que lo
 * que se ve al crearla es exactamente lo que se guarda. Con 64 lados el borde
 * se aparta del círculo verdadero menos de un 0,2 %.
 */
export function poligonoCircular(lat: number, lng: number, radioKm: number, lados = 64) {
  // El radio medio de la Tierra de la IUGG; la migración 0014 se generó con él.
  const dLat = (radioKm / 6371.0088) * (180 / Math.PI);
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
 * Si dos polígonos se tocan: algún vértice de uno cae dentro del otro. Con
 * zonas circulares de 64 lados basta para no dejar crear una zona encima de
 * otra, que haría ambiguo en cuál cae un punto.
 */
export function poligonosSeTocan(a: Point[], b: Point[]): boolean {
  return a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a));
}

/** Punto en polígono (ray casting), equivalente al booleanPointInPolygon de Turf. */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects =
      pi.lat > point.lat !== pj.lat > point.lat &&
      point.lng < ((pj.lng - pi.lng) * (point.lat - pi.lat)) / (pj.lat - pi.lat) + pi.lng;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * ETA sin servidor de rutas (ADR-08): distancia recta × factor de tortuosidad
 * de la zona, a una velocidad media. Siempre se presenta como aproximado.
 */
export function estimateEtaMinutes(
  distanceKm: number,
  tortuosity: number,
  averageSpeedKmh = 26,
): number {
  return Math.max(1, Math.round(((distanceKm * tortuosity) / averageSpeedKmh) * 60));
}
