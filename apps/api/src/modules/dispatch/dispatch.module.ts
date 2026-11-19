import { Logger, Module, forwardRef, type OnApplicationBootstrap } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DISPATCH_QUEUE, DispatchService, EXPIRE_UNASSIGNED_JOB } from './dispatch.service';
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
export class DispatchModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(DispatchModule.name);

  constructor(@InjectQueue(DISPATCH_QUEUE) private readonly queue: Queue) {}

  /**
   * Barrido de carreras sin asignar cada minuto (19/11/2026): la red de
   * seguridad para que ningún cliente quede bloqueado por una carrera que
   * se quedó sin conductor. Idempotente: reiniciar no acumula programaciones.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'caducar-sin-asignar',
      { every: 60_000 },
      { name: EXPIRE_UNASSIGNED_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } },
    );
    this.logger.log('Barrido de carreras sin asignar programado (cada minuto)');
  }
}
