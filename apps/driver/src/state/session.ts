import type { Oleada, Point, RideStatus, VehicleType } from '@tax/shared';

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

/**
 * De dónde salió el punto de recogida, tal como lo guarda la API.
 *
 * `compartida` es la ubicación que mandó el cliente, exacta. `catalogo` es un
 * lugar conocido de Paipa que el cliente nombró («la terminal»). `geocodificada`
 * es una dirección escrita que el geocodificador resolvió, y puede quedarse
 * en la calle sin el número. `sin_ubicar` es una dirección que no resolvió.
 */
export type OrigenDelPunto = 'compartida' | 'catalogo' | 'geocodificada' | 'sin_ubicar';

export interface OfferedRide {
  /** Identificador de la carrera: es lo que apuntan los comandos. */
  rideId: string;
  code: string;
  pickupText: string;
  pickupReference?: string;
  /**
   * El punto del cliente. Ausente en una oferta (el socket no lo trae) y en
   * una carrera sin ubicar: la API le pone el centro del pueblo para poder
   * despachar, y ese no es un lugar al que mandar al conductor.
   */
  pickupPoint?: Point;
  pickupSource?: OrigenDelPunto;
  /** Ausente si el cliente no dijo a dónde va, que es lo más común. */
  dropoffText?: string;
  dropoffPoint?: Point;
  distanceKm: number;
  etaMinutes: number;
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
  /**
   * Cuándo subió el pasajero, en milisegundos. De él sale la cuenta atrás
   * de «Finalizar»: el servidor no deja cerrar antes del mínimo.
   */
  startedAt?: number;
  /** Cuándo llegó la foto del lugar; ausente si el cliente no mandó ninguna. */
  pickupPhotoAt?: string;
  /** Fin de la ventana de la oferta, en milisegundos. */
  expiresAt: number;
  wave: Oleada;
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
  /** Minutos a bordo antes de poder finalizar; los dice la API al abrir. */
  minRideMinutes: number;
  /**
   * Distancia al punto de recogida, medida con cada lectura del GPS; bajo
   * 150 m se habilita "Llegué" (§5.3). Nula mientras no se sabe.
   */
  metersToPickup: number | null;
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
  minRideMinutes: 10,
  metersToPickup: null,
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
      totals?: { rides: number };
      minRideMinutes?: number;
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
        // La distancia de la oferta vale hasta que llegue la primera lectura.
        metersToPickup: state.offer?.distanceKm ? Math.round(state.offer.distanceKm * 1000) : null,
      };

    case 'offer_rejected':
    case 'offer_expired':
      return { ...state, phase: 'available', offer: null };

    case 'arrived':
      return { ...state, rideStatus: 'DRIVER_ARRIVED' };

    case 'passenger_on_board':
      // La hora del teléfono, hasta que la API diga la suya al recuperar.
      return {
        ...state,
        rideStatus: 'IN_PROGRESS',
        offer: state.offer ? { ...state.offer, startedAt: state.offer.startedAt ?? Date.now() } : null,
      };

    case 'finish':
      return { ...state, phase: 'summary', ridesToday: state.ridesToday + 1 };

    case 'back_to_available':
      return { ...state, phase: 'available', offer: null, rideStatus: 'ASSIGNED' };

    case 'approach': {
      // De diez en diez metros: el GPS da una lectura por segundo, y pintar
      // la pantalla por un metro de diferencia no le dice nada al conductor.
      const meters = Math.round(Math.max(0, action.meters) / 10) * 10;
      return meters === state.metersToPickup ? state : { ...state, metersToPickup: meters };
    }

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
       * aparece: el conductor no llegaría a ver que la carrera quedó cerrada.
       */
      if (state.phase === 'summary' && action.phase !== 'ride' && action.phase !== 'offer') {
        return {
          ...state,
          ridesToday: action.totals?.rides ?? state.ridesToday,
          minRideMinutes: action.minRideMinutes ?? state.minRideMinutes,
        };
      }

      return {
        ...state,
        phase: action.phase,
        offer: action.offer,
        rideStatus: action.rideStatus ?? state.rideStatus,
        shiftStartedAt: action.shiftStartedAt ?? state.shiftStartedAt,
        ridesToday: action.totals?.rides ?? state.ridesToday,
        minRideMinutes: action.minRideMinutes ?? state.minRideMinutes,
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
  pickupSource?: OrigenDelPunto | null;
  dropoffText: string | null;
  dropoffLat?: number | null;
  dropoffLng?: number | null;
  passengers: number;
  vehicleType: VehicleType;
  notes: string | null;
  etaMinutes: number | null;
  customerName?: string | null;
  customerPhone?: string;
  startedAt?: string | null;
  pickupPhotoAt?: string | null;
}

/** Oferta recibida por socket (sin cliente). */
export interface ApiOffer {
  rideId: string;
  code: string;
  pickupText: string;
  pickupReference?: string | null;
  dropoffText?: string | null;
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
    dropoffText: push.dropoffText ?? undefined,
    distanceKm: push.distanceKm,
    etaMinutes: push.etaMinutes,
    passengers: push.passengers,
    vehicleType: 'sedan',
    expiresAt: new Date(push.expiresAt).getTime(),
    wave: Math.min(4, Math.max(1, push.wave)) as Oleada,
  };
}

/** Carrera ya asignada, tal como la devuelve `GET /v1/driver/rides/me`. */
export function offerFromRide(ride: ApiRide): OfferedRide {
  return {
    rideId: ride.id,
    code: ride.code,
    pickupText: ride.pickupText,
    pickupReference: ride.pickupReference ?? undefined,
    pickupPoint:
      ride.pickupSource !== 'sin_ubicar' && ride.pickupLat != null && ride.pickupLng != null
        ? { lat: ride.pickupLat, lng: ride.pickupLng }
        : undefined,
    pickupSource: ride.pickupSource ?? undefined,
    dropoffText: ride.dropoffText ?? undefined,
    dropoffPoint:
      ride.dropoffLat != null && ride.dropoffLng != null
        ? { lat: ride.dropoffLat, lng: ride.dropoffLng }
        : undefined,
    distanceKm: 0,
    etaMinutes: ride.etaMinutes ?? 0,
    passengers: ride.passengers,
    vehicleType: ride.vehicleType,
    notes: ride.notes ?? undefined,
    customerName: ride.customerName ?? undefined,
    customerPhone: ride.customerPhone,
    startedAt: ride.startedAt ? new Date(ride.startedAt).getTime() : undefined,
    pickupPhotoAt: ride.pickupPhotoAt ?? undefined,
    expiresAt: Date.now(),
    wave: 1,
  };
}

export type { ApiRide };
