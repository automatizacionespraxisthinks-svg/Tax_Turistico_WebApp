import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { users } from '../db/schema';
import { hashSecret } from '../common/crypto';

/**
 * Crea un usuario de la oficina (§8.1).
 *
 * Existe para no tener que sembrar el de ejemplo en producción. La
 * contraseña se genera aquí y se imprime una sola vez: en la base queda solo
 * el hash Argon2.
 *
 * El segundo factor NO se activa aquí. Lo da de alta la propia persona al
 * entrar al panel por primera vez, escaneando el QR con su teléfono, y hasta
 * que lo haga el servidor no le deja usar nada más. Así el secreto TOTP nunca
 * pasa por las manos de quien crea la cuenta.
 *
 *   node dist/cli/crear-usuario.js ana@taxturistico.co "Ana Gómez" administrador
 */

async function main(): Promise<void> {
  const [email, name, role = 'operador'] = process.argv.slice(2);

  if (!email || !name) {
    console.error('Uso: crear-usuario.js <correo> "<nombre>" [administrador|operador]');
    process.exitCode = 1;
    return;
  }
  if (role !== 'administrador' && role !== 'operador') {
    console.error(`Rol inválido: «${role}». Usa administrador u operador.`);
    process.exitCode = 1;
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');

  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);

  try {
    const correo = email.trim().toLowerCase();
    const [existe] = await db.select({ id: users.id }).from(users).where(eq(users.email, correo)).limit(1);
    if (existe) {
      console.error(`Ya existe un usuario con el correo ${correo}.`);
      process.exitCode = 1;
      return;
    }

    // Larga y aleatoria: se usa una sola vez, para el primer acceso.
    const password = randomBytes(18).toString('base64url');

    await db.insert(users).values({
      id: uuidv7(),
      email: correo,
      name,
      passwordHash: await hashSecret(password),
      role,
    });

    console.log(`\nUsuario creado: ${name} <${correo}> · ${role}`);
    console.log(`Contraseña (no se vuelve a mostrar):\n\n  ${password}\n`);
    console.log('Al entrar al panel le pedirá activar el segundo factor antes de nada.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Falló la creación:', error);
  process.exitCode = 1;
});
