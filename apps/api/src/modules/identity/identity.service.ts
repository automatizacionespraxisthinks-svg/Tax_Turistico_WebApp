import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, ne, or, gt } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DB, type Database } from '../../db/db.module';
import { apiKeys, driverDevices, drivers, rides, sessions, userRecoveryCodes, users } from '../../db/schema';
import { AppError } from '../../common/problem';
import {
  decryptColumn,
  encryptColumn,
  hashSecret,
  randomHex,
  randomToken,
  sha256Hex,
  verifySecret,
} from '../../common/crypto';
import { base32Decode, generateTotpSecret, otpauthUri, verifyTotp } from '../../common/totp';
import { loadEnv } from '../../config/env';
import { ACTIVE_RIDE_STATUSES, evaluatePassword, finDeSuspension, normalizeLogin, sigueSuspendido } from '@tax/shared';
import { AuditService } from '../audit/audit.service';

export interface ApiPrincipal {
  kind: 'integration';
  id: string;
  name: string;
  scopes: string[];
}

export interface UserPrincipal {
  kind: 'user';
  id: string;
  name: string;
  /** Lo necesita el panel para juzgar una contraseña nueva igual que aquí. */
  email: string;
  role: 'administrador' | 'operador';
  /** Si no, la sesión solo sirve para darlo de alta (§8.1). */
  totpEnabled: boolean;
  /**
   * Entró con una contraseña que generó otra persona. Hasta cambiarla, la
   * sesión solo sirve para eso (`AllowWithTemporaryPassword`).
   */
  mustChangePassword: boolean;
}

export interface DriverPrincipal {
  kind: 'driver';
  id: string;
  code: string;
  name: string;
  deviceId: string;
}

