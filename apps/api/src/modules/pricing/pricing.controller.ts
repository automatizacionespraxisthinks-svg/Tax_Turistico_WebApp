import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { fareRules, places } from '../../db/schema';
import { z } from 'zod';
import { pointSchema } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { AppError } from '../../common/problem';
import { ApiKeyGuard, Scopes } from '../identity/api-key.guard';
import { SessionGuard } from '../identity/guards';
import { ZonesService } from './zones.service';
import { FaresService } from './fares.service';
import { GeocodingService } from './geocoding.service';

const quoteSchema = z.object({
  origin: pointSchema.optional(),
  /**
   * Alternativa a `origin` para quien solo tiene la direccion en palabras.
   *
   * La resuelve la API, igual que al crear la carrera: el agente de n8n
   * nunca manda coordenadas, ni para cotizar. Si mandara las de la cotizacion
   * y luego las de la carrera, podrian no ser las mismas.
   */
  originText: z.string().min(4).max(200).optional(),
  destination: pointSchema.optional(),
});

@Controller('v1')
@UseGuards(ApiKeyGuard)
export class PricingController {
  constructor(
    private readonly zonesService: ZonesService,
    private readonly faresService: FaresService,
    private readonly geocoding: GeocodingService,
  ) {}

  /** Las zonas con su configuración de oleadas, para el panel. */
  @Get('zones')
  @Scopes('rides:read')
  listZones() {
    return this.zonesService.all().map((zone) => ({
      id: zone.id,
      name: zone.name,
      kind: zone.kind,
      tortuosity: zone.tortuosity,
      waves: zone.waves,
    }));
  }

  /**
   * Tarifa estimada antes de crear la carrera: el agente la usa para
   * confirmarle un valor aproximado al cliente.
   */
  @Post('quotes')
  @Scopes('rides:read', 'rides:write')
  async quote(@Body(zodBody(quoteSchema)) body: z.infer<typeof quoteSchema>) {
    const origin = body.origin ?? (await this.resolverOrigen(body.originText));
    return this.faresService.quote(origin, body.destination);
  }

  private async resolverOrigen(texto: string | undefined) {
    if (!texto) {
      throw new AppError('VALIDATION_FAILED', 'Hace falta `origin` o `originText`');
    }

    const hallada = await this.geocoding.resolve(texto);
    if (!hallada) {
      // El mismo mensaje que al crear la carrera, para que el agente sepa
      // que lo siguiente es pedir la ubicacion y no reintentar lo mismo.
      throw new AppError(
        'MISSING_LOCATION',
        'No se pudo ubicar esa dirección. Pídele al cliente que comparta su ubicación.',
      );
    }
    return hallada.point;
  }
}

/** Zonas, lugares y tarifas para el panel, con la sesión de la oficina. */
@Controller('v1/admin')
@UseGuards(SessionGuard)
export class AdminPricingController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly zonesService: ZonesService,
  ) {}

  @Get('zones')
  listZones() {
    return this.zonesService.all().map((zone) => ({
      id: zone.id,
      name: zone.name,
      kind: zone.kind,
      tortuosity: zone.tortuosity,
      waves: zone.waves,
      polygon: zone.polygon,
    }));
  }

  /** Catálogo de lugares, ordenado por uso: los más resueltos arriba. */
  @Get('places')
  listPlaces() {
    return this.db
      .select()
      .from(places)
      .where(eq(places.active, true))
      .orderBy(desc(places.uses));
  }

  /** Tabla de precios completa, incluidas las versiones ya vencidas: una
      carrera antigua se cobró con una de ellas y hay que poder verla. */
  @Get('fare-rules')
  listFareRules() {
    return this.db.select().from(fareRules).orderBy(desc(fareRules.effectiveFrom));
  }
}
