import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq, isNull, and, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  ROL_ADMINISTRADOR,
  ROL_OPERADOR,
  TEMP_PASSWORD_HOURS,
  cabeEn,
  isValidLogin,
  normalizeLogin,
  permisosDelRol,
} from '@tax/shared';
import { DB, type Database } from '../../db/db.module';
import { roles, sessions, users } from '../../db/schema';
import { AppError } from '../../common/problem';
import { hashSecret } from '../../common/crypto';
import { loadEnv } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { IdentityService } from './identity.service';
import { rolConPoder, type ActorConPermisos } from './roles.service';

/**
 * Cerrojo para contar y crear usuarios en un solo paso. Sin él, dos
 * administradores creando a la vez el quinto verían los dos «hay 4» y
 * acabarían siendo seis. También ordena los cambios de rol: dos personas
 * quitándose el administrador una a otra a la vez podrían dejar la empresa
 * sin ninguno.
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
 * Ver quiénes son, darlos de alta con un rol, cambiárselo, desactivarlos y
 * generar una contraseña nueva. La contraseña no se puede recuperar —en la
 * base vive su hash Argon2— así que «recuperar el acceso» siempre significa
 * generar otra.
 *
 * Toda contraseña que se genera aquí es **temporal**: quien la genera la ve,
 * así que caduca a las 72 horas y la sesión que abre solo sirve para cambiarla.
 *
 * Las reglas que impiden subir de nivel:
 *
 *  - Solo se da un rol cuyos permisos tenga uno mismo, y solo se gestiona a
 *    quien no tenga más permisos que uno: un supervisor con «Gestionar
 *    usuarios» no puede reiniciarle la contraseña a un administrador.
 *  - Nadie se cambia el rol ni se desactiva a sí mismo.
 *  - Siempre queda al menos un administrador activo.
 *  - Dar un rol distinto del de operador pide el código del teléfono.
 *
 * **El segundo factor de otro no se toca desde aquí.** Reiniciar contraseña y
 * segundo factor a la vez permitiría entrar en la cuenta ajena; eso sigue en
 * el terminal del servidor.
 */
