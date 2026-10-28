import { useSyncExternalStore } from 'react';
import type { Driver, OutboxEvent, Place, Ride, WahaSession, Zone } from '@tax/shared';
import { estimateEtaMinutes, haversineKm, pointInPolygon, type Point } from '@tax/shared';
import { ApiError, api } from '../api/client';
import { connectOfficeSocket, type OfficeAlert } from '../api/socket';
import { sonarAlarma } from './alarma';
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
  /** Las alertas que aún no se han cerrado, la más reciente primero. */
  alerts: AlertaRecibida[];
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

/** Una alerta del servidor con lo que el panel necesita para cerrarla. */
export interface AlertaRecibida extends OfficeAlert {
  id: number;
  at: number;
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

/**
 * Carreras cuyo detalle esta cargado: alguien abrio su ficha.
 *
 * El listado no trae historial ni ofertas, y antes cada refresco del listado
 * reemplazaba la carrera entera por una sin ellos. Como cualquier evento
 * dispara un refresco, la pestaña de oleadas se vaciaba justo mientras se
 * miraba avanzar una carrera. Con esto, el listado respeta lo que ya habia
 * y el detalle se vuelve a pedir cuando cambia algo.
 */
const conDetalle = new Set<string>();

async function loadRides(): Promise<void> {
  const rows = await api.get<ApiRide[]>('/v1/admin/rides?limit=300');
  const previas = new Map(state.rides.map((ride) => [ride.id, ride]));

  emit({
    rides: rows.map((row) => {
      const nueva = toRide(row);
      const previa = previas.get(nueva.id);
      return previa && conDetalle.has(nueva.id)
        ? { ...nueva, history: previa.history, offers: previa.offers }
        : nueva;
    }),
  });
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
  const zones = await api.get<ApiZone[]>('/v1/admin/zones');
  emit({ zones: zones.map(toZone) });
  await loadWaha();
}

async function loadWaha(): Promise<void> {
  const rows = await api.get<ApiWahaSession[]>('/v1/admin/waha');
  emit({ wahaSessions: rows.map(toWahaSession) });
}

let siguienteAlerta = 1;

/** Detalle completo de una carrera: historial y ofertas por oleada. */
export async function loadRideDetail(rideId: string): Promise<Ride> {
  conDetalle.add(rideId);
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
  /** Las zonas otra vez, después de crear una o cambiar sus oleadas. */
  async refreshZones() {
    const zones = await api.get<ApiZone[]>('/v1/admin/zones');
    emit({ zones: zones.map(toZone) });
  },

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

  dismissAlert(id: number) {
    emit({ alerts: state.alerts.filter((alerta) => alerta.id !== id) });
  },

  /**
   * Revisa las líneas ya, sin esperar al minuto del monitor. Devuelve la
   * revisión para que quien la pidió pueda decir qué salió.
   */
  async revisarLineas() {
    const revision = await api.post<{ ok: boolean; error: string | null; lineas: number; conectadas: number }>(
      '/v1/admin/system/whatsapp/revisar',
    );
    await loadWaha();
    return revision;
  },

  /** Quita una línea que ya no existe en WAHA (solo administradores). */
  async quitarLinea(id: string) {
    await api.del(`/v1/admin/waha/${encodeURIComponent(id)}`);
    await loadWaha();
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

      // Con la ficha abierta, que se vea quien acepto sin tener que reabrirla.
      if (conDetalle.has(event.id)) void loadRideDetail(event.id).catch(reportError);
      scheduleRefresh();
    },

    onRideWave: (event) => {
      const { rideId, ...entrada } = event;

      // Se pinta al instante: la cuenta atras empieza cuando empieza la
      // oleada, no cuando termina de volver una peticion.
      emit({
        rides: state.rides.map((ride) =>
          ride.id === rideId
            ? { ...ride, wave: entrada.wave, waveLog: [...(ride.waveLog ?? []), entrada] }
            : ride,
        ),
      });

      // Y si la ficha esta abierta, se piden las ofertas: el evento dice
      // cuantos conductores, pero los nombres vienen con el detalle.
      if (conDetalle.has(rideId)) void loadRideDetail(rideId).catch(reportError);
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
      const recibida = { ...alert, id: siguienteAlerta++, at: Date.now() };
      // Si una línea vuelve, la alerta de su caída ya no tiene sentido.
      const vigentes =
        alert.kind === 'line_up'
          ? state.alerts.filter((a) => !(a.kind === 'line_down' && a.lineId === alert.lineId))
          : state.alerts;
      emit({ alerts: [recibida, ...vigentes].slice(0, 5) });
      // Suena lo que necesita a alguien ya: una línea que dejó de atender o
      // una carrera que se quedó sin conductor.
      if (alert.kind === 'line_down' || alert.kind === 'no_driver') sonarAlarma();
      if (alert.kind === 'line_down' || alert.kind === 'line_up') void loadWaha().catch(reportError);
    },
  });

  // Red de seguridad: el estado de los conductores cambia sin que llegue un
  // `ride:changed` (abrir turno, pausa), y una posición puede perderse.
  const driversPoll = window.setInterval(() => {
    void loadDrivers().catch(() => undefined);
  }, 15_000);

  // Las líneas las escribe el monitor cada minuto; la alerta llega por el
  // socket, pero si el panel estaba reconectando justo entonces, esto la
  // recoge igual.
  const wahaPoll = window.setInterval(() => {
    void loadWaha().catch(() => undefined);
  }, 30_000);

  const ticker = window.setInterval(() => emit({ tick: state.tick + 1 }), 1000);

  return () => {
    disconnect();
    window.clearInterval(driversPoll);
    window.clearInterval(wahaPoll);
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