/**
 * Identidad y acceso (§8.1).
 *
 * Tres actores con mecanismos distintos y ninguna credencial compartida:
 *  - oficina: correo + contraseña Argon2id + TOTP, sesión en cookie;
 *  - conductor: código + placa + PIN, con el dispositivo registrado;
 *  - integración: clave de API con ámbitos, solo desde la red interna.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    // Por token explícito: `tsx`, con el que corren los comandos de `cli/`,
    // no emite los metadatos de tipos que Nest usa para inyectar.
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /* -------------------------------------------------------- claves de API */

  /**
   * Las claves tienen la forma `tax_<prefijo-hex>_<secreto>`. El prefijo
   * permite encontrar la fila sin verificar Argon2 contra toda la tabla, que
   * es lo que convertiría esto en una denegación de servicio trivial.
   *
   * El prefijo es hexadecimal a propósito: el secreto va en base64url, cuyo
   * alfabeto incluye `_`, así que solo se puede partir por los dos primeros
   * separadores y el resto es el secreto entero.
   */
  async verifyApiKey(presented: string): Promise<ApiPrincipal | null> {
    const match = /^tax_([0-9a-f]{8})_(.+)$/.exec(presented);
    if (!match) return null;
    const [, prefix, secret] = match as unknown as [string, string, string];

    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.prefix, prefix),
          isNull(apiKeys.revokedAt),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
        ),
      )
      .limit(1);

    if (!row) return null;
    if (!(await verifySecret(row.keyHash, secret))) return null;

    // No se espera a que termine: marcar el uso no puede frenar la petición.
    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.id))
      .catch((error: unknown) => this.logger.warn({ err: error }, 'No se pudo marcar el uso de la clave'));

    return { kind: 'integration', id: row.id, name: row.name, scopes: row.scopes };
  }

  /** Crea una clave y devuelve el secreto UNA sola vez: después solo el hash. */
  async createApiKey(name: string, scopes: string[]): Promise<{ id: string; key: string }> {
    const id = uuidv7();
    const prefix = randomHex(4);
    const secret = randomToken(32);

    await this.db.insert(apiKeys).values({
      id,
      name,
      prefix,
      keyHash: await hashSecret(secret),
      scopes,
      webhookSecret: randomToken(32),
    });

    return { id, key: `tax_${prefix}_${secret}` };
  }

  /* ---------------------------------------------------------- conductores */

  /**
   * Acceso del conductor: código + placa + PIN (§8.1).
   *
   * El código circula entre compañeros y la placa es pública, así que el PIN
   * es lo único que de verdad autentica. Se bloquea a los cinco intentos y
   * siempre se responde lo mismo, para no revelar si el código existe.
   */
  async loginDriver(
    code: string,
    plate: string,
    pin: string,
    deviceLabel: string,
    installId?: string,
  ): Promise<{ driver: DriverPrincipal; refreshToken: string }> {
    const [driver] = await this.db
      .select()
      .from(drivers)
      .where(and(eq(drivers.code, code), eq(drivers.active, true)))
      .limit(1);

    const invalid = new AppError('UNAUTHORIZED', 'Código, placa o PIN incorrectos');
    if (!driver) throw invalid;

    if (driver.lockedUntil && driver.lockedUntil > new Date()) {
      throw new AppError(
        'UNAUTHORIZED',
        'Acceso bloqueado por intentos fallidos. Llama a la oficina.',
      );
    }

    const ok = await verifySecret(driver.pinHash, pin);
    if (!ok) {
      const attempts = driver.failedAttempts + 1;
      await this.db
        .update(drivers)
        .set({
          failedAttempts: attempts,
          lockedUntil: attempts >= 5 ? new Date(Date.now() + 15 * 60_000) : null,
        })
        .where(eq(drivers.id, driver.id));
      throw invalid;
    }

    // La placa se valida contra el turno abierto en el módulo de Flota; aquí
    // solo se comprueba que venga, porque sin ella el acceso sería código+PIN.
    if (!plate || plate.trim().length < 5) throw invalid;

    // Después del PIN y no antes: decir «suspendido» a quien no lo tiene
    // revelaría que el código existe. Con el PIN correcto, en cambio, se le
    // dice hasta cuándo; un «PIN incorrecto» lo mandaría a pedir otro.
    if (sigueSuspendido(driver.suspendidoHasta)) {
      throw new AppError(
        'DRIVER_SUSPENDED',
        `Estás suspendido hasta el ${finDeSuspension(driver.suspendidoHasta!)}; para cualquier duda, llama a la oficina.`,
      );
    }

    const refreshToken = randomToken(32);
    let deviceId = uuidv7();

    await this.db.transaction(async (tx) => {
      await tx
        .update(drivers)
        .set({ failedAttempts: 0, lockedUntil: null })
        .where(eq(drivers.id, driver.id));

      // El mismo celular reutiliza su fila en vez de crear una nueva. Si no,
      // cada acceso dejaría un dispositivo vivo más y el conductor recibiría
      // la misma oferta repetida, una vez por acceso.
      const [existing] = installId
        ? await tx
            .select({ id: driverDevices.id })
            .from(driverDevices)
            .where(
              and(
                eq(driverDevices.driverId, driver.id),
                eq(driverDevices.installId, installId),
                isNull(driverDevices.revokedAt),
              ),
            )
            .limit(1)
        : [];

      if (existing) {
        deviceId = existing.id;
        // El token anterior deja de valer al sobrescribir el hash. La
        // suscripción de push se conserva: es el mismo navegador y sigue
        // siendo válida.
        await tx
          .update(driverDevices)
          .set({
            label: deviceLabel,
            refreshTokenHash: sha256Hex(refreshToken),
            lastSeenAt: new Date(),
          })
          .where(eq(driverDevices.id, deviceId));
      } else {
        await tx.insert(driverDevices).values({
          id: deviceId,
          driverId: driver.id,
          installId: installId ?? null,
          label: deviceLabel,
          refreshTokenHash: sha256Hex(refreshToken),
          lastSeenAt: new Date(),
        });
      }

      // Filas sin identificador: las dejó una versión anterior de la
      // aplicación, que creaba una por acceso. Se retiran cuando el conductor
      // entra desde una instalación que sí se identifica, porque si no
      // seguirían recibiendo avisos para siempre sin que nadie las mire.
      if (installId) {
        await tx
          .update(driverDevices)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(driverDevices.driverId, driver.id),
              isNull(driverDevices.installId),
              isNull(driverDevices.revokedAt),
            ),
          );
      }
    });

    return {
      driver: {
        kind: 'driver',
        id: driver.id,
        code: driver.code,
        name: driver.name,
        deviceId,
      },
      refreshToken,
    };
  }

  /** Resuelve el principal de un refresh token de conductor. */
  async resolveDriverToken(token: string): Promise<DriverPrincipal | null> {
    const [row] = await this.db
      .select({
        deviceId: driverDevices.id,
        driverId: drivers.id,
        code: drivers.code,
        name: drivers.name,
        active: drivers.active,
        suspendidoHasta: drivers.suspendidoHasta,
      })
      .from(driverDevices)
      .innerJoin(drivers, eq(drivers.id, driverDevices.driverId))
      .where(
        and(eq(driverDevices.refreshTokenHash, sha256Hex(token)), isNull(driverDevices.revokedAt)),
      )
      .limit(1);

    if (!row || !row.active) return null;

    /*
     * Un suspendido queda fuera de la PWA, salvo que tenga una carrera
     * andando: se la deja terminar, porque cortarle el acceso dejaría al
     * pasajero a mitad de camino y la carrera abierta para siempre. Al
     * cerrarla se le cierra también el turno, y la siguiente petición ya no
     * pasa. Solo se consulta para los suspendidos, que son pocos.
     */
    if (sigueSuspendido(row.suspendidoHasta)) {
      const [enCarrera] = await this.db
        .select({ id: rides.id })
        .from(rides)
        .where(and(eq(rides.driverId, row.driverId), inArray(rides.status, ACTIVE_RIDE_STATUSES)))
        .limit(1);
      if (!enCarrera) return null;
    }

    return {
      kind: 'driver',
      id: row.driverId,
      code: row.code,
      name: row.name,
      deviceId: row.deviceId,
    };
  }

  /* ------------------------------------------------------ Web Push */

  /**
   * Guarda la suscripción de push del dispositivo.
   *
   * Va en `driver_devices` y no en `drivers` porque un conductor puede tener
   * más de un celular, y porque revocar el dispositivo debe llevarse también
   * su canal de avisos: si no, un teléfono perdido seguiría recibiendo las
   * carreras de su dueño.
   */
  async savePushSubscription(deviceId: string, subscription: unknown): Promise<void> {
    await this.db
      .update(driverDevices)
      .set({ pushSubscription: JSON.stringify(subscription), lastSeenAt: new Date() })
      .where(eq(driverDevices.id, deviceId));
  }

  async clearPushSubscription(deviceId: string): Promise<void> {
    await this.db
      .update(driverDevices)
      .set({ pushSubscription: null })
      .where(eq(driverDevices.id, deviceId));
  }

  /** Dispositivos vivos de un conductor con push configurado. */
  async pushTargetsFor(driverId: string): Promise<{ deviceId: string; subscription: string }[]> {
    const rows = await this.db
      .select({ deviceId: driverDevices.id, subscription: driverDevices.pushSubscription })
      .from(driverDevices)
      .where(and(eq(driverDevices.driverId, driverId), isNull(driverDevices.revokedAt)));

    return rows
      .filter((row): row is { deviceId: string; subscription: string } => Boolean(row.subscription))
      .map((row) => ({ deviceId: row.deviceId, subscription: row.subscription }));
  }

  /** La oficina revoca un celular perdido (§8.1). */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.db
      .update(driverDevices)
      .set({ revokedAt: new Date() })
      .where(eq(driverDevices.id, deviceId));
  }

  /* -------------------------------------------------------------- oficina */

  async loginUser(
    email: string,
    password: string,
    secondFactor?: string,
    ip?: string,
    userAgent?: string,
  ): Promise<{ user: UserPrincipal; token: string; expiresAt: Date }> {
    const env = loadEnv();
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, normalizeLogin(email)), eq(users.active, true)))
      .limit(1);

    const invalid = new AppError('UNAUTHORIZED', 'Correo o contraseña incorrectos');
    if (!user) throw invalid;

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError('UNAUTHORIZED', 'Cuenta bloqueada por intentos fallidos');
    }

    if (!(await verifySecret(user.passwordHash, password))) {
      const attempts = user.failedAttempts + 1;
      await this.db
        .update(users)
        .set({
          failedAttempts: attempts,
          lockedUntil: attempts >= 5 ? new Date(Date.now() + 15 * 60_000) : null,
        })
        .where(eq(users.id, user.id));
      throw invalid;
    }

    // Después de comprobarla, no antes: decir «caducó» a quien no la sabe
    // revelaría que la cuenta existe y que tiene una temporal pendiente.
    if (user.tempPasswordExpiresAt && user.tempPasswordExpiresAt <= new Date()) {
      throw new AppError(
        'TEMP_PASSWORD_EXPIRED',
        'La contraseña temporal caducó: pide otra a un administrador',
      );
    }

    /*
     * Segundo factor (§8.1). Solo se exige si está activo: una cuenta recién
     * creada tiene que poder entrar una vez para darlo de alta, y el guardia
     * de sesión se encarga de que esa sesión no sirva para nada más.
     */
    let usedCounter: number | undefined;
    let usedRecoveryCodeId: string | undefined;

    if (user.totpEnabled) {
      if (!secondFactor) {
        throw new AppError('TOTP_REQUIRED', 'Escribe el código de tu aplicación de autenticación');
      }

      const check = await this.checkSecondFactor(user, secondFactor);
      if (!check.ok) {
        // Un código fallido cuenta igual que una contraseña fallida: seis
        // dígitos son uno entre un millón, pero mil intentos son gratis.
        const attempts = user.failedAttempts + 1;
        await this.db
          .update(users)
          .set({
            failedAttempts: attempts,
            lockedUntil: attempts >= 5 ? new Date(Date.now() + 15 * 60_000) : null,
          })
          .where(eq(users.id, user.id));
        throw new AppError('TOTP_INVALID', 'Código incorrecto o ya usado');
      }

      usedCounter = check.counter;
      usedRecoveryCodeId = check.recoveryCodeId;
    }

    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600_000);

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          failedAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
          // Quemar el intervalo va en la misma transacción que abrir la
          // sesión: si se hiciera después, dos accesos a la vez con el mismo
          // código entrarían los dos.
          ...(usedCounter != null ? { totpLastCounter: usedCounter } : {}),
        })
        .where(eq(users.id, user.id));

      if (usedRecoveryCodeId) {
        await tx
          .update(userRecoveryCodes)
          .set({ usedAt: new Date() })
          .where(eq(userRecoveryCodes.id, usedRecoveryCodeId));
      }

      await tx.insert(sessions).values({
        id: uuidv7(),
        userId: user.id,
        tokenHash: sha256Hex(token),
        ip,
        userAgent,
        expiresAt,
      });
    });

    if (usedRecoveryCodeId) {
      this.logger.warn(
        { userId: user.id },
        'Acceso con código de respaldo: el operador perdió su teléfono',
      );
    }

    return {
      user: {
        kind: 'user',
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        totpEnabled: user.totpEnabled,
        mustChangePassword: user.tempPasswordExpiresAt !== null,
      },
      token,
      expiresAt,
    };
  }

  async resolveSession(token: string): Promise<UserPrincipal | null> {
    const [row] = await this.db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        active: users.active,
        totpEnabled: users.totpEnabled,
        tempPasswordExpiresAt: users.tempPasswordExpiresAt,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, sha256Hex(token)))
      .limit(1);

    if (!row || !row.active || row.revokedAt || row.expiresAt <= new Date()) return null;
    return {
      kind: 'user',
      id: row.userId,
      name: row.name,
      email: row.email,
      role: row.role,
      totpEnabled: row.totpEnabled,
      mustChangePassword: row.tempPasswordExpiresAt !== null,
    };
  }

  async logout(token: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.tokenHash, sha256Hex(token)));
  }

  /* ------------------------------------------------- segundo factor --- */

  /**
   * Arranca el alta: genera el secreto y lo guarda cifrado, todavía inactivo.
   *
   * Se devuelve en claro una sola vez, que es cuando el teléfono lo escanea.
   * Queda inactivo a propósito: si se activara aquí, un QR mal escaneado
   * dejaría al operador fuera de su propio panel sin forma de volver.
   */
  async startTotpEnrollment(userId: string): Promise<{ secret: string; uri: string }> {
    const env = loadEnv();
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new AppError('NOT_FOUND', 'El usuario no existe');

    if (user.totpEnabled) {
      throw new AppError('FORBIDDEN', 'El segundo factor ya está activo en esta cuenta');
    }

    const secret = generateTotpSecret();
    await this.db
      .update(users)
      .set({ totpSecretEncrypted: encryptColumn(env.ENCRYPTION_KEY, secret) })
      .where(eq(users.id, userId));

    return { secret, uri: otpauthUri(user.email, secret) };
  }

  /**
   * Confirma el alta con un código del teléfono y entrega los de respaldo.
   *
   * Los códigos se devuelven una sola vez: en la base solo queda su hash, así
   * que no hay forma de volver a enseñarlos. Es incómodo a propósito.
   */
  async activateTotp(userId: string, code: string): Promise<string[]> {
    const env = loadEnv();
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new AppError('NOT_FOUND', 'El usuario no existe');

    if (user.totpEnabled) {
      throw new AppError('FORBIDDEN', 'El segundo factor ya está activo en esta cuenta');
    }
    if (!user.totpSecretEncrypted) {
      throw new AppError('TOTP_SETUP_REQUIRED', 'Primero hay que generar el secreto');
    }

    const secret = base32Decode(decryptColumn(env.ENCRYPTION_KEY, user.totpSecretEncrypted));
    const check = verifyTotp(secret, code);
    if (!check.valid) {
      throw new AppError('TOTP_INVALID', 'El código no coincide: revisa la hora del teléfono');
    }

    const codes = Array.from({ length: 10 }, () => recoveryCode());
    const hashed = await Promise.all(codes.map((plain) => hashSecret(plain)));

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpEnabled: true, totpLastCounter: check.counter ?? null })
        .where(eq(users.id, userId));

      // Un alta nueva invalida los códigos de la anterior: si no, un repuesto
      // de hace meses seguiría abriendo la puerta.
      await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
      await tx.insert(userRecoveryCodes).values(
        hashed.map((codeHash) => ({ id: uuidv7(), userId, codeHash })),
      );
    });

    this.logger.log({ userId }, 'Segundo factor activado');
    return codes;
  }

  /**
   * Comprueba el código del acceso: primero TOTP, y si no, uno de respaldo.
   *
   * Los de respaldo se recorren uno a uno porque Argon2 lleva su propia sal y
   * no se puede buscar por hash. Son diez verificaciones de unos 40 ms en el
   * peor caso, y solo en el camino de «perdí el teléfono», que es raro.
   */
  private async checkSecondFactor(
    user: typeof users.$inferSelect,
    presented: string,
  ): Promise<{ ok: boolean; counter?: number; recoveryCodeId?: string }> {
    const env = loadEnv();
    const code = presented.trim();

    if (/^\d{6}$/.test(code) && user.totpSecretEncrypted) {
      const secret = base32Decode(decryptColumn(env.ENCRYPTION_KEY, user.totpSecretEncrypted));
      const check = verifyTotp(secret, code, { lastCounter: user.totpLastCounter });
      if (check.valid) return { ok: true, counter: check.counter };
      // Sin return: un código de respaldo también puede tener seis dígitos si
      // alguien escribe solo una mitad, y no cuesta nada seguir mirando.
    }

    const pendientes = await this.db
      .select({ id: userRecoveryCodes.id, codeHash: userRecoveryCodes.codeHash })
      .from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, user.id), isNull(userRecoveryCodes.usedAt)));

    for (const candidate of pendientes) {
      if (await verifySecret(candidate.codeHash, code)) {
        return { ok: true, recoveryCodeId: candidate.id };
      }
    }

    return { ok: false };
  }

  /** Cuántos repuestos le quedan al operador, para avisarle cuando se acaban. */
  async recoveryCodesLeft(userId: string): Promise<number> {
    const rows = await this.db
      .select({ id: userRecoveryCodes.id })
      .from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
    return rows.length;
  }

  /**
   * El propio usuario cambia su contraseña (§8.1).
   *
   * Pide la actual, y eso no es burocracia: sin ello, cualquiera que se
   * siente ante una sesión abierta podría cambiarla y dejar fuera a su dueño.
   * Es la diferencia entre una sesión secuestrada durante doce horas y una
   * cuenta perdida.
   *
   * Cierra las demás sesiones de esa persona pero NO la actual: cerrarla
   * sería expulsarla justo después de hacer lo correcto.
   */
  async changeOwnPassword(
    userId: string,
    actual: string,
    nueva: string,
    tokenActual: string | undefined,
    ip?: string,
  ): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new AppError('NOT_FOUND', 'El usuario no existe');

    if (!(await verifySecret(user.passwordHash, actual))) {
      throw new AppError('UNAUTHORIZED', 'La contraseña actual no es correcta');
    }

    if (await verifySecret(user.passwordHash, nueva)) {
      throw new AppError('VALIDATION_FAILED', 'La contraseña nueva tiene que ser distinta de la actual');
    }

    // La misma política que juzga el panel: si divergieran, el operador
    // escribiría algo válido a sus ojos y el servidor lo rechazaría sin
    // explicar por qué.
    const veredicto = evaluatePassword(nueva, { email: user.email, name: user.name });
    if (!veredicto.ok) {
      throw new AppError('VALIDATION_FAILED', veredicto.problemas.join(' '));
    }

    const hashNuevo = await hashSecret(nueva);
    const hashSesionActual = tokenActual ? sha256Hex(tokenActual) : null;

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        // Elegida por su dueño: deja de ser temporal.
        .set({ passwordHash: hashNuevo, failedAttempts: 0, lockedUntil: null, tempPasswordExpiresAt: null })
        .where(eq(users.id, userId));

      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            ...(hashSesionActual ? [ne(sessions.tokenHash, hashSesionActual)] : []),
          ),
        );

      await this.audit.record(
        {
          actorId: user.id,
          actorName: user.name,
          role: user.role,
          action: user.tempPasswordExpiresAt
            ? 'Cambió su contraseña temporal por una propia'
            : 'Cambió su propia contraseña',
          entity: 'users',
          entityId: user.email,
          ip,
        },
        tx as unknown as Database,
      );
    });

    this.logger.log({ userId }, 'Contraseña cambiada por su dueño');
  }

  /** Secreto con el que se firman los webhooks de una integración (§7.1). */
  async webhookSecretFor(integrationName: string): Promise<string | null> {
    const [row] = await this.db
      .select({ secret: apiKeys.webhookSecret })
      .from(apiKeys)
      .where(and(eq(apiKeys.name, integrationName), isNull(apiKeys.revokedAt)))
      .limit(1);
    return row?.secret ?? null;
  }
}

/**
 * Código de respaldo: dos grupos de cinco, con el alfabeto de base32.
 *
 * Sin `0`, `1` ni `8`, porque esto se imprime o se copia a mano y confundir
 * un cero con una O cuando ya perdiste el teléfono sería el peor momento.
 * Cincuenta bits de entropía: no se adivina.
 */
function recoveryCode(): string {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = randomBytes(10);
  const chars = [...bytes].map((byte) => alfabeto[byte % alfabeto.length]);
  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}
