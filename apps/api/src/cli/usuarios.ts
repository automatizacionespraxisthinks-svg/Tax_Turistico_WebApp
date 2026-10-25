import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { TEMP_PASSWORD_HOURS } from '@tax/shared';
import { DB, DbModule, type Database } from '../db/db.module';
import { users, userRecoveryCodes } from '../db/schema';
import { hashSecret } from '../common/crypto';
import { AuditService } from '../modules/audit/audit.service';

/**
 * Usuarios de la oficina: listarlos y recuperar el acceso.
 *
 * Existe porque la contraseña NO se puede recuperar: en la base solo vive su
 * hash Argon2, y eso es deliberado. Lo que sí se puede es generar una nueva
 * desde el servidor, que es donde ya hay acceso total a la base de todas
 * formas; esto no abre ninguna puerta que no estuviera abierta, solo evita
 * tener que crear otro usuario y perder el segundo factor ya activado.
 *
 *   # ver quién hay (el correo no es secreto)
 *   node dist/cli/usuarios.js
 *
 *   # generar una contraseña nueva, conservando su segundo factor
 *   node dist/cli/usuarios.js ana@taxturistico.co
 *
 *   # además, obligarle a dar de alta el segundo factor otra vez
 *   # (para cuando también se perdió el teléfono y los códigos de respaldo)
 *   node dist/cli/usuarios.js ana@taxturistico.co --reiniciar-segundo-factor
 */

@Injectable()
class UsuariosCli {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async listar(): Promise<void> {
    const filas = await this.db
      .select({
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

    if (filas.length === 0) {
      console.log('No hay usuarios de oficina. Créalos con crear-usuario.js');
      return;
    }

    console.log(`\n${filas.length} usuario(s) de oficina:\n`);
    for (const u of filas) {
      const estado = [
        u.active ? 'activo' : 'INACTIVO',
        u.totpEnabled ? '2FA activo' : 'SIN 2FA',
        u.lockedUntil && u.lockedUntil > new Date() ? 'BLOQUEADO' : null,
      ]
        .filter(Boolean)
        .join(' · ');

      console.log(`  ${u.email}`);
      console.log(`    ${u.name} · ${u.role} · ${estado}`);
      console.log(
        `    último acceso: ${u.lastLoginAt ? u.lastLoginAt.toISOString().slice(0, 16).replace('T', ' ') : 'nunca'}\n`,
      );
    }
  }

  async reiniciarClave(correo: string, tambienSegundoFactor: boolean): Promise<void> {
    const email = correo.trim().toLowerCase();

    const [usuario] = await this.db
      .select({ id: users.id, name: users.name, role: users.role, totpEnabled: users.totpEnabled })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!usuario) {
      console.error(`No existe ningún usuario con el correo ${email}.`);
      console.error('Ejecuta el comando sin argumentos para ver los que hay.');
      process.exitCode = 1;
      return;
    }

    const password = randomBytes(18).toString('base64url');

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash: await hashSecret(password),
          // Una contraseña nueva levanta el bloqueo: si estaba bloqueado por
          // intentos fallidos, lo más probable es que la hubiera olvidado.
          failedAttempts: 0,
          lockedUntil: null,
          // Temporal: quien ejecuta el comando la ha visto.
          tempPasswordExpiresAt: new Date(Date.now() + TEMP_PASSWORD_HOURS * 3600_000),
          ...(tambienSegundoFactor
            ? { totpEnabled: false, totpSecretEncrypted: null, totpLastCounter: null }
            : {}),
        })
        .where(eq(users.id, usuario.id));

      if (tambienSegundoFactor) {
        // Los códigos de respaldo pertenecen al segundo factor anterior: si
        // se reinicia uno, los otros dejan de significar nada.
        await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, usuario.id));
      }

      await this.audit.record(
        {
          actorName: 'Terminal del servidor',
          role: 'system',
          action: tambienSegundoFactor
            ? 'Reinició la contraseña y el segundo factor'
            : 'Reinició la contraseña',
          entity: 'users',
          entityId: email,
        },
        tx as unknown as Database,
      );
    });

    console.log(`\nContraseña nueva para ${usuario.name} <${email}> · ${usuario.role}`);
    console.log(`Es temporal: no se vuelve a mostrar y caduca en ${TEMP_PASSWORD_HOURS} h.\n\n  ${password}\n`);
    console.log('Al entrar tendrá que cambiarla por una suya.');

    if (tambienSegundoFactor) {
      console.log('Su segundo factor quedó desactivado: al entrar tendrá que darlo de alta');
      console.log('otra vez y guardar códigos de respaldo nuevos.');
    } else if (usuario.totpEnabled) {
      console.log('Su segundo factor sigue activo: necesitará el código de su aplicación,');
      console.log('o uno de sus códigos de respaldo.');
    }
  }
}

/*
 * Se provee `AuditService` directamente en vez de importar `AuditModule`.
 *
 * Ese modulo trae consigo su controlador, el controlador usa `SessionGuard` y
 * el guardia necesita `IdentityService`: nada de eso tiene sentido en un
 * comando de terminal, y compilado hace que Nest falle al arrancar con
 * «can't resolve dependencies of the SessionGuard». El servicio por su cuenta
 * solo depende de la base.
 */
@Module({ imports: [DbModule], providers: [AuditService, UsuariosCli] })
class CliModule {}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tambienSegundoFactor = args.includes('--reiniciar-segundo-factor');
  const correo = args.find((a) => !a.startsWith('--'));

  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error'] });

  try {
    const cli = app.get(UsuariosCli);
    if (correo) await cli.reiniciarClave(correo, tambienSegundoFactor);
    else await cli.listar();
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('Falló:');
  console.error(error);
  process.exitCode = 1;
});
