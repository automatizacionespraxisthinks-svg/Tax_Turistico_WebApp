import { Module } from '@nestjs/common';
import { ZonesService } from './zones.service';
import { TrayectosService } from './trayectos.service';
import { GeocodingService } from './geocoding.service';
import { CatalogoService } from './catalogo.service';
import { AdminPricingController, PricingController } from './pricing.controller';

/**
 * Zonas y lugares.
 *
 * Es dueño de los polígonos urbano/rural, del catálogo de veredas y lugares y
 * de la geocodificación. Expone `medir(origen, destino)` y `classify(punto)`;
 * ningún otro módulo lee sus tablas (§4.1). Las tarifas ya no viven aquí: la
 * empresa no las maneja desde el sistema.
 */
@Module({
  providers: [ZonesService, TrayectosService, GeocodingService, CatalogoService],
  controllers: [PricingController, AdminPricingController],
  exports: [ZonesService, TrayectosService, GeocodingService, CatalogoService],
})
export class PricingModule {}
