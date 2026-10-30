import { pgEnum } from 'drizzle-orm/pg-core';
import {
  DRIVER_STATUSES,
  OUTBOX_EVENT_TYPES,
  RIDE_STATUSES,
  VEHICLE_TYPES,
  ZONE_KINDS,
} from '@tax/shared';

/**
 * Tipos enumerados de la base `tax`.
 *
 * Los valores se declaran aquí literalmente, no importados, para que el
 * esquema de la base sea autocontenido y `drizzle-kit` no dependa de que el
 * paquete compartido esté compilado. La igualdad con el dominio se verifica
 * en tiempo de compilación al final del archivo: si alguien añade un estado
 * en `@tax/shared` y olvida la migración, el build falla aquí.
 */

export const rideStatusValues = [
  'PENDING',
  'NOTIFIED',
  'ASSIGNED',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'UNASSIGNED',
] as const;

export const driverStatusValues = ['OFF_SHIFT', 'AVAILABLE', 'ON_RIDE', 'PAUSED'] as const;

export const vehicleTypeValues = ['sedan', 'camioneta', 'van'] as const;

export const zoneKindValues = ['urbano', 'rural', 'vereda', 'referencia'] as const;

export const transitionActorValues = ['system', 'driver', 'operator', 'customer'] as const;

export const offerResponseValues = [
  'pending',
  'accepted',
  'rejected',
  'expired',
  'revoked',
] as const;

export const outboxStatusValues = ['pending', 'delivering', 'delivered', 'dead'] as const;

export const outboxEventTypeValues = [
  'ride.created',
  'ride.assigned',
  'ride.reassigned',
  'ride.eta_updated',
  'ride.driver_arrived',
  'ride.started',
  'ride.completed',
  'ride.cancelled',
  'ride.no_driver',
  'waha.line_down',
  'waha.line_up',
] as const;

export const rideStatus = pgEnum('ride_status', rideStatusValues);
export const driverStatus = pgEnum('driver_status', driverStatusValues);
export const vehicleType = pgEnum('vehicle_type', vehicleTypeValues);
export const zoneKind = pgEnum('zone_kind', zoneKindValues);
export const transitionActor = pgEnum('transition_actor', transitionActorValues);
export const offerResponse = pgEnum('offer_response', offerResponseValues);
export const outboxStatus = pgEnum('outbox_status', outboxStatusValues);
export const outboxEventType = pgEnum('outbox_event_type', outboxEventTypeValues);

/* ------------------------------------------------------------------------- */
/* Verificación: los enumerados de la base y los del dominio son el mismo
   conjunto. Es puramente de tipos; no genera código. */

type SameSet<A extends readonly string[], B extends readonly string[]> =
  [Exclude<A[number], B[number]>] extends [never]
    ? [Exclude<B[number], A[number]>] extends [never]
      ? true
      : { faltaEnLaBase: Exclude<B[number], A[number]> }
    : { sobraEnLaBase: Exclude<A[number], B[number]> };

// Si alguna de estas líneas deja de ser `true`, hay una migración pendiente.
const _rideStatus: SameSet<typeof rideStatusValues, typeof RIDE_STATUSES> = true;
const _driverStatus: SameSet<typeof driverStatusValues, typeof DRIVER_STATUSES> = true;
const _vehicleType: SameSet<typeof vehicleTypeValues, typeof VEHICLE_TYPES> = true;
const _zoneKind: SameSet<typeof zoneKindValues, typeof ZONE_KINDS> = true;
const _outboxEventType: SameSet<typeof outboxEventTypeValues, typeof OUTBOX_EVENT_TYPES> = true;

void _rideStatus;
void _driverStatus;
void _vehicleType;
void _zoneKind;
void _outboxEventType;
