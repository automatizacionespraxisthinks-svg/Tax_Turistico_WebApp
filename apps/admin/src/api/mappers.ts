import type {
  Driver,
  DriverStatus,
  Oleada,
  OutboxEvent,
  Ride,
  RideOffer,
  RideStatus,
  RideStatusEntry,
  VehicleType,
  WahaSession,
  WaveLogEntry,
  Zone,
} from '@tax/shared';

/**
 * Adaptación entre la API y el dominio que usa la interfaz.
 *
 * La API devuelve las filas tal como están en la base —`pickupLat`,
 * `pickupText`, fechas ISO— y las pantallas trabajan con los tipos de
 * `@tax/shared`, donde un punto es un punto. Traducir en un solo sitio
 * mantiene los componentes ajenos a la forma de las tablas: si mañana cambia
 * una columna, solo se toca este archivo.
 */

/* ----------------------------------------------------------- lo que llega */

export interface ApiRide {
  id: string;
  code: string;
  status: RideStatus;
  version: number;
  createdAt: string;
  customerName: string | null;
  customerPhone: string;
  pickupText: string;
  pickupReference: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffText: string | null;
  dropoffLat: number | null;
  dropoffLng: number | null;
  zoneId: string | null;
  vehicleType: VehicleType;
  passengers: number;
  fareEstimate: number;
  distanceKm: number | null;
  fareFinal: number | null;
  dropoffSource: 'cliente' | 'conductor' | null;
  fareRuleVersion: string;
  driverId: string | null;
  line: string | null;
  chatwootConversationId: number | null;
  etaMinutes: number | null;
  notes: string | null;
  wave: number | null;
  waveLog: WaveLogEntry[] | null;
  cancelReason: string | null;
}

export interface ApiRideDetail extends ApiRide {
  history: {
    fromStatus: RideStatus | null;
    toStatus: RideStatus;
    actor: RideStatusEntry['actor'];
    actorName: string;
    at: string;
    note: string | null;
  }[];
  offers: {
    driverId: string;
    driverName: string;
    wave: number;
    /** Ausente si la API todavía no se ha actualizado. */
    intento?: number;
    sentAt: string;
    expiresAt: string;
    etaMinutes: number;
    distanceKm: number;
    response: RideOffer['response'];
  }[];
}

export interface ApiDriver {
  id: string;
  code: string;
  name: string;
  phone: string;
  status: DriverStatus;
  active: boolean;
  deviceRegistered: boolean;
  shiftStartedAt: string | null;
  plate: string | null;
  vehicleType: VehicleType | null;
  capacity: number | null;
  vehicleActive: boolean | null;
  position?: { lat: number; lng: number };
  positionAgeSeconds?: number;
}

export interface ApiZone {
  id: string;
  name: string;
  kind: 'urbano' | 'rural';
  tortuosity: number;
  waves: Zone['waves'];
  polygon: { type: 'Polygon'; coordinates: [number, number][][] };
}

export interface ApiOutboxEvent {
  eventId: string;
  type: OutboxEvent['type'];
  rideId: string | null;
  rideCode: string | null;
  rideVersion: number | null;
  createdAt: string;
  attempts: number;
  status: OutboxEvent['status'];
  nextAttemptAt: string | null;
  lastError: string | null;
}

export interface ApiWahaSession {
  id: string;
  label: string;
  phone: string | null;
  status: WahaSession['status'];
  connected: boolean;
  statusSince: string | null;
  lastCheckAt: string | null;
}

/* -------------------------------------------------------------- traducción */

export function toRide(row: ApiRide): Ride {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    customerPhone: row.customerPhone,
    customerName: row.customerName ?? 'Sin nombre',
    pickup: {
      text: row.pickupText,
      reference: row.pickupReference ?? undefined,
      point:
        row.pickupLat !== null && row.pickupLng !== null
          ? { lat: row.pickupLat, lng: row.pickupLng }
          : undefined,
    },
    dropoff: row.dropoffText
      ? {
          text: row.dropoffText,
          point:
            row.dropoffLat !== null && row.dropoffLng !== null
              ? { lat: row.dropoffLat, lng: row.dropoffLng }
              : undefined,
        }
      : undefined,
    zoneId: row.zoneId ?? '',
    vehicleType: row.vehicleType,
    passengers: row.passengers,
    fareEstimate: row.fareEstimate,
    fareRuleVersion: row.fareRuleVersion,
    distanceKm: row.distanceKm ?? undefined,
    fareFinal: row.fareFinal ?? undefined,
    dropoffSource: row.dropoffSource ?? undefined,
    driverId: row.driverId ?? undefined,
    line: row.line ?? '—',
    chatwootConversationId: row.chatwootConversationId ?? undefined,
    etaMinutes: row.etaMinutes ?? undefined,
    notes: row.notes ?? undefined,
    wave: (row.wave ?? undefined) as Ride['wave'],
    waveLog: row.waveLog ?? [],
    cancelReason: row.cancelReason ?? undefined,
    // El listado no trae historial ni ofertas: se piden al abrir el detalle.
    history: [],
    offers: [],
  };
}

export function toRideDetail(row: ApiRideDetail): Ride {
  return {
    ...toRide(row),
    history: row.history.map((entry) => ({
      from: entry.fromStatus,
      to: entry.toStatus,
      actor: entry.actor,
      actorName: entry.actorName,
      at: entry.at,
      note: entry.note ?? undefined,
    })),
    offers: row.offers.map((offer) => ({
      driverId: offer.driverId,
      driverName: offer.driverName,
      wave: offer.wave as Oleada,
      intento: offer.intento ?? 1,
      sentAt: offer.sentAt,
      expiresAt: offer.expiresAt,
      etaMinutes: offer.etaMinutes,
      distanceKm: offer.distanceKm,
      response: offer.response,
    })),
  };
}

export function toDriver(row: ApiDriver): Driver {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    phone: row.phone,
    status: row.status,
    active: row.active,
    vehicle: {
      plate: row.plate ?? '—',
      type: row.vehicleType ?? 'sedan',
      capacity: row.capacity ?? 4,
      active: row.vehicleActive ?? false,
    },
    position: row.position,
    positionAgeSeconds: row.positionAgeSeconds,
    shiftStartedAt: row.shiftStartedAt ?? undefined,
    // Estos dos todavía no los expone la API; se calcularán con los reportes.
    ridesToday: 0,
    acceptanceRate: 0,
    deviceRegistered: row.deviceRegistered,
  };
}

export function toZone(row: ApiZone): Zone {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    // GeoJSON viene en [lng, lat]; el lienzo del mapa trabaja con puntos.
    polygon: (row.polygon.coordinates[0] ?? []).map(([lng, lat]) => ({ lat, lng })),
    tortuosity: row.tortuosity,
    waves: row.waves,
    activeDrivers: 0,
  };
}

export function toOutboxEvent(row: ApiOutboxEvent): OutboxEvent {
  return {
    eventId: row.eventId,
    type: row.type,
    rideId: row.rideId ?? '',
    rideCode: row.rideCode ?? '—',
    rideVersion: row.rideVersion ?? 0,
    createdAt: row.createdAt,
    attempts: row.attempts,
    status: row.status,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    lastError: row.lastError ?? undefined,
  };
}

export function toWahaSession(row: ApiWahaSession): WahaSession {
  return {
    id: row.id,
    label: row.label,
    phone: row.phone,
    status: row.status,
    connected: row.connected,
    statusSince: row.statusSince,
    // Nulo es «nunca revisada»; inventar «ahora» la haría pasar por recién vista.
    lastCheckAt: row.lastCheckAt,
  };
}
