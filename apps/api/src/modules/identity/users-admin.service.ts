import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq, isNull, and, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TEMP_PASSWORD_HOURS, isValidLogin, normalizeLogin } from '@tax/shared';
import { DB, type Database } from '../../db/db.module';
import { sessions, users } from '../../db/schema';
import { AppError } from '../../common/problem';
import { hashSecret } from '../../common/crypto';
import { loadEnv } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../fleet/fleet-admin.service';

/**
 * Cerrojo para contar y crear operadores en un solo paso. Sin él, dos
 * administradores creando a la vez el quinto verían los dos «hay 4» y
 * acabarían siendo seis.
 */
const CERROJO_OPERADORES = 4713_0002;

/** Larga y aleatoria: se usa una vez, para entrar y cambiarla. */
function claveTemporal(): { password: string; expiresAt: Date } {
  return {
    password: randomBytes(18).toString('base64url'),
    expiresAt: new Date(Date.now() + TEMP_PASSWORD_HOURS * 3600_000),
  };
}

/**
 * Usuarios de la oficina vistos desde el panel (§8.1).
 *
 * Ver quiénes son, dar de alta operadores, desactivarlos y generar una
 * contraseña nueva. La contraseña no se puede recuperar —en la base vive su
 * hash Argon2— así que «recuperar el acceso» siempre significa generar otra.
 *
 * Toda contraseña que se genera aquí es **temporal**: quien la genera la ve,
 * así que caduca a las 72 horas y la sesión que abre solo sirve para cambiarla.
 *
 * **Desde aquí solo se crean operadores, y el segundo factor no se toca.** Si
 * un administrador pudiera crear administradores, o reiniciar contraseña y
 * segundo factor de otro, podría acabar entrando en cuentas ajenas. Las dos
 * cosas se quedan en el terminal del servidor.
 */
