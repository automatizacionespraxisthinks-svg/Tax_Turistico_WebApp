import { Injectable } from '@nestjs/common';
import type { Point } from '@tax/shared';
import { estimateEtaMinutes, haversineKm } from '@tax/shared';
import { ZonesService } from './zones.service';

export interface Trayecto {
  originZoneId: string;
  originZoneName: string;
  destinationZoneId?: string;
  /** Por carretera, estimada: la recta por el factor de tortuosidad (ADR-08). */
  distanceKm: number;
  etaMinutes: number;
}

/**
 * Lo que se sabe de un trayecto antes de hacerlo: en qué zona empieza,
 * cuánto mide y cuánto se tarda.
 *
 * Aquí antes se calculaba también la tarifa. La empresa no la maneja desde
 * el sistema, así que se quitó entera: ni el panel, ni la PWA, ni los informes
 * hablan de dinero. Las zonas siguen haciendo falta para despachar.
 */
@Injectable()
export class TrayectosService {
  constructor(private readonly zonesService: ZonesService) {}

  /** Lanza `OUT_OF_COVERAGE` si el origen cae fuera de todas las zonas. */
  medir(origin: Point, destination?: Point): Trayecto {
    const originZone = this.zonesService.requireZone(origin);
    const destinationZone = destination ? this.zonesService.classify(destination) : undefined;

    // La distancia real siempre es mayor que la recta; el factor de
    // tortuosidad de la zona la corrige (ADR-08).
    const straightKm = destination ? haversineKm(origin, destination) : 0;

    return {
      originZoneId: originZone.id,
      originZoneName: originZone.name,
      destinationZoneId: destinationZone?.id,
      distanceKm: Math.round(straightKm * originZone.tortuosity * 100) / 100,
      etaMinutes: estimateEtaMinutes(straightKm, originZone.tortuosity),
    };
  }
}
