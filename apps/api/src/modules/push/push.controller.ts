import { Body, Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodBody } from '../../common/zod.pipe';
import { AppError } from '../../common/problem';
import { DriverGuard } from '../identity/guards';
import { IdentityService } from '../identity/identity.service';
import { PushService } from './push.service';

/** Lo que devuelve `pushManager.subscribe()` en el navegador. */
const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

@Controller('v1/driver/push')
export class PushController {
  constructor(
    private readonly push: PushService,
    private readonly identity: IdentityService,
  ) {}

  /**
   * Clave pública VAPID.
   *
   * Es pública por diseño: sirve para que el navegador cifre contra este
   * servidor, no para autorizar nada. Por eso no va detrás de la guarda: la
   * PWA la necesita antes de suscribirse.
   */
  @Get('key')
  key() {
    return { publicKey: this.push.publicKey ?? null, enabled: this.push.isEnabled };
  }

  @Post('subscribe')
  @UseGuards(DriverGuard)
  async subscribe(
    @Req() request: FastifyRequest,
    @Body(zodBody(subscriptionSchema)) body: z.infer<typeof subscriptionSchema>,
  ) {
    const driver = requireDriver(request);
    await this.identity.savePushSubscription(driver.deviceId, body);
    return { ok: true };
  }

  @Delete('subscribe')
  @UseGuards(DriverGuard)
  async unsubscribe(@Req() request: FastifyRequest) {
    const driver = requireDriver(request);
    await this.identity.clearPushSubscription(driver.deviceId);
    return { ok: true };
  }
}

function requireDriver(request: FastifyRequest) {
  if (!request.driver) throw new AppError('UNAUTHORIZED', 'Sin conductor en la petición');
  return request.driver;
}
