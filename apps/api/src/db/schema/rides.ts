import { relations, sql } from 'drizzle-orm';
import type { WaveLogEntry } from '@tax/shared';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { drivers, vehicles } from './fleet';
import { bytea } from './bytea';
import { zones } from './geo';
import { offerResponse, rideStatus, transitionActor, vehicleType } from './enums';

/**
 * Secuencia del código legible R-2026-004812.
 *
 * Va en la base y no en el proceso: dos peticiones simultáneas no pueden
 * obtener el mismo número, y el contador sobrevive a los reinicios.
 */
export const rideCodeSeq = pgSequence('ride_code_seq', { startWith: 1, increment: 1 });

/** Una fila por número de WhatsApp (§6). */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey(),
    /** E.164. */
    phone: text('phone').notNull(),
    name: text('name'),
    /** Autorización previa, informada y verificable (Ley 1581): se guarda la
        versión de la política, la hora y el canal por el que se dio. */
    consentVersion: text('consent_version'),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    consentChannel: text('consent_channel'),
    lastLat: doublePrecision('last_lat'),
    lastLng: doublePrecision('last_lng'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /**
     * Un teléfono del equipo con el que se prueba el servicio. Sus carreras
     * no cuentan en Reportes con «No incluir pruebas»; se marca desde la
     * ficha de cualquiera de sus carreras y vale también para las de antes.
     */
    esPrueba: boolean('es_prueba').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('customers_phone_key').on(table.phone)],
);

export const rides = pgTable(
  'rides',
  {
    id: uuid('id').primaryKey(),
    /** Código legible R-2026-004812 (§6). */
    code: text('code').notNull(),
    status: rideStatus('status').notNull().default('PENDING'),
    /** Bloqueo optimista y orden de eventos hacia n8n: cada evento lleva este
        número y n8n descarta uno menor al ya procesado (§5.1, §7.1). */
    version: integer('version').notNull().default(1),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),

    pickupText: text('pickup_text').notNull(),
    pickupReference: text('pickup_reference'),
    pickupLat: doublePrecision('pickup_lat'),
    pickupLng: doublePrecision('pickup_lng'),
    /**
     * De donde salieron esas coordenadas.
     *
     * `compartida` es la ubicacion que mando el cliente por WhatsApp, exacta
     * al metro. `geocodificada` es una direccion en palabras que resolvio el
     * geocodificador, y esa puede quedarse en la calle sin el numero. Cuando
     * un conductor dice que el cliente no estaba ahi, esta columna es la
     * diferencia entre buscar el fallo en el GPS o en la direccion.
     */
    pickupSource: text('pickup_source').$type<'compartida' | 'geocodificada' | 'sin_ubicar'>(),
    dropoffText: text('dropoff_text'),
    dropoffLat: doublePrecision('dropoff_lat'),
    dropoffLng: doublePrecision('dropoff_lng'),
    /**
     * De donde salio el destino.
     *
     * Casi nadie lo dice por WhatsApp: lo dicen ya montados en el carro. Asi
     * que cuando el conductor marca finalizada, su posicion se guarda como
     * destino y queda `conductor`. Importa distinguirlos: una distancia
     * medida hasta donde el taxi realmente paro no es lo mismo que una
     * calculada contra una direccion que el cliente dicto por chat, y los
     * informes no deberian mezclarlas.
     */
    dropoffSource: text('dropoff_source').$type<'cliente' | 'conductor'>(),

    zoneId: uuid('zone_id').references(() => zones.id),
    vehicleType: vehicleType('vehicle_type').notNull().default('sedan'),
    passengers: integer('passengers').notNull().default(1),

    /** Pesos colombianos, sin decimales. Siempre «estimada» de cara al
        cliente (Ley 1480). */
    fareEstimate: integer('fare_estimate'),
    /** Versión de la regla con la que se calculó: una carrera conserva su
        tarifa aunque la tabla cambie después (§9.2). */
    fareRuleVersion: text('fare_rule_version'),
    /**
     * Distancia y tarifa calculadas al finalizar, con el destino ya conocido.
     *
     * No reemplazan a `fareEstimate`: esa es la que se le dijo al cliente
     * cuando pidio el taxi, y tiene que poder consultarse tal cual se
     * prometio. Estas dos son lo que resulto de verdad, para los informes.
     * Quedan en nulo si el conductor finalizo sin GPS.
     */
    distanceKm: doublePrecision('distance_km'),
    fareFinal: integer('fare_final'),

    driverId: uuid('driver_id').references(() => drivers.id),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),

    /** Línea de WhatsApp por la que entró. */
    line: text('line'),
    chatwootConversationId: integer('chatwoot_conversation_id'),
    /**
     * Cuándo llegó la foto del lugar que mandó el cliente; nulo si no hay.
     * La foto en sí va en `ride_photos`, para que listar carreras no arrastre
     * cientos de KB por fila.
     */
    pickupPhotoAt: timestamp('pickup_photo_at', { withTimezone: true }),

    etaMinutes: integer('eta_minutes'),
    notes: text('notes'),
    /** Oleada de despacho en curso (§5.2). */
    wave: integer('wave'),
    /**
     * Cada oleada que se lanzo, con su radio, su vencimiento y cuantos
     * conductores encontro. Las que no hallaron a nadie no dejan ofertas, y
     * sin esto el panel no podia contar que la carrera busco en 1,5 km,
     * no encontro a nadie y paso a la siguiente.
     */
    waveLog: jsonb('wave_log').$type<WaveLogEntry[]>().notNull().default([]),
    /**
     * Cuantas veces se lanzo el despacho: 1 al crearla, y uno mas por cada
     * «Relanzar» de la oficina. Las ofertas se cuentan por intento, para que
     * un relanzamiento pueda volver a contar con quien no contesto antes.
     */
    intentoDespacho: integer('intento_despacho').notNull().default(0),
    cancelReason: text('cancel_reason'),

    /**
     * El operador autorizó una segunda carrera simultánea para este cliente.
     * Sin esta marca, el índice parcial de más abajo la rechaza (§7.1).
     */
    allowsConcurrent: boolean('allows_concurrent').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('rides_code_key').on(table.code),
    index('rides_status_idx').on(table.status, table.createdAt),
    index('rides_driver_idx').on(table.driverId),
    index('rides_customer_idx').on(table.customerId, table.createdAt),

    /**
     * Respaldo estructural de la exclusividad (§5.1): un conductor no puede
     * tener dos carreras activas. Si la lógica de la app fallara, la base
     * rechaza igual la segunda.
     */
    uniqueIndex('one_active_ride_per_driver')
      .on(table.driverId)
      .where(sql`${table.status} in ('ASSIGNED','DRIVER_ARRIVED','IN_PROGRESS')`),

    /**
     * Una sola carrera viva por cliente (§7.1, RIDE_ALREADY_ACTIVE), salvo
     * que el operador lo autorice marcando `allows_concurrent`.
     */
    uniqueIndex('one_active_ride_per_customer')
      .on(table.customerId)
      .where(
        sql`${table.status} in ('PENDING','NOTIFIED','ASSIGNED','DRIVER_ARRIVED','IN_PROGRESS','UNASSIGNED') and ${table.allowsConcurrent} = false`,
      ),
  ],
);

