import { z } from 'zod';
import { pointSchema } from './geo';

/**
 * Estados de la carrera (§5.3 de la arquitectura).
 * Los códigos coinciden con los valores de la columna `rides.status`
 * usados por el UPDATE atómico de exclusividad (§5.1).
 */
export const RIDE_STATUSES = [
  'PENDING',
  'NOTIFIED',
  'ASSIGNED',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'UNASSIGNED',
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

/** Estados en los que el conductor tiene la carrera tomada (índice único parcial, §5.1). */
export const ACTIVE_RIDE_STATUSES: RideStatus[] = ['ASSIGNED', 'DRIVER_ARRIVED', 'IN_PROGRESS'];

/** Estados terminales: ya no admiten transiciones. */
export const TERMINAL_RIDE_STATUSES: RideStatus[] = ['COMPLETED', 'CANCELLED'];

export type TransitionActor = 'system' | 'driver' | 'operator' | 'customer';

export interface RideTransition {
  from: RideStatus;
  to: RideStatus;
  /** Quién puede ejecutarla. */
  by: TransitionActor[];
  /** Condición de negocio, tal como la fija §5.3. */
  condition: string;
}

/**
 * Tabla de transiciones explícita (§5.3). Es la única fuente de verdad:
 * ninguna pantalla ofrece una acción que no esté aquí.
 */
export const RIDE_TRANSITIONS: RideTransition[] = [
  {
    from: 'PENDING',
    to: 'NOTIFIED',
    by: ['system'],
    condition: 'Hay al menos un candidato en la oleada',
  },
  {
    from: 'NOTIFIED',
    to: 'ASSIGNED',
    by: ['driver'],
    condition: 'UPDATE atómico exitoso',
  },
  {
    from: 'NOTIFIED',
    to: 'UNASSIGNED',
    by: ['system'],
    condition: 'Tres oleadas vencidas',
  },
  {
    /**
     * Añadida sobre la tabla de §5.3, que da por supuesto que la oleada 1
     * siempre encuentra a alguien. Cuando no hay ningún conductor disponible
     * —de madrugada, o en una vereda sin cobertura— la carrera nunca llega a
     * Notificada y se quedaría en Pendiente sin que nadie se entere. Tiene
     * que acabar igualmente en Sin asignar: la oficina se entera en segundos.
     */
    from: 'PENDING',
    to: 'UNASSIGNED',
    by: ['system'],
    condition: 'Ninguna oleada encontró candidatos',
  },
  {
    from: 'UNASSIGNED',
    to: 'NOTIFIED',
    by: ['operator'],
    condition: 'Relanzar despacho',
  },
  {
    from: 'UNASSIGNED',
    to: 'ASSIGNED',
    by: ['operator'],
    condition: 'Asignación manual',
  },
  {
    from: 'ASSIGNED',
    to: 'NOTIFIED',
    by: ['operator'],
    condition: 'Reasignación (RF-41): el conductor original queda liberado',
  },
  {
    from: 'ASSIGNED',
    to: 'DRIVER_ARRIVED',
    by: ['driver'],
    condition: 'A menos de 150 m del punto; si no, se registra la excepción',
  },
  {
    from: 'DRIVER_ARRIVED',
    to: 'IN_PROGRESS',
    by: ['driver'],
    condition: 'Pasajero a bordo',
  },
  {
    from: 'IN_PROGRESS',
    to: 'COMPLETED',
    by: ['driver'],
    condition: 'El conductor vuelve a Disponible',
  },
  {
    from: 'PENDING',
    to: 'CANCELLED',
    by: ['customer', 'operator', 'driver'],
    condition: 'Motivo obligatorio',
  },
  {
    from: 'NOTIFIED',
    to: 'CANCELLED',
    by: ['customer', 'operator', 'driver'],
    condition: 'Motivo obligatorio',
  },
  {
    from: 'UNASSIGNED',
    to: 'CANCELLED',
    by: ['customer', 'operator'],
    condition: 'Motivo obligatorio',
  },
  {
    from: 'ASSIGNED',
    to: 'CANCELLED',
    by: ['customer', 'operator', 'driver'],
    condition: 'Motivo obligatorio',
  },
  {
    from: 'DRIVER_ARRIVED',
    to: 'CANCELLED',
    by: ['customer', 'operator', 'driver'],
    condition: 'Motivo obligatorio',
  },
];

export function transitionsFrom(status: RideStatus, actor?: TransitionActor): RideTransition[] {
  return RIDE_TRANSITIONS.filter(
    (t) => t.from === status && (!actor || t.by.includes(actor)),
  );
}

export function canTransition(from: RideStatus, to: RideStatus, actor?: TransitionActor): boolean {
  return transitionsFrom(from, actor).some((t) => t.to === to);
}

/** Orden de progreso para animar avances y retrocesos del ciclo de vida. */
export const RIDE_PROGRESS_ORDER: RideStatus[] = [
  'PENDING',
  'NOTIFIED',
  'ASSIGNED',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
];

export function rideProgressIndex(status: RideStatus): number {
  const i = RIDE_PROGRESS_ORDER.indexOf(status);
  return i === -1 ? RIDE_PROGRESS_ORDER.length : i;
}

export const VEHICLE_TYPES = ['sedan', 'camioneta', 'van'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const rideAddressSchema = z.object({
  text: z.string().min(3, 'Escribe al menos 3 caracteres'),
  reference: z.string().optional(),
  point: pointSchema.optional(),
  placeId: z.string().optional(),
});
export type RideAddress = z.infer<typeof rideAddressSchema>;

export const createRideSchema = z.object({
  customerPhone: z
    .string()
    .regex(/^\+\d{8,15}$/, 'Teléfono en formato E.164, por ejemplo +573001234567'),
  customerName: z.string().min(2).optional(),
  pickup: rideAddressSchema,
  dropoff: rideAddressSchema.optional(),
  vehicleType: z.enum(VEHICLE_TYPES).default('sedan'),
  passengers: z.number().int().min(1).max(8).default(1),
  /**
   * El cliente va a pagar con pago electrónico (Nequi, transferencia,
   * datáfono). La carrera solo se les ofrece a conductores que lo aceptan;
   * si en las oleadas no aparece ninguno, queda «sin asignar» como cualquier
   * otra, sin abrirse a los demás. Sin el campo, efectivo.
   */
  pagoElectronico: z.boolean().default(false),
  notes: z.string().max(280).optional(),
  /**
   * Enlace a la foto del lugar que mandó el cliente (el `data_url` del
   * adjunto en Chatwoot). La API la descarga después de crear la carrera; si
   * falla, la carrera sigue adelante sin foto. También se puede mandar luego,
   * con `POST /v1/rides/:id/photo`.
   */
  pickupPhotoUrl: z.string().url().max(2000).optional(),
});
export type CreateRideInput = z.infer<typeof createRideSchema>;

export interface RideStatusEntry {
  from: RideStatus | null;
  to: RideStatus;
  actor: TransitionActor;
  actorName: string;
  at: string;
  note?: string;
}

/**
 * Las tres oleadas por radio, y una cuarta ronda que avisa a todos los
 * disponibles sin mirar distancia. La cuarta existe para probar los avisos
 * con pocos conductores y se apaga con `OLEADA_FINAL_A_TODOS=false`.
 */
export type Oleada = 1 | 2 | 3 | 4;
export const OLEADA_A_TODOS = 4 as const;

/**
 * Lo que hizo cada oleada, también las que no encontraron a nadie.
 *
 * Las ofertas solo cuentan las oleadas que tuvieron candidatos. Una que miró
 * en 1,5 km, no halló a nadie y escaló al instante no dejaba ningún rastro,
 * y desde el panel parecía que la carrera había saltado directamente a la
 * oleada 2 sin razón.
 */
export interface WaveLogEntry {
  wave: Oleada;
  /**
   * El lanzamiento al que pertenece: 1 al crear la carrera, y uno más por
   * cada «Relanzar». Ausente en las entradas anteriores a que existiera;
   * ahí cada oleada 1 marca el comienzo de un intento.
   */
  intento?: number;
  startedAt: string;
  /** Cuándo vence. Nulo si no encontró a nadie y escaló en el acto. */
  expiresAt: string | null;
  /** Radio de búsqueda. Nulo en la ronda a todos, que no mira distancia. */
  radiusKm: number | null;
  candidates: number;
  /**
   * Solo en la ronda a todos: conductores disponibles que no recibieron la
   * oferta porque nunca mandaron su posición. Sin esto el panel diría
   * «nadie disponible» con un conductor en turno, y parece un fallo.
   */
  sinGps?: number;
}

export interface RideOffer {
  driverId: string;
  driverName: string;
  wave: Oleada;
  /** El lanzamiento al que pertenece. Ver `WaveLogEntry.intento`. */
  intento: number;
  sentAt: string;
  expiresAt: string;
  etaMinutes: number;
  distanceKm: number;
  response: 'pending' | 'accepted' | 'rejected' | 'expired' | 'revoked';
}

export interface Ride {
  id: string;
  /** Código legible R-2026-004812 (§6). */
  code: string;
  status: RideStatus;
  /** Columna `version`: bloqueo optimista y orden de eventos hacia n8n (§7.1). */
  version: number;
  createdAt: string;
  customerPhone: string;
  customerName: string;
  customerId?: string;
  /** Teléfono del equipo de pruebas: Reportes puede dejar fuera sus carreras. */
  customerEsPrueba?: boolean;
  pickup: RideAddress;
  dropoff?: RideAddress;
  zoneId: string;
  vehicleType: VehicleType;
  passengers: number;
  /** Paga con pago electrónico; ausente o falso, en efectivo. */
  pagoElectronico?: boolean;
  /**
   * Lo que se recorrió, una vez conocido el destino. Ausente mientras la
   * carrera no ha terminado, y también después si el conductor cerró sin GPS.
   */
  distanceKm?: number;
  /** Quién puso el destino: el cliente al pedirla, o el conductor al cerrar. */
  dropoffSource?: 'cliente' | 'conductor';
  /** Cuándo llegó la foto del lugar que mandó el cliente; ausente si no hay. */
  pickupPhotoAt?: string;
  driverId?: string;
  line: string;
  chatwootConversationId?: number;
  etaMinutes?: number;
  notes?: string;
  history: RideStatusEntry[];
  offers: RideOffer[];
  /** Oleada de despacho en curso (§5.2). */
  wave?: Oleada;
  /** El recorrido completo de las oleadas, para seguirlo desde el panel. */
  waveLog?: WaveLogEntry[];
  cancelReason?: string;
}

/** Código legible de carrera: R-AAAA-NNNNNN. */
export function formatRideCode(year: number, sequence: number): string {
  return `R-${year}-${String(sequence).padStart(6, '0')}`;
}
