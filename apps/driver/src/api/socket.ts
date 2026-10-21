import { io, type Socket } from 'socket.io-client';
import { API_BASE, storedToken } from './client';

/**
 * Canal de tiempo real del conductor.
 *
 * El servidor mete al socket en la sala `driver:<id>` a partir del token, así
 * que aquí solo llegan las ofertas y los cambios de SU carrera.
 *
 * El socket es el camino rápido, no el único: si estaba caído cuando salió la
 * oferta, al reconectar la PWA pregunta por `GET /v1/driver/rides/me` y
 * recupera lo que haya vivo. Nada depende de que el socket estuviera ahí.
 */

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

export interface RideChangedPush {
  id: string;
  code: string;
  status: string;
  version: number;
}

export interface DriverSocketHandlers {
  onOffer: (offer: OfferPush) => void;
  onOfferRevoked: (rideId: string) => void;
  onRideChanged: (event: RideChangedPush) => void;
  onConnectionChange: (connected: boolean) => void;
}

export function connectDriverSocket(handlers: DriverSocketHandlers): () => void {
  const socket: Socket = io(`${API_BASE}/rt`, {
    auth: { token: storedToken() },
    /*
     * Sin `transports`: el orden por defecto de socket.io es sondeo primero y
     * ascenso a WebSocket cuando se puede. Fijar una lista explícita desactiva
     * ese respaldo —con una lista, si el primero falla no prueba el
     * siguiente—, y entonces una red que bloquea WebSocket deja al conductor
     * sin canal. El sondeo atraviesa proxies y redes móviles malas, que es
     * justo el caso de la vereda.
     */
    reconnection: true,
    // En carretera la señal va y viene: se reintenta rápido al principio y
    // con más calma después, para no vaciar la batería.
    reconnectionDelay: 400,
    reconnectionDelayMax: 10_000,
  });

  // En desarrollo conviene ver qué llega: depurar un canal de tiempo real a
  // ciegas, con señal intermitente, es muy costoso.
  if (import.meta.env.DEV) {
    socket.onAny((event: string, ...args: unknown[]) =>
      console.debug('[socket]', event, args),
    );
    socket.on('connect_error', (error: Error) => console.debug('[socket] error', error.message));
  }

  socket.on('connect', () => handlers.onConnectionChange(true));
  socket.on('disconnect', () => handlers.onConnectionChange(false));
  socket.on('connect_error', () => handlers.onConnectionChange(false));

  socket.on('ride:offer', handlers.onOffer);
  socket.on('ride:offer_revoked', (event: { rideId: string }) =>
    handlers.onOfferRevoked(event.rideId),
  );
  socket.on('ride:changed', handlers.onRideChanged);

  return () => {
    socket.removeAllListeners();
    socket.disconnect();
  };
}
