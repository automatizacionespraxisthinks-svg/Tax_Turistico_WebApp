import { createHmac } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import webpush, { WebPushError } from 'web-push';
import { loadEnv } from '../../config/env';
import { safeEqual } from '../../common/crypto';
import { IdentityService } from '../identity/identity.service';

/**
 * Lo que pasó con un aviso. Se guarda en la oferta (`ride_offers.aviso`) para
 * que el panel diga la verdad: antes mostraba «notificado» con solo crear la
 * oferta, aunque el aviso nunca hubiera salido.
 */
export type EstadoAviso = 'enviado' | 'sin_dispositivo' | 'fallido' | 'apagado';

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
 *
 * Acuse de recibo (21/11/2026): cada aviso de oferta lleva el id de la oferta
 * y una firma. El service worker, al recibirlo, la devuelve a
 * `POST /v1/driver/push/recibido`; así se sabe qué teléfonos la recibieron de
 * verdad, y a los que no confirman se les reenvía.
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
   * Firma del acuse de una oferta. No es un secreto de sesión: solo prueba
   * que quien confirma recibió el aviso de ESA oferta (el id es un UUIDv7, y
   * sin firma cualquiera podría marcar como recibidas ofertas ajenas).
   */
  firmaAcuse(offerId: string): string {
    return createHmac('sha256', this.env.SESSION_SECRET).update(`acuse:${offerId}`).digest('base64url').slice(0, 32);
  }

  acuseValido(offerId: string, firma: string): boolean {
    return safeEqual(this.firmaAcuse(offerId), String(firma ?? ''));
  }

  /**
   * Aviso de oferta.
   *
   * El contenido es deliberadamente pobre: solo la zona, nunca la dirección
   * ni el teléfono del cliente. Una notificación se ve en la pantalla
   * bloqueada de un taxi aparcado en la calle, y el detalle solo aparece
   * dentro de la aplicación, tras aceptar (§8.1, minimización del §7.2).
   *
   * Tampoco va la cuenta atrás, y es una decisión, no un olvido: una
   * notificación es fija una vez mostrada, así que el número se congelaría y
   * a los tres minutos diría un tiempo que ya no es. El reloj vivo está en la
   * pantalla de la oferta, dentro de la aplicación.
   *
   * Urgente (21/11/2026): desde el segundo intento la carrera ya dio una
   * vuelta completa sin conductor. El aviso lo dice, con los minutos que lleva
   * esperando el cliente, y el teléfono vibra más largo.
   */
  async notifyOffer(
    driverId: string,
    offer: {
      rideId: string;
      code: string;
      offerId: string;
      zona?: string;
      venceEn: Date;
      urgente?: boolean;
      esperandoMin?: number;
    },
  ): Promise<EstadoAviso> {
    const lugar = offer.zona ? `en ${offer.zona}` : '';
    const payload = offer.urgente
      ? {
          tipo: 'oferta',
          urgente: true,
          rideId: offer.rideId,
          titulo: '🚨 Carrera urgente sin tomar',
          cuerpo: `Un cliente lleva ${Math.max(1, offer.esperandoMin ?? 1)} min esperando${lugar ? ' ' + lugar : ''}. Toca para verla.`,
        }
      : {
          tipo: 'oferta',
          rideId: offer.rideId,
          titulo: 'Nueva carrera',
          cuerpo: lugar ? `En ${offer.zona}` : 'Toca para verla',
        };
    // El aviso vale lo que vale la oferta: si el teléfono está en reposo
    // profundo y despierta tarde, todavía le sirve. Nunca menos de 30 s.
    const ttl = Math.max(30, Math.min(600, Math.ceil((offer.venceEn.getTime() - Date.now()) / 1000)));
    return this.send(
      driverId,
      { ...payload, ack: { offerId: offer.offerId, firma: this.firmaAcuse(offer.offerId) } },
      ttl,
    );
  }

  /**
   * La oferta dejó de estar disponible: se retira el aviso del teléfono.
   *
   * El service worker lo reemplaza por un aviso discreto en vez de solo
   * cerrarlo: Safari (iPhone) le quita el permiso de avisos a la página que
   * recibe pushes sin mostrar nada, y entonces dejarían de llegar todos.
   */
  async revokeOffer(driverId: string, rideId: string): Promise<void> {
    await this.send(driverId, { tipo: 'oferta_retirada', rideId }, 60);
  }

  private async send(driverId: string, payload: Record<string, unknown>, ttl: number): Promise<EstadoAviso> {
    if (!this.enabled) return 'apagado';

    const targets = await this.identity.pushTargetsFor(driverId);
    if (targets.length === 0) return 'sin_dispositivo';

    const body = JSON.stringify(payload);

    const resultados = await Promise.all(
      targets.map(async ({ deviceId, subscription }) => {
        try {
          await webpush.sendNotification(JSON.parse(subscription) as webpush.PushSubscription, body, {
            TTL: ttl,
            urgency: 'high',
            // Un aviso nuevo de la misma carrera reemplaza al anterior en
            // la cola del servicio en vez de acumularse.
            topic: String(payload.rideId ?? 'tax').replace(/-/g, '').slice(0, 32),
          });
          return true;
        } catch (error) {
          await this.handleFailure(deviceId, error);
          return false;
        }
      }),
    );
    return resultados.some(Boolean) ? 'enviado' : 'fallido';
  }

  /**
   * Una suscripción caduca sola: el navegador la rota, el usuario reinstala,
   * el teléfono se formatea. El servicio de push responde 404 o 410 y hay que
   * borrarla, o cada oferta arrastraría intentos muertos para siempre.
   */
  private async handleFailure(deviceId: string, error: unknown): Promise<void> {
    if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
      this.logger.warn({ deviceId }, 'Suscripción caducada: se retira (el conductor debe volver a activar los avisos)');
      await this.identity.clearPushSubscription(deviceId);
      return;
    }

    this.logger.warn(
      { deviceId, err: error instanceof Error ? error.message : String(error) },
      'No se pudo entregar el aviso',
    );
  }
}
