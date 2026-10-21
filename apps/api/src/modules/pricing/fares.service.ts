import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, lte, or, gt } from 'drizzle-orm';
import type { FareQuote, FareRule, Point } from '@tax/shared';
import { estimateEtaMinutes, haversineKm, quoteFare } from '@tax/shared';
import { DB, type Database } from '../../db/db.module';
import { fareRules } from '../../db/schema';
import { AppError } from '../../common/problem';
import { ZonesService } from './zones.service';

export interface QuoteResult extends FareQuote {
  originZoneId: string;
  originZoneName: string;
  destinationZoneId?: string;
  distanceKm: number;
  etaMinutes: number;
}

/**
 * Cálculo de tarifa.
 *
 * La fórmula vive en `@tax/shared`, así que el panel muestra exactamente el
 * mismo número que cobra la API. Aquí solo se elige la regla vigente y se
 * mide la distancia.
 */
@Injectable()
export class FaresService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly zonesService: ZonesService,
  ) {}

  /** Regla vigente para un par de zonas en una fecha dada. */
  private async currentRule(
    originKind: 'urbano' | 'rural',
    destinationKind: 'urbano' | 'rural',
    at: Date,
  ): Promise<FareRule> {
    const [row] = await this.db
      .select()
      .from(fareRules)
      .where(
        and(
          eq(fareRules.originKind, originKind),
          eq(fareRules.destinationKind, destinationKind),
          lte(fareRules.effectiveFrom, at),
          or(isNull(fareRules.effectiveTo), gt(fareRules.effectiveTo, at)),
        ),
      )
      .orderBy(fareRules.effectiveFrom)
      .limit(1);

    if (!row) {
      throw new AppError(
        'NO_FARE_RULE',
        `Sin tarifa vigente para ${originKind} → ${destinationKind}`,
      );
    }

    return {
      version: row.version,
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveTo: row.effectiveTo?.toISOString(),
      legalReference: row.legalReference,
      originKind: row.originKind as 'urbano' | 'rural',
      destinationKind: row.destinationKind as 'urbano' | 'rural',
      baseFare: row.baseFare,
      perKm: row.perKm,
      minimumFare: row.minimumFare,
      surcharges: row.surcharges,
    };
  }

  /**
   * Tarifa estimada de un trayecto. Sin destino se cobra el mínimo de la
   * zona: el cliente a veces no lo sabe al pedir.
   */
  async quote(origin: Point, destination: Point | undefined, at = new Date()): Promise<QuoteResult> {
    const originZone = this.zonesService.requireZone(origin);
    const destinationZone = destination ? this.zonesService.classify(destination) : undefined;
    const destinationKind = destinationZone?.kind ?? originZone.kind;

    const rule = await this.currentRule(originZone.kind, destinationKind, at);

    // La distancia real siempre es mayor que la recta; el factor de
    // tortuosidad de la zona la corrige (ADR-08).
    const straightKm = destination ? haversineKm(origin, destination) : 0;
    const distanceKm = straightKm * originZone.tortuosity;
    const etaMinutes = estimateEtaMinutes(straightKm, originZone.tortuosity);

    const quote = quoteFare(rule, distanceKm, at.getHours());

    return {
      ...quote,
      originZoneId: originZone.id,
      originZoneName: originZone.name,
      destinationZoneId: destinationZone?.id,
      distanceKm: Math.round(distanceKm * 100) / 100,
      etaMinutes,
    };
  }
}
