import { Module, forwardRef } from '@nestjs/common';
import { RidesService } from './rides.service';
import { FotosService } from './fotos.service';
import { TitularesService } from './titulares.service';
import { RidesController } from './rides.controller';
import { DriverRidesController } from './driver-rides.controller';
import { PricingModule } from '../pricing/pricing.module';
import { FleetModule } from '../fleet/fleet.module';
import { AdminRidesController } from './admin-rides.controller';
import { AdminCustomersController } from './admin-customers.controller';
import { CustomersController } from './customers.controller';
import { IntegrationsModule } from '../integrations/integrations.module';
import { DispatchModule } from '../dispatch/dispatch.module';

/**
 * Carreras.
 *
 * Es dueño del ciclo de vida, la edición de dirección y el historial de
 * estados, y expone `POST /v1/rides` más los comandos de estado (§4.1).
 */
@Module({
  imports: [PricingModule, FleetModule, IntegrationsModule, forwardRef(() => DispatchModule)],
  providers: [RidesService, FotosService, TitularesService],
  controllers: [RidesController, CustomersController, DriverRidesController, AdminRidesController, AdminCustomersController],
  exports: [RidesService],
})
export class RidesModule {}