@Injectable()
export class UsersAdminService {
  private readonly logger = new Logger(UsersAdminService.name);
  private readonly env = loadEnv();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Quiénes son, y cuántos operadores caben. Sin hashes ni secretos. */
  async list() {
    const filas = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        active: users.active,
        totpEnabled: users.totpEnabled,
        lastLoginAt: users.lastLoginAt,
        lockedUntil: users.lockedUntil,
        tempPasswordExpiresAt: users.tempPasswordExpiresAt,
      })
      .from(users)
      .orderBy(desc(users.active), desc(users.createdAt));

    const ahora = new Date();
    return {
      users: filas.map(({ lockedUntil, tempPasswordExpiresAt, ...u }) => ({
        ...u,
        locked: Boolean(lockedUntil && lockedUntil > ahora),
        // Si tiene una temporal sin cambiar, y si ya no le sirve: el panel
        // lo enseña para que nadie espere a alguien que no puede entrar.
        temporaryPassword: tempPasswordExpiresAt
          ? { expiresAt: tempPasswordExpiresAt, expired: tempPasswordExpiresAt <= ahora }
          : null,
      })),
      operators: {
        active: filas.filter((u) => u.role === 'operador' && u.active).length,
        max: this.env.MAX_OPERADORES,
      },
    };
  }

  /**
   * Da de alta un operador y devuelve su contraseña temporal, una sola vez.
   *
   * Solo operadores: un administrador creado desde el panel podría a su vez
   * reiniciar contraseñas ajenas, y esa puerta se queda en el terminal.
   */
  async create(
    input: { name: string; login: string },
    actor: AdminActor,
  ): Promise<{ id: string; login: string; password: string; expiresAt: Date }> {
    const login = normalizeLogin(input.login);
    if (!isValidLogin(login)) {
      throw new AppError('VALIDATION_FAILED', 'Usuario o correo no válido');
    }

    const { password, expiresAt } = claveTemporal();
    const passwordHash = await hashSecret(password);
    const id = uuidv7();

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${CERROJO_OPERADORES})`);

      const [existe] = await tx.select({ id: users.id }).from(users).where(eq(users.email, login)).limit(1);
      if (existe) throw new AppError('LOGIN_TAKEN', `Ya existe una cuenta con el usuario ${login}`);

      await this.comprobarCupo(tx as unknown as Database);

      await tx.insert(users).values({
        id,
        email: login,
        name: input.name.trim(),
        passwordHash,
        role: 'operador',
        tempPasswordExpiresAt: expiresAt,
      });

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: 'Creó un operador',
          entity: 'users',
          entityId: login,
          after: { name: input.name.trim(), role: 'operador' },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });

    this.logger.log({ login, actor: actor.name }, 'Operador creado');
    return { id, login, password, expiresAt };
  }

  /**
   * Desactiva o reactiva un operador.
   *
   * Desactivar libera su cupo y cierra sus sesiones al momento: es lo que se
   * hace cuando alguien deja la oficina. No se borra, porque su nombre sigue
   * en la bitácora y en las carreras que despachó.
   */
  async setActive(userId: string, active: boolean, actor: AdminActor): Promise<void> {
    if (userId === actor.id) {
      throw new AppError('FORBIDDEN', 'No puedes desactivar tu propia cuenta');
    }

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${CERROJO_OPERADORES})`);

      const [usuario] = await tx
        .select({ email: users.email, role: users.role, active: users.active })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!usuario) throw new AppError('NOT_FOUND', 'El usuario no existe');
      if (usuario.role !== 'operador') {
        throw new AppError('FORBIDDEN', 'Los administradores se gestionan desde el terminal del servidor');
      }
      if (usuario.active === active) return;

      if (active) await this.comprobarCupo(tx as unknown as Database);

      await tx.update(users).set({ active }).where(eq(users.id, userId));
      if (!active) {
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      }

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: active ? 'Reactivó un operador' : 'Desactivó un operador',
          entity: 'users',
          entityId: usuario.email,
          before: { active: usuario.active },
          after: { active },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });
  }

  /**
   * Genera una contraseña temporal nueva y la devuelve una sola vez.
   *
   * Cierra también las sesiones abiertas de esa persona. Si el motivo del
   * reinicio fuese una sospecha de acceso ajeno, dejar viva la sesión del
   * intruso haría inútil el cambio; y si solo la olvidó, no pierde nada
   * porque de todas formas no podía entrar.
   */
  async resetPassword(
    userId: string,
    actor: AdminActor,
  ): Promise<{ email: string; password: string; expiresAt: Date }> {
    const [usuario] = await this.db
      .select({ id: users.id, email: users.email, name: users.name, totpEnabled: users.totpEnabled })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!usuario) throw new AppError('NOT_FOUND', 'El usuario no existe');

    const { password, expiresAt } = claveTemporal();

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash: await hashSecret(password),
          tempPasswordExpiresAt: expiresAt,
          // Una contraseña nueva levanta el bloqueo por intentos fallidos:
          // si estaba bloqueado, lo más probable es que la hubiera olvidado.
          failedAttempts: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, userId));

      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: 'Reinició la contraseña de un usuario',
          entity: 'users',
          entityId: usuario.email,
          // Ni la contraseña ni su hash: la bitácora se lee.
          after: { segundoFactorIntacto: usuario.totpEnabled },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });

    this.logger.log({ email: usuario.email, actor: actor.name }, 'Contraseña reiniciada');
    return { email: usuario.email, password, expiresAt };
  }

  /** Dentro de la transacción y con el cerrojo ya tomado. */
  private async comprobarCupo(tx: Database): Promise<void> {
    const [{ activos }] = (
      await tx.execute<{ activos: number }>(
        sql`select count(*)::int as activos from users where role = 'operador' and active`,
      )
    ).rows as [{ activos: number }];

    if (activos >= this.env.MAX_OPERADORES) {
      throw new AppError(
        'OPERATOR_LIMIT_REACHED',
        `Ya hay ${activos} operadores activos, el máximo es ${this.env.MAX_OPERADORES}. Desactiva a alguien que ya no esté en la oficina para dar de alta a otro.`,
      );
    }
  }
}
