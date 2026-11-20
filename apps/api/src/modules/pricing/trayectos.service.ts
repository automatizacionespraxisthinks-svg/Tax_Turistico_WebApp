import { Injectable } from '@nestjs/common';
import type { Point } from '@tax/shared';
import { estimateEtaMinutes, haversineKm } from '@tax/shared';
import { ZonesService } from './zones.service';

export interface Trayecto {
  /** Sin zona cuando el punto es de Paipa pero no cae en ningún polígono. */
  originZoneId: string | null;
  originZoneName: string | null;
  destinationZoneId?: string;
  /** Por carretera, estimada: la recta por el factor de tortuosidad (ADR-08). */
  distanceKm: number;
  etaMinutes: number;
}

/**
 * La tortuosidad de un punto sin zona. Fuera de los polígonos casi siempre
 * es campo, así que se usa la de una vereda y no la del casco; es la misma
 * que ya usa el despacho para ese caso.
 */
const TORTUOSIDAD_SIN_ZONA = 1.5;

/**
 * Lo que se sabe de un trayecto antes de hacerlo: en qué zona empieza,
 * cuánto mide y cuánto se tarda.
 *
 * Aquí antes se calculaba también la tarifa. La empresa no la maneja desde
 * el sistema, así que se quitó entera: ni el panel, ni la PWA, ni los informes
 * hablan de dinero.
 *
 * La zona es para las estadísticas, no un requisito: si el punto no cae en
 * ninguna, el trayecto se mide igual. Si el punto es o no de Paipa lo decide
 * `GeocodingService.cobertura`, antes de llegar aquí.
 */
@Injectable()
export class TrayectosService {
  constructor(private readonly zonesService: ZonesService) {}

  medir(origin: Point, destination?: Point): Trayecto {
    const originZone = this.zonesService.classify(origin);
    const destinationZone = destination ? this.zonesService.classify(destination) : undefined;
    const tortuosidad = originZone?.tortuosity ?? TORTUOSIDAD_SIN_ZONA;

    // La distancia real siempre es mayor que la recta; el factor de
    // tortuosidad de la zona la corrige (ADR-08).
    const straightKm = destination ? haversineKm(origin, destination) : 0;

    return {
      originZoneId: originZone?.id ?? null,
      originZoneName: originZone?.name ?? null,
      destinationZoneId: destinationZone?.id,
      distanceKm: Math.round(straightKm * tortuosidad * 100) / 100,
      etaMinutes: estimateEtaMinutes(straightKm, tortuosidad),
    };
  }
}
