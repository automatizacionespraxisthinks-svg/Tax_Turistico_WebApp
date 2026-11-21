import type {
  Driver,
  DriverStatus,
  Oleada,
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
  customerId?: string;
  customerEsPrueba?: boolean;
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
  /** Ausente si la API todavía no se ha actualizado: efectivo. */
  pagoElectronico?: boolean;
  distanceKm: number | null;
  dropoffSource: 'cliente' | 'conductor' | null;
  pickupPhotoAt: string | null;
  /** Ausente si la API todavía no se ha actualizado. */
  pickupLink?: string | null;
  pickupSource?: Ride['pickupSource'] | null;
  driverId: string | null;
  line: string | null;
  chatwootConversationId: number | null;
  etaMinutes: number | null;
  notes: string | null;
  wave: number | null;
  waveLog: WaveLogEntry[] | null;
  cancelReason: string | null;
  /** Ausentes si la API todavía no se ha actualizado. */
  cancelledBy?: RideStatusEntry['actor'] | null;
  cancelCode?: string | null;
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
    aviso?: string | null;
    recibidaAt?: string | null;
  }[];
}

export interface ApiDriver {
  id: string;
  code: string;
  name: string;
  /** Nulo si el listado maestro no lo trae. */
  phone: string | null;
  status: DriverStatus;
  active: boolean;
  esPrueba?: boolean;
  aceptaPagoElectronico?: boolean;
  /** Solo mientras la suspensión sigue en pie. */
  suspendidoHasta?: string | null;
  motivoSuspension?: string | null;
  licenseExpiresOn?: string | null;
  licenseRestriction?: string | null;
  moviles?: {
    vehicleId?: string;
    origen?: 'listado' | 'panel';
    internalNumber: string | null;
    plate: string;
    brand: string | null;
    modelYear: number | null;
    role: 'conductor' | 'relevador';
    active: boolean;
  }[];
  deviceRegistered: boolean;
  shiftStartedAt: string | null;
  fueraDeListado?: boolean | null;
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
  esReferencia?: boolean;
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
    customerId: row.customerId,
    customerEsPrueba: row.customerEsPrueba,
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
    pagoElectronico: row.pagoElectronico ?? false,
    distanceKm: row.distanceKm ?? undefined,
    dropoffSource: row.dropoffSource ?? undefined,
    pickupPhotoAt: row.pickupPhotoAt ?? undefined,
    pickupLink: row.pickupLink ?? undefined,
    pickupSource: row.pickupSource ?? undefined,
    driverId: row.driverId ?? undefined,
    line: row.line ?? '—',
    chatwootConversationId: row.chatwootConversationId ?? undefined,
    etaMinutes: row.etaMinutes ?? undefined,
    notes: row.notes ?? undefined,
    wave: (row.wave ?? undefined) as Ride['wave'],
    waveLog: row.waveLog ?? [],
    cancelReason: row.cancelReason ?? undefined,
    cancelledBy: row.cancelledBy ?? undefined,
    cancelCode: row.cancelCode ?? undefined,
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
      aviso: offer.aviso ?? null,
      recibidaAt: offer.recibidaAt ?? null,
    })),
  };
}

export function toDriver(row: ApiDriver): Driver {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    phone: row.phone ?? '',
    status: row.status,
    active: row.active,
    esPrueba: row.esPrueba ?? false,
    aceptaPagoElectronico: row.aceptaPagoElectronico ?? false,
    suspendidoHasta: row.suspendidoHasta ?? undefined,
    motivoSuspension: row.motivoSuspension ?? undefined,
    licenciaVence: row.licenseExpiresOn ?? undefined,
    licenciaRestriccion: row.licenseRestriction ?? undefined,
    moviles: (row.moviles ?? []).map((m) => ({
      vehiculoId: m.vehicleId,
      origen: m.origen,
      interno: m.internalNumber ?? undefined,
      placa: m.plate,
      marca: m.brand ?? undefined,
      modelo: m.modelYear ?? undefined,
      rol: m.role,
      activo: m.active,
    })),
    vehicle: {
      plate: row.plate ?? '—',
      type: row.vehicleType ?? undefined,
      capacity: row.capacity ?? undefined,
      active: row.vehicleActive ?? undefined,
    },
    position: row.position,
    positionAgeSeconds: row.positionAgeSeconds,
    shiftStartedAt: row.shiftStartedAt ?? undefined,
    fueraDeListado: row.fueraDeListado === true,
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
    esReferencia: row.esReferencia ?? false,
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