/** Base de RF-44: tiempos de asignación y de recogida (§6). */
export const rideStatusHistory = pgTable(
  'ride_status_history',
  {
    id: uuid('id').primaryKey(),
    rideId: uuid('ride_id')
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    fromStatus: rideStatus('from_status'),
    toStatus: rideStatus('to_status').notNull(),
    actor: transitionActor('actor').notNull(),
    actorName: text('actor_name').notNull(),
    actorId: uuid('actor_id'),
    /** Dónde estaba quien hizo el cambio, cuando se sabe (§6: cada cambio con
        actor, hora y ubicación). */
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    note: text('note'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ride_status_history_ride_idx').on(table.rideId, table.at)],
);

/** Explica por qué un conductor recibió o no una carrera (§6). */
export const rideOffers = pgTable(
  'ride_offers',
  {
    id: uuid('id').primaryKey(),
    rideId: uuid('ride_id')
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id),
    wave: integer('wave').notNull(),
    /** El lanzamiento al que pertenece. Ver `rides.intentoDespacho`. */
    intento: integer('intento').notNull().default(1),
    distanceKm: doublePrecision('distance_km').notNull(),
    etaMinutes: integer('eta_minutes').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    response: offerResponse('response').notNull().default('pending'),
  },
  (table) => [
    index('ride_offers_ride_idx').on(table.rideId, table.wave),
    /* La consulta del UPDATE atómico busca por carrera + conductor vigente. */
    index('ride_offers_driver_open_idx').on(table.driverId, table.expiresAt),
    /*
     * Una oferta por conductor, oleada e INTENTO. Antes no llevaba el
     * intento, y al relanzar una carrera la ronda final intentaba ofrecersela
     * otra vez al mismo conductor en la misma oleada: el indice lo rechazaba
     * y el relanzamiento entero caia con un 500.
     */
    uniqueIndex('one_offer_per_driver_per_wave').on(
      table.rideId,
      table.driverId,
      table.wave,
      table.intento,
    ),
  ],
);

/** RF-11: historial de ediciones de dirección. */
export const rideAddressEdits = pgTable(
  'ride_address_edits',
  {
    id: uuid('id').primaryKey(),
    rideId: uuid('ride_id')
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    previousValue: text('previous_value'),
    newValue: text('new_value').notNull(),
    actor: transitionActor('actor').notNull(),
    actorName: text('actor_name').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ride_address_edits_ride_idx').on(table.rideId, table.at)],
);

/**
 * La foto del punto de recogida que manda el cliente por WhatsApp: la puerta,
 * la esquina, la tienda de al lado. Al conductor le dice en un vistazo lo que
 * una dirección de vereda no dice nunca.
 *
 * Una por carrera: si el cliente manda otra, reemplaza a la anterior. Se borra
 * a los 30 días (§9.3); puede verse la casa del cliente y no hace falta más.
 */
export const ridePhotos = pgTable('ride_photos', {
  rideId: uuid('ride_id')
    .primaryKey()
    .references(() => rides.id, { onDelete: 'cascade' }),
  content: bytea('content').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  /** De dónde salió: un enlace que la API descargó, o el archivo enviado tal cual. */
  source: text('source').$type<'enlace' | 'archivo'>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ridesRelations = relations(rides, ({ one, many }) => ({
  customer: one(customers, { fields: [rides.customerId], references: [customers.id] }),
  driver: one(drivers, { fields: [rides.driverId], references: [drivers.id] }),
  vehicle: one(vehicles, { fields: [rides.vehicleId], references: [vehicles.id] }),
  zone: one(zones, { fields: [rides.zoneId], references: [zones.id] }),
  history: many(rideStatusHistory),
  offers: many(rideOffers),
  addressEdits: many(rideAddressEdits),
}));

export const rideOffersRelations = relations(rideOffers, ({ one }) => ({
  ride: one(rides, { fields: [rideOffers.rideId], references: [rides.id] }),
  driver: one(drivers, { fields: [rideOffers.driverId], references: [drivers.id] }),
}));

export const rideStatusHistoryRelations = relations(rideStatusHistory, ({ one }) => ({
  ride: one(rides, { fields: [rideStatusHistory.rideId], references: [rides.id] }),
}));
