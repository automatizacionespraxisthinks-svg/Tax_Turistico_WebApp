import { useSyncExternalStore } from 'react';
import type { Driver, OutboxEvent, Place, Ride, WahaSession, Zone } from '@tax/shared';
import { estimateEtaMinutes, haversineKm, pointInPolygon, type Point } from '@tax/shared';
import { ApiError, api } from '../api/client';
import { connectOfficeSocket, type OfficeAlert } from '../api/socket';
import {
  toDriver,
  toOutboxEvent,
  toRide,
  toRideDetail,
  toWahaSession,
  toZone,
  type ApiDriver,
  type ApiOutboxEvent,
  type ApiRide,
  type ApiRideDetail,
  type ApiWahaSession,
  type ApiZone,
} from '../api/mappers';

/**
 * Estado en vivo del panel.
 *
 * Sustituye al store simulado y mantiene exactamente la misma interfaz
 * (`useLive`, `actions`), así que las pantallas no cambiaron: lo que antes
 * movía un temporizador ahora lo mueven el socket y la API.
 *
 * El reparto de responsabilidades es deliberado:
 *  - el socket avisa de que algo cambió, y se aplica al momento para que la
 *    pantalla responda sin esperar;
 *  - la API es la verdad, y se vuelve a pedir en cuanto hay ocasión.
 * Si el socket se pierde un evento —y en señal rural se pierde—, el refresco
 * lo corrige. Lo contrario, fiarlo todo al socket, deja la oficina mirando
 * datos viejos sin saberlo.
 */

export interface LiveState {
  rides: Ride[];
  drivers: Driver[];
  zones: Zone[];
  places: Place[];
  outbox: OutboxEvent[];
  wahaSessions: WahaSession[];
  alerts: OfficeAlert[];
  /** Carrera que acaba de cambiar; la fila la resalta un instante. */
  pulseRideId: string | null;
  /** Zona sobre la que se está lanzando una oleada; el mapa dibuja el barrido. */
  sweepZoneId: string | null;
  connected: boolean;
  loading: boolean;
  error: string | null;
  /** Avanza cada segundo: los contadores regresivos se suscriben a esto. */
  tick: number;
}

type Listener = () => void;

let state: LiveState = {
  rides: [],
  drivers: [],
  zones: [],
  places: [],
  outbox: [],
  wahaSessions: [],
  alerts: [],
  pulseRideId: null,
  sweepZoneId: null,
  connected: false,
  loading: true,
  error: null,
  tick: 0,
};

const listeners = new Set<Listener>();

