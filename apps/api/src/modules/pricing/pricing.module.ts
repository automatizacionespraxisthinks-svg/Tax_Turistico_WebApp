import { Module } from '@nestjs/common';
import { ZonesService } from './zones.service';
import { FaresService } from './fares.service';
import { AdminPricingController, PricingController } from './pricing.controller';

/**
 * Tarifas y zonas.
 *
 * Es dueño de la tabla de precios, de los polígonos urbano/rural y del
 * catálogo de veredas y lugares. Expone `quote(origen, destino, hora)` y
 * `classify(punto)`; ningún otro módulo lee sus tablas (§4.1).
 */
@Module({
  providers: [ZonesService, FaresService],
  controllers: [PricingController, AdminPricingController],
  exports: [ZonesService, FaresService],
})
export class PricingModule {}
