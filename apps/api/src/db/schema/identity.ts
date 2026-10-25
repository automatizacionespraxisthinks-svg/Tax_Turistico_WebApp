import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { userRole } from './enums';

/** Administradores y operadores: correo + contraseña Argon2id + TOTP (§8.1). */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    /**
     * El usuario de acceso: un correo o un nombre de usuario (`marcela.ruiz`),
     * siempre en minúsculas. Se llama `email` por historia; las reglas están
     * en `@tax/shared` (`isValidLogin`).
     */
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    /**
     * Si no es nulo, la contraseña actual la generó otra persona —al crear la
     * cuenta o al reiniciarla— y caduca en ese momento. Hasta cambiarla, la
     * sesión solo sirve para eso: quien la generó la ha visto, y una
     * contraseña que conocen dos no identifica a nadie.
     */
    tempPasswordExpiresAt: timestamp('temp_password_expires_at', { withTimezone: true }),
    role: userRole('role').notNull().default('operador'),
    /** Secreto TOTP cifrado; el 2FA es obligatorio para la oficina. */
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    /**
     * Último intervalo de 30 s aceptado. Dentro de su ventana un código vale
     * muchas veces, así que sin esto quien lo vea por encima del hombro
     * —o lo capture un proxy— puede usarlo hasta que caduque. Guardándolo,
     * cada código sirve exactamente una vez.
     */
    totpLastCounter: bigint('totp_last_counter', { mode: 'number' }),
    active: boolean('active').notNull().default(true),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_key').on(table.email)],
);

/** Sesión en cookie HttpOnly; expira a las 12 h (§8.1). */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sessions_token_key').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
  ],
);

/**
 * Códigos de respaldo del segundo factor (§8.1).
 *
 * Una oficina de taxis a las tres de la mañana con el celular roto no puede
 * quedarse fuera de su propio panel hasta que alguien aparezca. Son de un
 * solo uso y se guardan con el mismo Argon2 que las contraseñas: quien lea
 * la base no se lleva una llave de repuesto.
 */
export const userRecoveryCodes = pgTable(
  'user_recovery_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('user_recovery_codes_user_idx').on(table.userId)],
);

/**
 * Clave de API por integración (§7.1): hash Argon2 en base, rotable, con
 * ámbitos. Solo se acepta desde la red interna de Docker.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    /** Prefijo legible para identificar la clave sin revelarla. */
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    /** Secreto con el que se firman los webhooks salientes hacia esta
        integración (HMAC-SHA256, §7.1). */
    webhookSecret: text('webhook_secret'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('api_keys_prefix_key').on(table.prefix)],
);
