import type { WaveLogEntry } from '@tax/shared';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
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
  /**
   * Si el cliente paga con pago electrónico. El destino ya no va: la PWA no
   * lo muestra, porque casi nunca se sabe al pedir y se confundía con la
   * dirección de recogida.
   */
  pagoElectronico: boolean;
  passengers: number;
  distanceKm: number;
  etaMinutes: number;
  expiresAt: string;
  wave: number;
}

export interface OfficeAlert {
  kind: 'no_driver' | 'line_down' | 'line_up' | 'outbox_stuck' | 'driver_no_gps' | 'driver_cancelled';
  rideId?: string;
  code?: string;
  /** La línea de WhatsApp, en `line_down` y `line_up`. */
  lineId?: string;
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
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private revision?: NodeJS.Timeout;

  @WebSocketServer()
  private server!: Server;

  constructor(private readonly identity: IdentityService) {}

  /**
   * Autenticación en la conexión, no por mensaje: un socket anónimo no entra
   * a ninguna sala, así que no puede leer carreras ajenas.
   */
  /**
   * La credencial se comprueba al conectar, y antes no se volvía a mirar:
   * una sesión vencida o cerrada, o un conductor desactivado, seguían
   * recibiendo eventos mientras el socket no se cayera. Cada cinco minutos se
   * repasan los sockets abiertos y se cortan los que ya no valen.
   */
  afterInit(): void {
    this.revision = setInterval(() => void this.revisarSockets(), 5 * 60_000);
    this.revision.unref();
  }

  onModuleDestroy(): void {
    if (this.revision) clearInterval(this.revision);
  }

  private async revisarSockets(): Promise<void> {
    if (!this.server) return;
    try {
      const sockets = await this.server.fetchSockets();
      for (const socket of sockets) {
        const credencial = socket.data.credencial as { tipo: 'conductor' | 'oficina'; token: string } | undefined;
        if (!credencial) continue;
        const vale =
          credencial.tipo === 'conductor'
            ? await this.identity.resolveDriverToken(credencial.token)
            : await this.identity
                .resolveSession(credencial.token)
                .then((u) => (u && !u.mustChangePassword && u.totpEnabled ? u : null));
        if (!vale) {
          socket.emit('session:closed', { motivo: 'Tu sesión ya no está activa. Vuelve a entrar.' });
          socket.disconnect(true);
        }
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'No se pudieron revisar los sockets abiertos');
    }
  }

  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake.auth?.token as string | undefined;
    const cookie = client.handshake.headers.cookie;

    if (token) {
      const driver = await this.identity.resolveDriverToken(token);
      if (driver) {
        await client.join(`driver:${driver.id}`);
        client.data.principal = driver;
        client.data.credencial = { tipo: 'conductor', token };
        this.logger.debug({ id: client.id, driver: driver.code }, 'Conductor en su sala');
        return;
      }
      this.logger.warn({ id: client.id }, 'Token de conductor no válido');
    }

    if (cookie) {
      const session = readCookie(cookie, 'tax_session');
      const user = session ? await this.identity.resolveSession(session) : null;
      /*
       * Las mismas puertas que `SessionGuard` (17/11/2026): sin segundo factor
       * o con la contraseña temporal sin cambiar, la API no deja ver nada, y
       * el socket le daba en vivo carreras, posiciones y alertas.
       */
      if (user && !user.mustChangePassword && user.totpEnabled) {
        await client.join('office');
        client.data.principal = user;
        client.data.credencial = { tipo: 'oficina', token: session! };
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
  /** Le quita la oferta de una carrera a UN conductor, sin tocar la de los demás. */
  retirarOfertaDe(driverId: string, rideId: string): void {
    this.server?.to(`driver:${driverId}`).emit('ride:offer_revoked', { rideId });
  }

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

  /**
   * Al conductor se le cerró el turno sin que él lo pidiera: otro tomó su
   * móvil (relevo) o la oficina lo suspendió. La PWA vuelve a preguntar su
   * estado y muestra el motivo, en vez de quedarse esperando carreras que
   * ya no le van a llegar.
   */
  /**
   * Cierra la sesión de UN celular del conductor (17/11/2026): le avisa a la
   * PWA por qué y le corta el socket. La sala es por conductor, así que sin
   * esto un celular revocado seguía recibiendo ofertas por el socket hasta
   * que se reconectara.
   */
  async cerrarSesionDe(driverId: string, deviceId: string, motivo: string): Promise<void> {
    if (!this.server) return;
    const sockets = await this.server.in(`driver:${driverId}`).fetchSockets();
    for (const socket of sockets) {
      if ((socket.data.principal as { deviceId?: string } | undefined)?.deviceId !== deviceId) continue;
      socket.emit('session:closed', { motivo });
      socket.disconnect(true);
    }
  }

  turnoCerrado(driverId: string, motivo: string): void {
    this.server?.to(`driver:${driverId}`).emit('shift:closed', { motivo });
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
