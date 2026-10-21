/**
 * Eventos del outbox hacia n8n (§7). Cada entrega lleva las cabeceras
 * X-Tax-Event-Id, X-Tax-Timestamp y X-Tax-Signature, y el consumidor
 * descarta un evento cuyo rideVersion sea menor al ya procesado.
 */
export const OUTBOX_EVENT_TYPES = [
  'ride.created',
  'ride.assigned',
  'ride.reassigned',
  'ride.eta_updated',
  'ride.driver_arrived',
  'ride.started',
  'ride.completed',
  'ride.cancelled',
  'ride.no_driver',
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export type OutboxStatus = 'pending' | 'delivering' | 'delivered' | 'dead';

export interface OutboxEvent {
  eventId: string;
  type: OutboxEventType;
  rideId: string;
  rideCode: string;
  rideVersion: number;
  createdAt: string;
  attempts: number;
  status: OutboxStatus;
  nextAttemptAt?: string;
  lastError?: string;
}

/** Backoff exponencial 1 s → 15 min, 10 intentos (§7.1). */
export function nextBackoffSeconds(attempt: number): number {
  return Math.min(900, 2 ** Math.max(0, attempt - 1));
}

/** Códigos de error estables que el agente sabe interpretar (RFC 9457, §7.1). */
export const API_ERROR_CODES = {
  MISSING_LOCATION: 'Falta la ubicación del punto de recogida',
  OUT_OF_COVERAGE: 'El punto está fuera del área de cobertura',
  RIDE_ALREADY_ACTIVE: 'El cliente ya tiene una carrera activa',
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_CODES;

/** Estado de cada línea de WhatsApp servida por WAHA (§9.1, §10.4). */
export type WahaSessionStatus = 'working' | 'starting' | 'scan_qr' | 'failed' | 'stopped';

export interface WahaSession {
  id: string;
  label: string;
  phone: string;
  status: WahaSessionStatus;
  lastCheckAt: string;
  messagesToday: number;
}
