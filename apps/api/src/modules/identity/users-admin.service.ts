import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq, isNull, and } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { sessions, users } from '../../db/schema';
import { AppError } from '../../common/problem';
import { hashSecret } from '../../common/crypto';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../fleet/fleet-admin.service';

/**
 * Usuarios de la oficina vistos desde el panel (§8.1).
 *
 * Solo dos operaciones: ver quiénes son y generar una contraseña nueva. La
 * contraseña no se puede recuperar —en la base vive su hash Argon2— así que
 * «recuperar el acceso» siempre significa generar otra.
 *
 * **El segundo factor NO se toca desde aquí, y es deliberado.** Si un
 * administrador pudiera reiniciar la contraseña Y el segundo factor de otro
 * administrador, podría entrar en su cuenta. Dejando el 2FA solo en el
 * terminal del servidor, un administrador puede ayudar a un compañero a
 * recuperar el acceso pero no suplantarlo.
 */
@Injectable()
export class UsersAdminService {
  private readonly logger = new Logger(UsersAdminService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Quiénes son. Sin hashes ni secretos: solo lo que la oficina necesita ver. */
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
      })
      .from(users)
      .orderBy(desc(users.createdAt));

    const ahora = new Date();
    return filas.map((u) => ({
      ...u,
      locked: Boolean(u.lockedUntil && u.lockedUntil > ahora),
      lockedUntil: undefined,
    }));
  }

  /**
   * Genera una contraseña nueva y la devuelve una sola vez.
   *
   * Cierra también las sesiones abiertas de esa persona. Si el motivo del
   * reinicio fuese una sospecha de acceso ajeno, dejar viva la sesión del
   * intruso haría inútil el cambio; y si solo la olvidó, no pierde nada
   * porque de todas formas no podía entrar.
   */
  async resetPassword(userId: string, actor: AdminActor): Promise<{ email: string; password: string }> {
    const [usuario] = await this.db
      .select({ id: users.id, email: users.email, name: users.name, totpEnabled: users.totpEnabled })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!usuario) throw new AppError('NOT_FOUND', 'El usuario no existe');

    const password = randomBytes(18).toString('base64url');

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash: await hashSecret(password),
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
    return { email: usuario.email, password };
  }
}
