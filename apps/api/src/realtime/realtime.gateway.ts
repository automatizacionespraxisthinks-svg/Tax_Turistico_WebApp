import type { WaveLogEntry } from '@tax/shared';
import { Injectable, Logger } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { loadEnv } from '../config/env';
import { IdentityService } from '../modules/identity/identity.service';

export interface OfferPush {
  rideId: string;
  code: string;
  pickupText: string;
  pickupReference?: string | null;
  dropoffText?: string | null;
  fareEstimate: number;
  passengers: number;
  distanceKm: number;
  etaMinutes: number;
  expiresAt: string;
  wave: number;
}

export interface OfficeAlert {
  kind: 'no_driver' | 'line_down' | 'outbox_stuck' | 'driver_no_gps';
  rideId?: string;
  code?: string;
  message: string;
}

/**
 * Tiempo real (ADR-07).
 *
 * Socket.IO en el mismo proceso, con salas por conductor y por oficina. Sin
 * adaptador de Redis mientras haya una sola réplica: añadirlo ahora sería
 * memoria y complejidad sin uso.
 *
 * El socket es el camino rápido, no el único: la PWA también recibe Web Push
 * cuando está cerrada, y nada depende de que el socket estuviera conectado.
 */
@WebSocketGateway({
  namespace: '/rt',
  cors: { origin: loadEnv().PUBLIC_ORIGINS, credentials: true },
  // Señal rural débil: conviene aguantar más que el valor por defecto antes
  // de dar la conexión por perdida.
  pingInterval: 20_000,
  pingTimeout: 25_000,
})
@Injectable()
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(private readonly identity: IdentityService) {}

  /**
   * Autenticación en la conexión, no por mensaje: un socket anónimo no entra
   * a ninguna sala, así que no puede leer carreras ajenas.
   */
  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake.auth?.token as string | undefined;
    const cookie = client.handshake.headers.cookie;

    if (token) {
      const driver = await this.identity.resolveDriverToken(token);
      if (driver) {
        await client.join(`driver:${driver.id}`);
        client.data.principal = driver;
        this.logger.debug({ id: client.id, driver: driver.code }, 'Conductor en su sala');
        return;
      }
      this.logger.warn({ id: client.id }, 'Token de conductor no válido');
    }

    if (cookie) {
      const session = readCookie(cookie, 'tax_session');
      const user = session ? await this.identity.resolveSession(session) : null;
      if (user) {
        await client.join('office');
        client.data.principal = user;
        this.logger.debug({ id: client.id, user: user.name }, 'Oficina en su sala');
        return;
      }
    }

    this.logger.debug({ id: client.id }, 'Socket sin credenciales: se cierra');
    client.disconnect(true);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug({ id: client.id }, 'Socket desconectado');
  }

  /* --------------------------------------------------------------- envíos */

  /** Oferta de carrera a un conductor concreto. */
  offerToDriver(driverId: string, offer: OfferPush): void {
    this.server?.to(`driver:${driverId}`).emit('ride:offer', offer);
  }

  /**
   * Retira la oferta de las demás pantallas tras una aceptación.
   * Se emite a todos los conductores: el que no la tuviera simplemente la
   * ignora, y así no hace falta recordar a quién se le ofreció.
   */
  revokeOffer(rideId: string): void {
    this.server?.emit('ride:offer_revoked', { rideId });
  }

  /** Cambio de estado de una carrera, para el panel. */
  rideChanged(ride: { id: string; code: string; status: string; version: number; driverId?: string | null }): void {
    this.server?.to('office').emit('ride:changed', {
      id: ride.id,
      code: ride.code,
      status: ride.status,
      version: ride.version,
      driverId: ride.driverId ?? null,
    });

    if (ride.driverId) {
      this.server?.to(`driver:${ride.driverId}`).emit('ride:changed', {
        id: ride.id,
        code: ride.code,
        status: ride.status,
        version: ride.version,
      });
    }
  }

  /**
   * Una oleada acaba de lanzarse, para seguirla en vivo desde el panel.
   *
   * Hace falta aparte de `ride:changed` porque de la oleada 2 en adelante la
   * carrera no cambia de estado —sigue Notificada—, y sin este evento el
   * panel no se enteraba de que el radio se habia ampliado.
   */
  rideWave(rideId: string, entrada: WaveLogEntry): void {
    this.server?.to('office').emit('ride:wave', { rideId, ...entrada });
  }

  /** Posición de un conductor, para el mapa de la oficina. */
  driverMoved(driverId: string, lat: number, lng: number): void {
    this.server?.to('office').emit('driver:moved', { driverId, lat, lng });
  }

  /** Alerta sonora en el panel: algo necesita a una persona ya (§5.2, §10.4). */
  alertOffice(alert: OfficeAlert): void {
    this.server?.to('office').emit('alert', alert);
  }
}

function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
