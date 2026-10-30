import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import {
  ROL_ADMINISTRADOR,
  cabeEn,
  claveDeRol,
  completarPermisos,
  esPermiso,
  permisosDelRol,
  type Permiso,
} from '@tax/shared';
import { DB, type Database } from '../../db/db.module';
import { roles, users } from '../../db/schema';
import { AppError } from '../../common/problem';
import { AuditService } from '../audit/audit.service';
import { IdentityService } from './identity.service';

/** Quien hace el cambio, con lo que su rol le deja hacer. */
export interface ActorConPermisos {
  id: string;
  name: string;
  role: string;
  permissions: readonly string[];
  ip?: string;
}

export interface RolConPoder {
  key: string;
  name: string;
  permisos: Permiso[];
}

/** El rol y sus permisos efectivos, o NOT_FOUND. */
export async function rolConPoder(db: Database, key: string): Promise<RolConPoder> {
  const [rol] = await db.select().from(roles).where(eq(roles.key, key)).limit(1);
  if (!rol) throw new AppError('NOT_FOUND', `El rol «${key}» no existe`);
  return { key: rol.key, name: rol.name, permisos: permisosDelRol(rol) };
}

/**
 * Roles y sus permisos desde el panel (RBAC, §8.1).
 *
 * Tres reglas sostienen todo lo demás:
 *
 *  1. **Nadie da lo que no tiene.** Un rol se crea o se edita solo con
 *     permisos que tiene quien lo hace, y no se toca un rol que tenga más que
 *     él. Sin esto, cualquiera con «Gestionar roles» se haría administrador.
 *  2. **El administrador no se edita.** Tiene todos los permisos, también los
 *     que se agreguen después. Si se pudiera recortar, la empresa podría
 *     quedarse sin nadie capaz de arreglarlo desde el panel.
 *  3. **Cambiar permisos pide el código del teléfono**, aunque la sesión esté
 *     abierta (`confirmarConSegundoFactor`).
 *
 * Tampoco se edita el rol propio: quitarse permisos a uno mismo es la forma
 * más rápida de quedarse fuera.
 */
