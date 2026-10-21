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
