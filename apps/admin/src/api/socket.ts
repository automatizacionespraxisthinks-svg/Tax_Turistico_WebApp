import { io, type Socket } from 'socket.io-client';
import type { WaveLogEntry } from '@tax/shared';
import { API_BASE } from './client';

/**
 * Canal de tiempo real del panel.
 *
 * La autenticación va en la cookie de sesión, así que basta con
 * `withCredentials`. El servidor mete al socket en la sala `office` y desde
 * ahí llegan los cambios de carrera, las posiciones y las alertas.
 *
 * Socket.IO reconecta solo. Lo que no hace es rellenar el hueco: mientras
 * estuvo caído pasaron cosas, así que al reconectar el store vuelve a pedir
 * el estado completo por HTTP. El socket acelera, el HTTP es la verdad.
 */

export interface RideChangedEvent {
  id: string;
  code: string;
  status: string;
  version: number;
  driverId: string | null;
}

/** Una oleada recién lanzada. De la segunda en adelante la carrera no
    cambia de estado, así que sin esto el panel no se enteraba. */
export interface RideWaveEvent extends WaveLogEntry {
  rideId: string;
}

export interface DriverMovedEvent {
  driverId: string;
  lat: number;
  lng: number;
}

export interface OfficeAlert {
  kind: 'no_driver' | 'line_down' | 'line_up' | 'outbox_stuck' | 'driver_no_gps';
  rideId?: string;
  code?: string;
  /** La línea de WhatsApp, en `line_down` y `line_up`. */
  lineId?: string;
  message: string;
}

export interface SocketHandlers {
  onRideChanged: (event: RideChangedEvent) => void;
  onRideWave: (event: RideWaveEvent) => void;
  onDriverMoved: (event: DriverMovedEvent) => void;
  onAlert: (alert: OfficeAlert) => void;
  onConnectionChange: (connected: boolean) => void;
}

export function connectOfficeSocket(handlers: SocketHandlers): () => void {
  const socket: Socket = io(`${API_BASE}/rt`, {
    withCredentials: true,
    /*
     * Sin `transports`: el orden por defecto de socket.io es sondeo primero y
     * ascenso a WebSocket cuando se puede. Fijar una lista explícita desactiva
     * ese respaldo —con una lista, si el primero falla no prueba el
     * siguiente—, y entonces una red que bloquea WebSocket deja al conductor
     * sin canal. El sondeo atraviesa proxies y redes móviles malas, que es
     * justo el caso de la vereda.
     */
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 8000,
  });

  socket.on('connect', () => handlers.onConnectionChange(true));
  socket.on('disconnect', () => handlers.onConnectionChange(false));
  socket.on('connect_error', () => handlers.onConnectionChange(false));

  socket.on('ride:changed', handlers.onRideChanged);
  socket.on('ride:wave', handlers.onRideWave);
  socket.on('driver:moved', handlers.onDriverMoved);
  socket.on('alert', handlers.onAlert);

  return () => {
    socket.removeAllListeners();
    socket.disconnect();
  };
}
