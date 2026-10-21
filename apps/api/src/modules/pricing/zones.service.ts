import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
    const rows = await this.db.select().from(zones).where(eq(zones.active, true));

    this.cache = rows
      .filter((row) => row.kind === 'urbano' || row.kind === 'rural')
      .map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind as 'urbano' | 'rural',
        tortuosity: row.tortuosity,
        waves: row.waves,
        polygon: row.polygon,
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
