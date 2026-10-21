import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import webpush, { WebPushError } from 'web-push';
import { loadEnv } from '../../config/env';
import { IdentityService } from '../identity/identity.service';

/**
 * Web Push (ADR-07).
 *
 * Es el respaldo del socket, no un segundo canal paralelo: el socket entrega
 * en milisegundos mientras la PWA está abierta, y esto despierta el teléfono
 * cuando no lo está. La oleada 1 dura 45 segundos; un conductor con el
 * celular en el bolsillo no se entera sin esto.
 *
 * Sin claves VAPID configuradas, el servicio queda inactivo y la API sigue
 * funcionando con el socket. Es degradación consciente, no un fallo.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private readonly env = loadEnv();
  private enabled = false;

  constructor(private readonly identity: IdentityService) {}

  onModuleInit(): void {
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = this.env;

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      this.logger.warn('Sin claves VAPID: los avisos irán solo por socket');
      return;
    }

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    this.enabled = true;
    this.logger.log('Web Push activo');
  }

  get publicKey(): string | undefined {
    return this.env.VAPID_PUBLIC_KEY;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Aviso de oferta.
   *
   * El contenido es deliberadamente pobre: zona y tarifa, nunca la dirección
   * ni el teléfono del cliente. Una notificación se ve en la pantalla
   * bloqueada de un taxi aparcado en la calle, y el detalle solo aparece
   * dentro de la aplicación, tras aceptar (§8.1, minimización del §7.2).
   */
  async notifyOffer(
    driverId: string,
    offer: { rideId: string; code: string; zona?: string; fareEstimate: number; expiresAt: string },
  ): Promise<void> {
    await this.send(driverId, {
      tipo: 'oferta',
      rideId: offer.rideId,
      titulo: 'Nueva carrera',
      cuerpo: offer.zona ? `En ${offer.zona}` : 'Toca para verla',
      // El teléfono muestra la cuenta atrás con su propio reloj: si el aviso
      // llega tarde, el conductor ve el tiempo que de verdad le queda.
      expiraEn: offer.expiresAt,
      urgente: true,
    });
  }

  /** La oferta dejó de estar disponible: se retira el aviso del teléfono. */
  async revokeOffer(driverId: string, rideId: string): Promise<void> {
    await this.send(driverId, { tipo: 'oferta_retirada', rideId });
  }

  private async send(driverId: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;

    const targets = await this.identity.pushTargetsFor(driverId);
    if (targets.length === 0) return;

    const body = JSON.stringify(payload);

    await Promise.all(
      targets.map(async ({ deviceId, subscription }) => {
        try {
          await webpush.sendNotification(
            JSON.parse(subscription) as webpush.PushSubscription,
            body,
            {
              // Más que la ventana de la oleada no tiene sentido: una oferta
              // que llega tarde solo sirve para frustrar al conductor.
              TTL: 60,
              urgency: 'high',
              // Un aviso nuevo de la misma carrera reemplaza al anterior en
              // la cola del servicio en vez de acumularse.
              topic: String(payload.rideId ?? 'tax').slice(0, 32),
            },
          );
        } catch (error) {
          await this.handleFailure(deviceId, error);
        }
      }),
    );
  }

  /**
   * Una suscripción caduca sola: el navegador la rota, el usuario reinstala,
   * el teléfono se formatea. El servicio de push responde 404 o 410 y hay que
   * borrarla, o cada oferta arrastraría intentos muertos para siempre.
   */
  private async handleFailure(deviceId: string, error: unknown): Promise<void> {
    if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
      this.logger.debug({ deviceId }, 'Suscripción caducada: se retira');
      await this.identity.clearPushSubscription(deviceId);
      return;
    }

    this.logger.warn(
      { deviceId, err: error instanceof Error ? error.message : String(error) },
      'No se pudo entregar el aviso',
    );
  }
}
