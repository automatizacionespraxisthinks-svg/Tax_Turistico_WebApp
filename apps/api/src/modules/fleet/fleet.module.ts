import { Module } from '@nestjs/common';
import { FleetService } from './fleet.service';
import { FleetController } from './fleet.controller';
import { AdminFleetController, AdminVehiclesController } from './admin-fleet.controller';
import { FleetAdminService } from './fleet-admin.service';
import { PricingModule } from '../pricing/pricing.module';

/**
 * Flota.
 *
 * Es dueño de conductores, vehículos, estados, posición en vivo y sesiones de
 * turno. Expone al despacho la búsqueda de candidatos por radio y tipo (§4.1).
 */
@Module({
  imports: [PricingModule],
  providers: [FleetService, FleetAdminService],
  controllers: [FleetController, AdminFleetController, AdminVehiclesController],
  exports: [FleetService, FleetAdminService],
})
export class FleetModule {}
