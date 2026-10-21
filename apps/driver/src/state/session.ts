import type { Point, RideStatus, VehicleType } from '@tax/shared';

/**
 * Estado de la sesión del conductor.
 *
 * La PWA muestra UNA pantalla por estado y como máximo dos toques por acción
 * (RNF Usabilidad). Por eso el estado es una fase única, no una pila de
 * pantallas: no hay menús ni navegación que perder bajo el sol.
 */

export type Phase =
  | 'login'
  | 'off_shift'
  | 'available'
  | 'paused'
  | 'offer'
  | 'ride'
  | 'summary';

export interface OfferedRide {
  /** Identificador de la carrera: es lo que apuntan los comandos. */
  rideId: string;
  code: string;
  pickupText: string;
  pickupReference?: string;
  dropoffText: string;
  pickupPoint: Point;
  distanceKm: number;
  etaMinutes: number;
  fareEstimate: number;
  passengers: number;
  vehicleType: VehicleType;
  notes?: string;
  zoneName?: string;
  /**
   * Cliente: ausente mientras es una oferta, presente una vez aceptada.
   * El conductor no ve el teléfono hasta que la carrera es suya (§8.1).
   */
  customerPhone?: string;
  customerName?: string;
  /** Fin de la ventana de la oferta, en milisegundos. */
  expiresAt: number;
  wave: 1 | 2 | 3;
}

export interface SessionState {
  phase: Phase;
  /** Estado de la carrera mientras `phase` es 'ride'. */
  rideStatus: Extract<RideStatus, 'ASSIGNED' | 'DRIVER_ARRIVED' | 'IN_PROGRESS'>;
  offer: OfferedRide | null;
  online: boolean;
  /** Acciones hechas sin conexión, esperando en IndexedDB para reenviarse. */
  queued: number;
  shiftStartedAt: number | null;
  ridesToday: number;
  earnedToday: number;
  lastFare: number;
  /** Distancia al punto de recogida; bajo 150 m se habilita "Llegué" (§5.3). */
  metersToPickup: number;
}

export const initialSession: SessionState = {
  phase: 'login',
  rideStatus: 'ASSIGNED',
  offer: null,
  // Optimista no: decir «conectado» sin estarlo esconde justo el fallo que
  // el conductor necesita ver.
  online: false,
  queued: 0,
  shiftStartedAt: null,
  ridesToday: 0,
  earnedToday: 0,
  lastFare: 0,
  metersToPickup: 1240,
};

