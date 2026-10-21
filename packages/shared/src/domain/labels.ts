import type { RideStatus, TransitionActor } from './ride';
import type { DriverStatus } from './driver';
import type { OutboxEventType, OutboxStatus, WahaSessionStatus } from './events';

export const RIDE_STATUS_LABEL: Record<RideStatus, string> = {
  PENDING: 'Pendiente',
  NOTIFIED: 'Notificada',
  ASSIGNED: 'Asignada',
  DRIVER_ARRIVED: 'Conductor en el sitio',
  IN_PROGRESS: 'En curso',
  COMPLETED: 'Finalizada',
  CANCELLED: 'Cancelada',
  UNASSIGNED: 'Sin asignar',
};

/**
 * Tono semántico de cada estado. Lo consume el sistema de diseño para elegir
 * color; ningún componente decide el color por su cuenta.
 */
export type StatusTone = 'neutral' | 'info' | 'accent' | 'progress' | 'positive' | 'warning' | 'critical';

export const RIDE_STATUS_TONE: Record<RideStatus, StatusTone> = {
  PENDING: 'neutral',
  NOTIFIED: 'warning',
  ASSIGNED: 'info',
  DRIVER_ARRIVED: 'accent',
  IN_PROGRESS: 'progress',
  COMPLETED: 'positive',
  CANCELLED: 'neutral',
  UNASSIGNED: 'critical',
};

export const DRIVER_STATUS_LABEL: Record<DriverStatus, string> = {
  OFF_SHIFT: 'Fuera de turno',
  AVAILABLE: 'Disponible',
  ON_RIDE: 'En carrera',
  PAUSED: 'En pausa',
};

export const DRIVER_STATUS_TONE: Record<DriverStatus, StatusTone> = {
  OFF_SHIFT: 'neutral',
  AVAILABLE: 'positive',
  ON_RIDE: 'progress',
  PAUSED: 'warning',
};

export const ACTOR_LABEL: Record<TransitionActor, string> = {
  system: 'Sistema',
  driver: 'Conductor',
  operator: 'Operador',
  customer: 'Cliente',
};

export const OUTBOX_EVENT_LABEL: Record<OutboxEventType, string> = {
  'ride.created': 'Carrera creada',
  'ride.assigned': 'Carrera asignada',
  'ride.reassigned': 'Carrera reasignada',
  'ride.eta_updated': 'ETA actualizado',
  'ride.driver_arrived': 'Conductor en el sitio',
  'ride.started': 'Carrera iniciada',
  'ride.completed': 'Carrera finalizada',
  'ride.cancelled': 'Carrera cancelada',
  'ride.no_driver': 'Sin conductor disponible',
};

export const OUTBOX_STATUS_LABEL: Record<OutboxStatus, string> = {
  pending: 'En cola',
  delivering: 'Entregando',
  delivered: 'Entregado',
  dead: 'Cola muerta',
};

export const OUTBOX_STATUS_TONE: Record<OutboxStatus, StatusTone> = {
  pending: 'neutral',
  delivering: 'info',
  delivered: 'positive',
  dead: 'critical',
};

export const WAHA_STATUS_LABEL: Record<WahaSessionStatus, string> = {
  working: 'Conectada',
  starting: 'Iniciando',
  scan_qr: 'Esperando QR',
  failed: 'Caída',
  stopped: 'Detenida',
};

export const WAHA_STATUS_TONE: Record<WahaSessionStatus, StatusTone> = {
  working: 'positive',
  starting: 'info',
  scan_qr: 'warning',
  failed: 'critical',
  stopped: 'neutral',
};
