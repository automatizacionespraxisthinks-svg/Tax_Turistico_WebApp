import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { driverStatus, vehicleType } from './enums';

/** Conductores. Datos personales de acceso restringido (§6). */
export const drivers = pgTable(
  'drivers',
  {
    id: uuid('id').primaryKey(),
    /** Código interno que el conductor usa para entrar; se enumera, así que
        va acompañado siempre de placa y PIN (§8.1). */
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Documento cifrado a nivel de aplicación: el disco del VPS no se
        puede cifrar en Hetzner Cloud (§8.2). */
    documentEncrypted: text('document_encrypted'),
    phone: text('phone').notNull(),
    pinHash: text('pin_hash').notNull(),
    status: driverStatus('status').notNull().default('OFF_SHIFT'),
    active: boolean('active').notNull().default(true),
    /** Intentos fallidos seguidos; a los 5 se bloquea el acceso (§8.1). */
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('drivers_code_key').on(table.code),
    index('drivers_status_idx').on(table.status),
  ],
);

export const vehicles = pgTable(
  'vehicles',
  {
    id: uuid('id').primaryKey(),
    plate: text('plate').notNull(),
    type: vehicleType('type').notNull().default('sedan'),
    capacity: integer('capacity').notNull().default(4),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('vehicles_plate_key').on(table.plate)],
);

/**
 * Turnos. La relación conductor-vehículo es por turno, no fija (§6), y el GPS
 * solo se registra dentro de un turno abierto (§9.2).
 */
export const driverShifts = pgTable(
  'driver_shifts',
  {
    id: uuid('id').primaryKey(),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    index('driver_shifts_driver_idx').on(table.driverId, table.startedAt),
    /* Un conductor no puede tener dos turnos abiertos a la vez. */
    uniqueIndex('one_open_shift_per_driver')
      .on(table.driverId)
      .where(sql`${table.endedAt} is null`),
    /* Ni dos conductores el mismo vehículo a la vez. */
    uniqueIndex('one_open_shift_per_vehicle')
      .on(table.vehicleId)
      .where(sql`${table.endedAt} is null`),
  ],
);

/**
 * Histórico de posiciones. La última posición vive en Redis; esto es el
 * registro, con muestreo de 30 s fuera de carrera y 10 s en carrera, y borrado
 * automático al cumplir el plazo de retención (§6, §9.3).
 */
export const driverPositions = pgTable(
  'driver_positions',
  {
    id: uuid('id').primaryKey(),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id),
    shiftId: uuid('shift_id').references(() => driverShifts.id),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    accuracyMeters: integer('accuracy_meters'),
    rideId: uuid('ride_id'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('driver_positions_recorded_idx').on(table.recordedAt),
    index('driver_positions_driver_idx').on(table.driverId, table.recordedAt),
  ],
);

/**
 * Dispositivos registrados. La oficina puede revocar un celular perdido y el
 * refresh token va ligado al dispositivo (§8.1).
 */
export const driverDevices = pgTable(
  'driver_devices',
  {
    id: uuid('id').primaryKey(),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id),
    label: text('label').notNull(),
    /**
     * Identificador que el celular se genera a sí mismo la primera vez y
     * guarda. Sin esto cada acceso crearía una fila nueva para el mismo
     * teléfono, y como los avisos se mandan a todos los dispositivos vivos
     * del conductor, acabaría recibiendo la misma oferta varias veces.
     *
     * No autentica nada: para llegar aquí hay que haber pasado el PIN. Solo
     * dice «soy la misma instalación de la otra vez».
     */
    installId: text('install_id'),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    pushSubscription: text('push_subscription'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('driver_devices_driver_idx').on(table.driverId),
    // Una instalación viva por conductor. Parcial: los dispositivos revocados
    // se quedan en la tabla como historial y no estorban a uno nuevo.
    uniqueIndex('one_live_device_per_install')
      .on(table.driverId, table.installId)
      .where(sql`${table.revokedAt} is null and ${table.installId} is not null`),
  ],
);

export const driversRelations = relations(drivers, ({ many }) => ({
  shifts: many(driverShifts),
  devices: many(driverDevices),
}));

export const driverShiftsRelations = relations(driverShifts, ({ one }) => ({
  driver: one(drivers, { fields: [driverShifts.driverId], references: [drivers.id] }),
  vehicle: one(vehicles, { fields: [driverShifts.vehicleId], references: [vehicles.id] }),
}));