export type SessionAction =
  | { type: 'login' }
  | { type: 'start_shift' }
  | { type: 'end_shift' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'offer_received'; offer: OfferedRide }
  | { type: 'offer_accepted' }
  | { type: 'offer_rejected' }
  | { type: 'offer_expired' }
  | { type: 'arrived' }
  | { type: 'passenger_on_board' }
  | { type: 'finish' }
  | { type: 'back_to_available' }
  | { type: 'approach'; meters: number }
  | { type: 'set_online'; online: boolean }
  | { type: 'flush_queue' }
  | { type: 'queued' }
  | {
      type: 'restore';
      phase: Phase;
      offer: OfferedRide | null;
      rideStatus?: SessionState['rideStatus'];
      shiftStartedAt?: number | null;
      totals?: { rides: number; earned: number };
    }
  | { type: 'shift_opened' }
  | { type: 'logged_out' };

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'login':
      return { ...state, phase: 'off_shift' };

    case 'start_shift':
      return { ...state, phase: 'available', shiftStartedAt: Date.now() };

    case 'end_shift':
      return { ...state, phase: 'off_shift', shiftStartedAt: null, offer: null };

    case 'pause':
      return { ...state, phase: 'paused' };

    case 'resume':
      return { ...state, phase: 'available' };

    case 'offer_received':
      return state.phase === 'available' ? { ...state, phase: 'offer', offer: action.offer } : state;

    case 'offer_accepted':
      return {
        ...state,
        phase: 'ride',
        rideStatus: 'ASSIGNED',
        metersToPickup: Math.round((state.offer?.distanceKm ?? 1.2) * 1000),
      };

    case 'offer_rejected':
    case 'offer_expired':
      return { ...state, phase: 'available', offer: null };

    case 'arrived':
      return { ...state, rideStatus: 'DRIVER_ARRIVED' };

    case 'passenger_on_board':
      return { ...state, rideStatus: 'IN_PROGRESS' };

    case 'finish': {
      const fare = state.offer?.fareEstimate ?? 0;
      return {
        ...state,
        phase: 'summary',
        lastFare: fare,
        ridesToday: state.ridesToday + 1,
        earnedToday: state.earnedToday + fare,
      };
    }

    case 'back_to_available':
      return { ...state, phase: 'available', offer: null, rideStatus: 'ASSIGNED' };

    case 'approach':
      return { ...state, metersToPickup: Math.max(0, action.meters) };

    case 'set_online':
      return { ...state, online: action.online };

    case 'flush_queue':
      return { ...state, queued: 0 };

    case 'queued':
      return { ...state, queued: state.queued + 1 };

    /** Estado recuperado de la API al abrir o recargar la aplicación. */
    case 'restore':
      /*
       * El resumen de la carrera lo cierra el conductor, no el servidor. Al
       * finalizar llega un `ride:changed` que dispara una recuperación, y sin
       * esta guarda el resumen se borraría en el mismo instante en que
       * aparece: el conductor no llegaría a ver lo que acaba de ganar.
       */
      if (state.phase === 'summary' && action.phase !== 'ride' && action.phase !== 'offer') {
        return {
          ...state,
          ridesToday: action.totals?.rides ?? state.ridesToday,
          earnedToday: action.totals?.earned ?? state.earnedToday,
        };
      }

      return {
        ...state,
        phase: action.phase,
        offer: action.offer,
        rideStatus: action.rideStatus ?? state.rideStatus,
        shiftStartedAt: action.shiftStartedAt ?? state.shiftStartedAt,
        ridesToday: action.totals?.rides ?? state.ridesToday,
        earnedToday: action.totals?.earned ?? state.earnedToday,
      };

    case 'shift_opened':
      return { ...state, phase: 'available', shiftStartedAt: Date.now() };

    case 'logged_out':
      return { ...initialSession, phase: 'login' };

    default:
      return state;
  }
}

/* --------------------------------------------------- lo que llega de la API */

interface ApiRide {
  id: string;
  code: string;
  status: string;
  pickupText: string;
  pickupReference: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffText: string | null;
  fareEstimate: number;
  passengers: number;
  vehicleType: VehicleType;
  notes: string | null;
  etaMinutes: number | null;
  customerName?: string | null;
  customerPhone?: string;
}

/** Oferta recibida por socket (sin cliente). */
export interface ApiOffer {
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

export function offerFromSocket(push: ApiOffer): OfferedRide {
  return {
    rideId: push.rideId,
    code: push.code,
    pickupText: push.pickupText,
    pickupReference: push.pickupReference ?? undefined,
    dropoffText: push.dropoffText ?? 'Sin destino indicado',
    pickupPoint: { lat: 0, lng: 0 },
    distanceKm: push.distanceKm,
    etaMinutes: push.etaMinutes,
    fareEstimate: push.fareEstimate,
    passengers: push.passengers,
    vehicleType: 'sedan',
    expiresAt: new Date(push.expiresAt).getTime(),
    wave: Math.min(3, Math.max(1, push.wave)) as 1 | 2 | 3,
  };
}

/** Carrera ya asignada, tal como la devuelve `GET /v1/driver/rides/me`. */
export function offerFromRide(ride: ApiRide): OfferedRide {
  return {
    rideId: ride.id,
    code: ride.code,
    pickupText: ride.pickupText,
    pickupReference: ride.pickupReference ?? undefined,
    dropoffText: ride.dropoffText ?? 'Sin destino indicado',
    pickupPoint:
      ride.pickupLat !== null && ride.pickupLng !== null
        ? { lat: ride.pickupLat, lng: ride.pickupLng }
        : { lat: 0, lng: 0 },
    distanceKm: 0,
    etaMinutes: ride.etaMinutes ?? 0,
    fareEstimate: ride.fareEstimate,
    passengers: ride.passengers,
    vehicleType: ride.vehicleType,
    notes: ride.notes ?? undefined,
    customerName: ride.customerName ?? undefined,
    customerPhone: ride.customerPhone,
    expiresAt: Date.now(),
    wave: 1,
  };
}

export type { ApiRide };