function emit(next: Partial<LiveState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLive<T>(selector: (snapshot: LiveState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export function getLive(): LiveState {
  return state;
}

/* ------------------------------------------------------------- cargas --- */

async function loadRides(): Promise<void> {
  const rows = await api.get<ApiRide[]>('/v1/admin/rides?limit=300');
  emit({ rides: rows.map(toRide) });
}

async function loadDrivers(): Promise<void> {
  const rows = await api.get<ApiDriver[]>('/v1/admin/drivers');
  emit({ drivers: rows.map(toDriver) });
}

async function loadOutbox(): Promise<void> {
  const rows = await api.get<ApiOutboxEvent[]>('/v1/admin/outbox?limit=100');
  emit({ outbox: rows.map(toOutboxEvent) });
}

async function loadReference(): Promise<void> {
  const [zones, waha] = await Promise.all([
    api.get<ApiZone[]>('/v1/admin/zones'),
    api.get<ApiWahaSession[]>('/v1/admin/waha'),
  ]);
  emit({ zones: zones.map(toZone), wahaSessions: waha.map(toWahaSession) });
}

/** Detalle completo de una carrera: historial y ofertas por oleada. */
export async function loadRideDetail(rideId: string): Promise<Ride> {
  const row = await api.get<ApiRideDetail>(`/v1/admin/rides/${rideId}`);
  const detailed = toRideDetail(row);
  emit({ rides: state.rides.map((ride) => (ride.id === rideId ? detailed : ride)) });
  return detailed;
}

/* -------------------------------------------------- refresco con rebote --- */

let refreshTimer: number | undefined;

/**
 * Varios eventos seguidos —una oleada ofreciendo a cinco conductores— no
 * deben disparar cinco recargas de la lista completa.
 */
function scheduleRefresh(): void {
  if (refreshTimer !== undefined) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    void loadRides().catch(reportError);
    void loadOutbox().catch(reportError);
  }, 400);
}

function reportError(error: unknown): void {
  if (error instanceof ApiError && error.isUnauthorized) {
    emit({ error: 'La sesión expiró' });
    return;
  }
  emit({ error: error instanceof Error ? error.message : 'Error inesperado' });
}

/* ------------------------------------------------------------ acciones --- */

export const actions = {
  /**
   * Recarga la flota.
   *
   * Hace falta porque dar de alta o editar un conductor no genera evento de
   * socket: el tiempo real está pensado para las carreras, que cambian cada
   * segundo, no para el alta de personal, que pasa una vez al mes.
   */
  async refreshDrivers() {
    await loadDrivers();
  },

  /** Relanza el despacho de una carrera sin asignar (§5.3, operador). */
  async relaunch(rideId: string) {
    await api.post(`/v1/admin/rides/${rideId}/redispatch`);
    const ride = state.rides.find((r) => r.id === rideId);
    emit({ pulseRideId: rideId, sweepZoneId: ride?.zoneId ?? null });
    window.setTimeout(() => emit({ pulseRideId: null, sweepZoneId: null }), 2600);
    scheduleRefresh();
  },

  /** Asignación manual a un conductor concreto (RF-41). */
  async assign(rideId: string, driverId: string) {
    await api.post(`/v1/admin/rides/${rideId}/assign`, { driverId });
    emit({ pulseRideId: rideId });
    window.setTimeout(() => emit({ pulseRideId: null }), 900);
    scheduleRefresh();
    void loadDrivers().catch(reportError);
  },

  async cancel(rideId: string, reason: string) {
    await api.post(`/v1/admin/rides/${rideId}/cancel`, { reason });
    emit({ pulseRideId: rideId });
    window.setTimeout(() => emit({ pulseRideId: null }), 900);
    scheduleRefresh();
    void loadDrivers().catch(reportError);
  },

  async retryEvent(eventId: string) {
    await api.post(`/v1/admin/outbox/${eventId}/retry`);
    await loadOutbox();
  },

  dismissAlert(index: number) {
    emit({ alerts: state.alerts.filter((_, i) => i !== index) });
  },

};

/* --------------------------------------------------------- arranque --- */

let started = false;

export function startLive(): () => void {
  if (started || typeof window === 'undefined') return () => {};
  started = true;

  const bootstrap = async () => {
    try {
      await Promise.all([loadReference(), loadRides(), loadDrivers(), loadOutbox()]);
      emit({ loading: false, error: null });
    } catch (error) {
      emit({ loading: false });
      reportError(error);
    }
  };

  void bootstrap();

  // El primer `connect` del socket llega justo después de la carga inicial;
  // volver a pedirlo todo ahí duplicaría cada petición en cada arranque. Solo
  // las RE-conexiones necesitan rellenar el hueco.
  let everConnected = false;

  const disconnect = connectOfficeSocket({
    onConnectionChange: (connected) => {
      emit({ connected });

      if (!connected) return;
      if (everConnected) {
        // Durante la caída pasaron cosas de las que el socket ya no avisará.
        void bootstrap();
      }
      everConnected = true;
    },

    onRideChanged: (event) => {
      const known = state.rides.find((ride) => ride.id === event.id);

      if (known) {
        // Se aplica al momento para que la pantalla responda; el refresco
        // posterior trae el resto de campos.
        emit({
          rides: state.rides.map((ride) =>
            ride.id === event.id
              ? {
                  ...ride,
                  status: event.status as Ride['status'],
                  version: event.version,
                  driverId: event.driverId ?? undefined,
                }
              : ride,
          ),
          pulseRideId: event.id,
          sweepZoneId: event.status === 'NOTIFIED' ? (known.zoneId ?? null) : state.sweepZoneId,
        });
        window.setTimeout(() => emit({ pulseRideId: null }), 900);
        if (event.status === 'NOTIFIED') {
          window.setTimeout(() => emit({ sweepZoneId: null }), 2600);
        }
      }

      scheduleRefresh();
    },

    onDriverMoved: (event) => {
      emit({
        drivers: state.drivers.map((driver) =>
          driver.id === event.driverId
            ? { ...driver, position: { lat: event.lat, lng: event.lng }, positionAgeSeconds: 0 }
            : driver,
        ),
      });
    },

    onAlert: (alert) => {
      emit({ alerts: [alert, ...state.alerts].slice(0, 5) });
    },
  });

  // Red de seguridad: el estado de los conductores cambia sin que llegue un
  // `ride:changed` (abrir turno, pausa), y una posición puede perderse.
  const driversPoll = window.setInterval(() => {
    void loadDrivers().catch(() => undefined);
  }, 15_000);

  const ticker = window.setInterval(() => emit({ tick: state.tick + 1 }), 1000);

  return () => {
    disconnect();
    window.clearInterval(driversPoll);
    window.clearInterval(ticker);
    started = false;
  };
}

/* -------------------------------------------------------- derivados --- */

/** Zona que contiene un punto, con las zonas ya cargadas de la API. */
export function zoneOf(point: Point): Zone | undefined {
  return state.zones.find((zone) => pointInPolygon(point, zone.polygon));
}

/**
 * Recuadro que encierra todas las zonas, con un margen.
 * Se calcula de los datos en vez de fijarlo: si mañana se añade una vereda
 * más lejos, el mapa la incluye sin tocar código.
 */
export function zonesBoundingBox(zones: Zone[]): {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
} {
  if (zones.length === 0) {
    return { minLat: 5.696, maxLat: 5.844, minLng: -73.214, maxLng: -73.038 };
  }

  const points = zones.flatMap((zone) => zone.polygon);
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const margin = 0.012;

  return {
    minLat: Math.min(...lats) - margin,
    maxLat: Math.max(...lats) + margin,
    minLng: Math.min(...lngs) - margin,
    maxLng: Math.max(...lngs) + margin,
  };
}

export function etaForRide(ride: Ride, driver?: Driver): number | undefined {
  if (!driver?.position || !ride.pickup.point) return ride.etaMinutes;
  const zone = state.zones.find((z) => z.id === ride.zoneId) ?? zoneOf(ride.pickup.point);
  return estimateEtaMinutes(haversineKm(driver.position, ride.pickup.point), zone?.tortuosity ?? 1.5);
}
