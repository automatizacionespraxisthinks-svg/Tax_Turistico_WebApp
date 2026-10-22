import type { Point } from './geo';
import type { VehicleType } from './ride';

export const DRIVER_STATUSES = ['OFF_SHIFT', 'AVAILABLE', 'ON_RIDE', 'PAUSED'] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export interface Vehicle {
  plate: string;
  type: VehicleType;
  capacity: number;
  active: boolean;
}

export interface Driver {
  id: string;
  /** Código interno del conductor; junto con placa y PIN forma el acceso (§8.1). */
  code: string;
  name: string;
  phone: string;
  status: DriverStatus;
  vehicle: Vehicle;
  /** Última posición conocida. Solo se registra con turno abierto (§9.2). */
  position?: Point;
  /** Antigüedad de la posición en segundos; >60 s descarta al candidato (§5.2). */
  positionAgeSeconds?: number;
  /** Si sigue trabajando. Un conductor inactivo no entra en ninguna oleada. */
  active: boolean;
  shiftStartedAt?: string;
  ridesToday: number;
  acceptanceRate: number;
  currentRideId?: string;
  deviceRegistered: boolean;
}

/** Un conductor es candidato solo si está disponible y su GPS es reciente (§5.2). */
export function isDispatchCandidate(driver: Driver, vehicleType: VehicleType): boolean {
  return (
    driver.status === 'AVAILABLE' &&
    driver.vehicle.active &&
    driver.vehicle.type === vehicleType &&
    driver.position !== undefined &&
    (driver.positionAgeSeconds ?? Number.POSITIVE_INFINITY) <= 60
  );
}
