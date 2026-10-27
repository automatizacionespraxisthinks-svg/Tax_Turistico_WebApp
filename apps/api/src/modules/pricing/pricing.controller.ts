import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { places } from '../../db/schema';
import { ApiKeyGuard, Scopes } from '../identity/api-key.guard';
import { SessionGuard } from '../identity/guards';
import { ZonesService } from './zones.service';

/**
 * Zonas para las integraciones.
 *
 * Aquí estaba `POST /v1/quotes`, con el que el agente de n8n cotizaba la
 * tarifa. Se quitó con las tarifas: la empresa no maneja precios desde el
 * sistema y el agente no debe prometer ninguno.
 */
@Controller('v1')
@UseGuards(ApiKeyGuard)
export class PricingController {
  constructor(private readonly zonesService: ZonesService) {}

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
}

/** Zonas y lugares para el panel, con la sesión de la oficina. */
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
}