@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  /** Los roles con cuántas personas los tienen, y qué puede hacer con ellos quien pregunta. */
  async list(actor: ActorConPermisos) {
    const filas = await this.db
      .select({
        key: roles.key,
        name: roles.name,
        description: roles.description,
        permissions: roles.permissions,
        system: roles.system,
        updatedAt: roles.updatedAt,
        usuarios: sql<number>`(select count(*)::int from users u where u.role = ${roles.key} and u.active)`,
        inactivos: sql<number>`(select count(*)::int from users u where u.role = ${roles.key} and not u.active)`,
      })
      .from(roles)
      // El administrador primero, luego el operador, luego los creados.
      .orderBy(sql`case ${roles.key} when ${ROL_ADMINISTRADOR} then 0 when 'operador' then 1 else 2 end`, asc(roles.name));

    return filas.map(({ permissions, inactivos, ...rol }) => {
      const permisos = permisosDelRol({ key: rol.key, permissions });
      const motivo = this.motivoParaNoEditar(rol.key, permisos, actor);
      return {
        ...rol,
        permissions: permisos,
        editable: motivo === null,
        motivoNoEditable: motivo,
        borrable: !rol.system && rol.usuarios + inactivos === 0,
      };
    });
  }

  async create(
    input: { name: string; description?: string; permissions: string[]; codigo?: string },
    actor: ActorConPermisos,
  ) {
    const key = claveDeRol(input.name);
    if (key.length < 3) throw new AppError('VALIDATION_FAILED', 'El nombre necesita al menos 3 letras o números');
    const permisos = this.validarPermisos(input.permissions, actor);

    await this.db.transaction(async (tx) => {
      const [existe] = await tx
        .select({ key: roles.key })
        .from(roles)
        .where(sql`${roles.key} = ${key} or lower(${roles.name}) = lower(${input.name.trim()})`)
        .limit(1);
      if (existe) throw new AppError('NAME_TAKEN', `Ya existe un rol llamado «${input.name.trim()}»`);

      await this.identity.confirmarConSegundoFactor(tx as unknown as Database, actor.id, input.codigo);

      await tx.insert(roles).values({
        key,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        permissions: permisos,
      });

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: 'Creó un rol',
          entity: 'roles',
          entityId: key,
          after: { nombre: input.name.trim(), permisos },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });

    this.logger.log({ key, actor: actor.name }, 'Rol creado');
    return { key };
  }

  /**
   * Cambia nombre, descripción o permisos. El código solo se pide si cambian
   * los permisos: renombrar no le da poder a nadie.
   */
  async update(
    key: string,
    input: { name?: string; description?: string; permissions?: string[]; codigo?: string },
    actor: ActorConPermisos,
  ) {
    await this.db.transaction(async (tx) => {
      const [rol] = await tx.select().from(roles).where(eq(roles.key, key)).for('update').limit(1);
      if (!rol) throw new AppError('NOT_FOUND', 'El rol no existe');

      const antes = permisosDelRol(rol);
      const motivo = this.motivoParaNoEditar(key, antes, actor);
      if (motivo) throw new AppError('FORBIDDEN', motivo);

      const nombre = input.name?.trim();
      if (nombre !== undefined && nombre !== rol.name) {
        if (rol.system) throw new AppError('FORBIDDEN', 'Los roles de base no se renombran');
        const [otro] = await tx
          .select({ key: roles.key })
          .from(roles)
          .where(sql`lower(${roles.name}) = lower(${nombre}) and ${roles.key} <> ${key}`)
          .limit(1);
        if (otro) throw new AppError('NAME_TAKEN', `Ya existe un rol llamado «${nombre}»`);
      }

      const despues = input.permissions ? this.validarPermisos(input.permissions, actor) : antes;
      const cambianPermisos = despues.join() !== antes.join();
      if (cambianPermisos) {
        await this.identity.confirmarConSegundoFactor(tx as unknown as Database, actor.id, input.codigo);
      }

      await tx
        .update(roles)
        .set({
          ...(nombre !== undefined ? { name: nombre } : {}),
          ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
          permissions: despues,
          updatedAt: new Date(),
        })
        .where(eq(roles.key, key));

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: cambianPermisos ? 'Cambió los permisos de un rol' : 'Editó un rol',
          entity: 'roles',
          entityId: key,
          before: { nombre: rol.name, permisos: antes },
          after: { nombre: nombre ?? rol.name, permisos: despues },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });

    this.logger.log({ key, actor: actor.name }, 'Rol editado');
  }

  /** Solo los creados en el panel, y sin nadie que lo tenga, ni siquiera desactivado. */
  async remove(key: string, actor: ActorConPermisos): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [rol] = await tx.select().from(roles).where(eq(roles.key, key)).for('update').limit(1);
      if (!rol) throw new AppError('NOT_FOUND', 'El rol no existe');
      if (rol.system) throw new AppError('FORBIDDEN', 'Los roles de base no se borran');

      const [{ cuantos }] = await tx
        .select({ cuantos: sql<number>`count(*)::int` })
        .from(users)
        .where(eq(users.role, key));
      if (cuantos > 0) {
        throw new AppError(
          'ROLE_IN_USE',
          `${cuantos === 1 ? 'Una persona tiene' : `${cuantos} personas tienen`} este rol, contando a las desactivadas: cámbiales el rol antes de borrarlo`,
        );
      }

      await tx.delete(roles).where(eq(roles.key, key));
      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: 'Borró un rol',
          entity: 'roles',
          entityId: key,
          before: { nombre: rol.name, permisos: permisosDelRol(rol) },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });
  }

  /** `null` si `actor` puede editar ese rol; si no, la razón en palabras. */
  private motivoParaNoEditar(key: string, permisos: readonly string[], actor: ActorConPermisos): string | null {
    if (key === ROL_ADMINISTRADOR) {
      return 'El administrador tiene todos los permisos y no se edita';
    }
    if (key === actor.role) return 'Es tu propio rol: otra persona tiene que cambiarlo';
    if (!cabeEn(permisos, actor.permissions)) return 'Tiene permisos que tu rol no tiene';
    return null;
  }

  /** Solo del catálogo, completos, y sin dar nada que el actor no tenga. */
  private validarPermisos(entrada: readonly string[], actor: ActorConPermisos): Permiso[] {
    const desconocido = entrada.find((p) => !esPermiso(p));
    if (desconocido) throw new AppError('VALIDATION_FAILED', `No existe el permiso «${desconocido}»`);

    const permisos = completarPermisos(entrada);
    if (!cabeEn(permisos, actor.permissions)) {
      throw new AppError('FORBIDDEN', 'No puedes dar permisos que tu rol no tiene');
    }
    return permisos;
  }
}
