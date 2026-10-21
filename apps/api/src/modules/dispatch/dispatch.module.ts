import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DISPATCH_QUEUE, DispatchService } from './dispatch.service';
import { DispatchProcessor } from './dispatch.processor';
import { FleetModule } from '../fleet/fleet.module';
import { PricingModule } from '../pricing/pricing.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { PushModule } from '../push/push.module';
import { RidesModule } from '../rides/rides.module';

/**
 * Despacho.
 *
 * Es dueño de las oleadas, la selección de candidatos, las ofertas y la
 * aceptación atómica (§4.1). Concentra el riesgo del negocio: si algo falla
 * aquí, se asigna dos veces o no se asigna nunca.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: DISPATCH_QUEUE }),
    FleetModule,
    PricingModule,
    IntegrationsModule,
    PushModule,
    forwardRef(() => RidesModule),
  ],
  providers: [DispatchService, DispatchProcessor],
  exports: [DispatchService],
})
export class DispatchModule {}