@Injectable()
export class UsersAdminService {
  private readonly logger = new Logger(UsersAdminService.name);
  private readonly env = loadEnv();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  /**
   * Quiénes son, qué roles hay para darles, y el cupo. Sin hashes ni
   * secretos. Dice también a quién puede gestionar quien pregunta, para que
   * el panel no enseñe botones que el servidor va a rechazar.
   */
  async list(actor: ActorConPermisos) {
    const [filas, todosLosRoles] = await Promise.all([
      this.db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          roleName: roles.name,
          rolePermissions: roles.permissions,
          active: users.active,
          totpEnabled: users.totpEnabled,
          lastLoginAt: users.lastLoginAt,
          lockedUntil: users.lockedUntil,
          tempPasswordExpiresAt: users.tempPasswordExpiresAt,
        })
        .from(users)
        .innerJoin(roles, eq(roles.key, users.role))
        .orderBy(desc(users.active), desc(users.createdAt)),
      this.db.select().from(roles),
    ]);

    const ahora = new Date();
    return {
      users: filas.map(({ lockedUntil, tempPasswordExpiresAt, rolePermissions, ...u }) => ({
        ...u,
        locked: Boolean(lockedUntil && lockedUntil > ahora),
        // Si tiene una temporal sin cambiar, y si ya no le sirve: el panel
        // lo enseña para que nadie espere a alguien que no puede entrar.
        temporaryPassword: tempPasswordExpiresAt
          ? { expiresAt: tempPasswordExpiresAt, expired: tempPasswordExpiresAt <= ahora }
          : null,
        gestionable:
          u.id !== actor.id && cabeEn(permisosDelRol({ key: u.role, permissions: rolePermissions }), actor.permissions),
      })),
      roles: todosLosRoles
        .map((r) => ({ key: r.key, name: r.name, description: r.description, permissions: permisosDelRol(r) }))
        .map((r) => ({ ...r, asignable: cabeEn(r.permissions, actor.permissions) }))
        .sort((a, b) => b.permissions.length - a.permissions.length || a.name.localeCompare(b.name, 'es')),
      // Los administradores no ocupan cupo: el cupo es de los puestos de la
      // oficina, y cualquier otro rol ocupa uno.
      cupo: {
        active: filas.filter((u) => u.role !== ROL_ADMINISTRADOR && u.active).length,
        max: this.env.MAX_OPERADORES,
      },
    };
  }

  /**
   * Da de alta a alguien con un rol y devuelve su contraseña temporal, una
   * sola vez. Con el rol de operador, como siempre; con otro, hay que
   * confirmar con el código del teléfono.
   */
  async create(
    input: { name: string; login: string; role?: string; codigo?: string },
    actor: ActorConPermisos,
  ): Promise<{ id: string; login: string; password: string; expiresAt: Date }> {
    const login = normalizeLogin(input.login);
    if (!isValidLogin(login)) {
      throw new AppError('VALIDATION_FAILED', 'Usuario o correo no válido');
    }
    const rolPedido = input.role ?? ROL_OPERADOR;

    const { password, expiresAt } = claveTemporal();
    const passwordHash = await hashSecret(password);
    const id = uuidv7();

    await this.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      await tx.execute(sql`select pg_advisory_xact_lock(${CERROJO_OPERADORES})`);

      const [existe] = await tx.select({ id: users.id }).from(users).where(eq(users.email, login)).limit(1);
      if (existe) throw new AppError('LOGIN_TAKEN', `Ya existe una cuenta con el usuario ${login}`);

      const rol = await rolConPoder(db, rolPedido);
      if (!cabeEn(rol.permisos, actor.permissions)) {
        throw new AppError('FORBIDDEN', `No puedes dar el rol «${rol.name}»: tiene permisos que tu rol no tiene`);
      }
      if (rol.key !== ROL_ADMINISTRADOR) await this.comprobarCupo(db);
      if (rol.key !== ROL_OPERADOR) await this.identity.confirmarConSegundoFactor(db, actor.id, input.codigo);

      await tx.insert(users).values({
        id,
        email: login,
        name: input.name.trim(),
        passwordHash,
        role: rol.key,
        tempPasswordExpiresAt: expiresAt,
      });

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: 'Creó un usuario',
          entity: 'users',
          entityId: login,
          after: { name: input.name.trim(), role: rol.key },
          ip: actor.ip,
        },
        db,
      );
    });

    this.logger.log({ login, role: rolPedido, actor: actor.name }, 'Usuario creado');
    return { id, login, password, expiresAt };
  }

  /**
   * Cambia el rol de alguien. Siempre pide el código del teléfono, también
   * para bajar de rol: es la misma puerta.
   *
   * Las sesiones de esa persona siguen abiertas: los permisos se leen del rol
   * en cada petición, así que el cambio vale desde la siguiente.
   */
  async cambiarRol(
    userId: string,
    input: { role: string; codigo?: string },
    actor: ActorConPermisos,
  ): Promise<void> {
    if (userId === actor.id) {
      throw new AppError('FORBIDDEN', 'No puedes cambiar tu propio rol: pídeselo a otro administrador');
    }

    await this.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      await tx.execute(sql`select pg_advisory_xact_lock(${CERROJO_OPERADORES})`);

      const usuario = await this.gestionable(db, userId, actor);
      const nuevo = await rolConPoder(db, input.role);
      if (nuevo.key === usuario.role) return;

      if (!cabeEn(nuevo.permisos, actor.permissions)) {
        throw new AppError('FORBIDDEN', `No puedes dar el rol «${nuevo.name}»: tiene permisos que tu rol no tiene`);
      }
      if (usuario.active && usuario.role === ROL_ADMINISTRADOR) {
        await this.comprobarQueQuedaAdministrador(db, userId);
        // Deja de ser administrador: pasa a ocupar un puesto.
        await this.comprobarCupo(db);
      }

      await this.identity.confirmarConSegundoFactor(db, actor.id, input.codigo);
      await tx.update(users).set({ role: nuevo.key }).where(eq(users.id, userId));

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: 'Cambió el rol de un usuario',
          entity: 'users',
          entityId: usuario.email,
          before: { role: usuario.role },
          after: { role: nuevo.key },
          ip: actor.ip,
        },
        db,
      );
    });

    this.logger.log({ userId, role: input.role, actor: actor.name }, 'Rol cambiado');
  }

  /**
   * Desactiva o reactiva a alguien.
   *
   * Desactivar libera su cupo y cierra sus sesiones al momento: es lo que se
   * hace cuando alguien deja la oficina. No se borra, porque su nombre sigue
   * en la bitácora y en las carreras que despachó.
   */
  async setActive(userId: string, active: boolean, actor: ActorConPermisos): Promise<void> {
    if (userId === actor.id) {
      throw new AppError('FORBIDDEN', 'No puedes desactivar tu propia cuenta');
    }

    await this.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      await tx.execute(sql`select pg_advisory_xact_lock(${CERROJO_OPERADORES})`);

      const usuario = await this.gestionable(db, userId, actor);
      if (usuario.active === active) return;

      if (usuario.role === ROL_ADMINISTRADOR) {
        if (!active) await this.comprobarQueQuedaAdministrador(db, userId);
      } else if (active) {
        await this.comprobarCupo(db);
      }

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
          action: active ? 'Reactivó un usuario' : 'Desactivó un usuario',
          entity: 'users',
          entityId: usuario.email,
          before: { active: usuario.active },
          after: { active },
          ip: actor.ip,
        },
        db,
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
    actor: ActorConPermisos,
  ): Promise<{ email: string; password: string; expiresAt: Date }> {
    // La propia sí: es lo mismo que cambiarla, solo que temporal.
    const usuario =
      userId === actor.id
        ? (await this.db.select().from(users).where(eq(users.id, userId)).limit(1))[0]!
        : await this.gestionable(this.db, userId, actor);

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

  /**
   * El usuario, si `actor` puede gestionarlo: que no tenga permisos que el
   * actor no tiene. Un supervisor no desactiva ni le reinicia la contraseña a
   * un administrador.
   */
  private async gestionable(db: Database, userId: string, actor: ActorConPermisos) {
    const [fila] = await db
      .select({ user: users, rol: roles })
      .from(users)
      .innerJoin(roles, eq(roles.key, users.role))
      .where(eq(users.id, userId))
      .limit(1);

    if (!fila) throw new AppError('NOT_FOUND', 'El usuario no existe');
    if (!cabeEn(permisosDelRol(fila.rol), actor.permissions)) {
      throw new AppError('FORBIDDEN', `${fila.user.name} tiene permisos que tu rol no tiene: no puedes gestionarlo`);
    }
    return fila.user;
  }

  /** Que quitarle el administrador a `userId` no deje la empresa sin ninguno. */
  private async comprobarQueQuedaAdministrador(db: Database, userId: string): Promise<void> {
    const [{ otros }] = (
      await db.execute<{ otros: number }>(
        sql`select count(*)::int as otros from users where role = ${ROL_ADMINISTRADOR} and active and id <> ${userId}`,
      )
    ).rows as [{ otros: number }];

    if (otros === 0) {
      throw new AppError('LAST_ADMIN', 'Es el único administrador activo: nombra a otro antes de quitarle el rol');
    }
  }

  /** Dentro de la transacción y con el cerrojo ya tomado. */
  private async comprobarCupo(db: Database): Promise<void> {
    const [{ activos }] = (
      await db.execute<{ activos: number }>(
        sql`select count(*)::int as activos from users where role <> ${ROL_ADMINISTRADOR} and active`,
      )
    ).rows as [{ activos: number }];

    if (activos >= this.env.MAX_OPERADORES) {
      throw new AppError(
        'OPERATOR_LIMIT_REACHED',
        `Ya hay ${activos} usuarios activos sin contar administradores, y el máximo es ${this.env.MAX_OPERADORES}. Desactiva a alguien que ya no esté en la oficina para dar de alta a otro.`,
      );
    }
  }
}
