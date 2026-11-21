import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodBody } from '../../common/zod.pipe';
import { DB, type Database } from '../../db/db.module';
import { rideOffers } from '../../db/schema';
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

/** El acuse que manda el teléfono al recibir el aviso de una oferta. */
const acuseSchema = z.object({
  offerId: z.string().uuid(),
  firma: z.string().min(16).max(64),
});

@Controller('v1/driver/push')
export class PushController {
  constructor(
    private readonly push: PushService,
    private readonly identity: IdentityService,
    @Inject(DB) private readonly db: Database,
  ) {}

  /**
   * Acuse de recibo de una oferta (21/11/2026).
   *
   * Lo llama el service worker en cuanto le llega el aviso, con el teléfono
   * bloqueado o la aplicación cerrada, y también la aplicación abierta al
   * recibir la oferta por el socket. Sin guarda de conductor a propósito: el
   * service worker no tiene la sesión. Lo que autoriza es la firma de la
   * oferta, que solo viajó en ese aviso.
   *
   * Solo se anota la primera vez; la respuesta es la misma pase lo que pase,
   * para no contarle a nadie qué ofertas existen.
   */
  @Post('recibido')
  @HttpCode(204)
  async recibido(@Body(zodBody(acuseSchema)) body: z.infer<typeof acuseSchema>) {
    if (!this.push.acuseValido(body.offerId, body.firma)) return;
    await this.db
      .update(rideOffers)
      .set({ recibidaAt: new Date() })
      .where(and(eq(rideOffers.id, body.offerId), isNull(rideOffers.recibidaAt)));
  }

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
