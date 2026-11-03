import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { Point, WaveConfig } from '@tax/shared';
import { DB, type Database } from '../../db/db.module';
import { zones } from '../../db/schema';
import type { GeoJsonPolygon } from '../../db/schema/geo';
import { AppError } from '../../common/problem';

export interface LoadedZone {
  id: string;
  name: string;
  kind: 'urbano' | 'rural';
  tortuosity: number;
  waves: WaveConfig[];
  polygon: GeoJsonPolygon;
  /** El punto de partida de las carreras que no se pudieron ubicar. */
  esReferencia: boolean;
}

/**
 * Zonas en memoria.
 *
 * Son unas decenas de polígonos que cambian muy de vez en cuando, así que
 * viven en el proceso y la clasificación urbano/rural se resuelve con Turf
 * sin tocar la base ni instalar PostGIS (ADR-04). El coste es recordar
 * invalidar la caché al editarlas, y para eso está `reload()`.
 */
@Injectable()
export class ZonesService implements OnModuleInit {
  private readonly logger = new Logger(ZonesService.name);
  private cache: LoadedZone[] = [];

  constructor(@Inject(DB) private readonly db: Database) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    // En orden de creación: sin él, «la primera» dependía de cómo la base
    // devolviera las filas ese día.
    const rows = await this.db.select().from(zones).where(eq(zones.active, true)).orderBy(asc(zones.createdAt));

    this.cache = rows
      .filter((row) => row.kind === 'urbano' || row.kind === 'rural')
      .map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind as 'urbano' | 'rural',
        tortuosity: row.tortuosity,
        waves: row.waves,
        polygon: row.polygon,
        esReferencia: row.esReferencia,
      }));

    this.logger.log(`Zonas cargadas en memoria: ${this.cache.length}`);
  }

  all(): LoadedZone[] {
    return this.cache;
  }

  byId(zoneId: string): LoadedZone | undefined {
    return this.cache.find((zone) => zone.id === zoneId);
  }

  /**
   * Clasifica un punto. Devuelve `undefined` cuando cae fuera de toda zona:
   * eso es `OUT_OF_COVERAGE` para el agente, no un error del sistema.
   */
  classify(point: Point): LoadedZone | undefined {
    // GeoJSON va en [lng, lat]; confundir el orden es el error clásico aquí.
    const coordinates: [number, number] = [point.lng, point.lat];
    return this.cache.find((zone) => booleanPointInPolygon(coordinates, zone.polygon));
  }

  /** Igual que `classify`, pero exige cobertura. */
  requireZone(point: Point): LoadedZone {
    const zone = this.classify(point);
    if (!zone) {
      throw new AppError(
        'OUT_OF_COVERAGE',
        'El punto de recogida está fuera de las zonas con servicio',
      );
    }
    return zone;
  }

  /**
   * El rectángulo que envuelve toda la cobertura.
   *
   * Sale de los polígonos vivos, no de una constante: si mañana se añade una
   * vereda, el geocodificador la busca sin que nadie tenga que acordarse de
   * actualizar unos números a mano.
   */
  boundingBox(): { south: number; west: number; north: number; east: number } | undefined {
    const puntos = this.cache.flatMap((zona) => zona.polygon.coordinates.flat());
    if (puntos.length === 0) return undefined;

    // GeoJSON va en [lng, lat].
    const lngs = puntos.map(([lng]) => lng);
    const lats = puntos.map(([, lat]) => lat);

    return {
      south: Math.min(...lats),
      west: Math.min(...lngs),
      north: Math.max(...lats),
      east: Math.max(...lngs),
    };
  }

  /**
   * Un punto del pueblo desde el que despachar cuando no se sabe mas.
   *
   * El cliente da una direccion y el conductor la lee: esa parte no necesita
   * coordenadas. Pero el despacho si, porque las oleadas son radios, y un
   * radio necesita un centro. Antes de rechazar la carrera se usa el centro
   * de la zona marcada como punto de partida —el Centro, salvo que la
   * oficina elija otra—: desde ahi las oleadas cubren el casco, y el
   * conductor llega leyendo la direccion, como siempre se ha hecho.
   *
   * Antes era «la primera zona urbana» sin orden fijo, y con dos urbanas en
   * producción las carreras sin ubicar caían en Lago Sochagota.
   */
  puntoDeReferencia(): Point | undefined {
    const zona =
      this.cache.find((z) => z.esReferencia) ?? this.cache.find((z) => z.kind === 'urbano') ?? this.cache[0];
    if (!zona) return undefined;

    // El centro del rectángulo que la envuelve: en un círculo es el centro
    // exacto, y el promedio de vértices contaba dos veces el de cierre.
    const puntos = zona.polygon.coordinates.flat();
    const lats = puntos.map(([, y]) => y);
    const lngs = puntos.map(([x]) => x);
    return {
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
      lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    };
  }

  /** Parámetros de la oleada N para una zona, con respaldo razonable. */
  waveConfig(zoneId: string, wave: 1 | 2 | 3): WaveConfig {
    const zone = this.byId(zoneId);
    const configured = zone?.waves.find((w) => w.wave === wave);
    if (configured) return configured;

    // Si una zona no tiene configurada la oleada, se usa un valor creciente
    // en vez de dejar la carrera sin despachar.
    const fallback: Record<1 | 2 | 3, WaveConfig> = {
      1: { wave: 1, radiusKm: 2, candidates: 3, timeoutSeconds: 45 },
      2: { wave: 2, radiusKm: 5, candidates: 6, timeoutSeconds: 60 },
      3: { wave: 3, radiusKm: 15, candidates: 12, timeoutSeconds: 90 },
    };
    return fallback[wave];
  }
}
