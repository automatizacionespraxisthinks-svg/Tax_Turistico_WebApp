import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import {
  cambiosLugarSchema,
  cambiosZonaSchema,
  nuevaZonaSchema,
  nuevoLugarSchema,
  type CambiosLugar,
  type CambiosZona,
  type NuevaZona,
  type NuevoLugar,
} from '@tax/shared';
import { DB, type Database } from '../../db/db.module';
import { places } from '../../db/schema';
import { zodBody } from '../../common/zod.pipe';
import { ApiKeyGuard, Scopes } from '../identity/api-key.guard';
import { Roles, SessionGuard } from '../identity/guards';
import { ZonesService } from './zones.service';
import { CatalogoService, type ActorDelPanel } from './catalogo.service';

function actorDe(request: FastifyRequest): ActorDelPanel {
  const user = request.user!;
  return { id: user.id, name: user.name, role: user.role, ip: request.ip };
}

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

/**
 * Zonas y lugares para el panel, con la sesión de la oficina.
 *
 * Crear una zona o cambiar sus oleadas cambia cómo se despacha, así que es
 * de administrador, como dar de alta un conductor (§8.1). Los lugares los
 * puede agregar cualquiera de la oficina: son lo que va aprendiendo de cómo
 * hablan los clientes.
 */
@Controller('v1/admin')
@UseGuards(SessionGuard)
export class AdminPricingController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly zonesService: ZonesService,
    private readonly catalogo: CatalogoService,
  ) {}

  @Post('zones')
  @Roles('administrador')
  createZone(@Req() request: FastifyRequest, @Body(zodBody(nuevaZonaSchema)) body: NuevaZona) {
    return this.catalogo.crearZona(body, actorDe(request));
  }

  @Patch('zones/:zoneId')
  @Roles('administrador')
  updateZone(
    @Req() request: FastifyRequest,
    @Param('zoneId', ParseUUIDPipe) zoneId: string,
    @Body(zodBody(cambiosZonaSchema)) body: CambiosZona,
  ) {
    return this.catalogo.cambiarZona(zoneId, body, actorDe(request));
  }

  @Post('places')
  createPlace(@Req() request: FastifyRequest, @Body(zodBody(nuevoLugarSchema)) body: NuevoLugar) {
    return this.catalogo.crearLugar(body, actorDe(request));
  }

  @Patch('places/:placeId')
  updatePlace(
    @Req() request: FastifyRequest,
    @Param('placeId', ParseUUIDPipe) placeId: string,
    @Body(zodBody(cambiosLugarSchema)) body: CambiosLugar,
  ) {
    return this.catalogo.cambiarLugar(placeId, body, actorDe(request));
  }

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
