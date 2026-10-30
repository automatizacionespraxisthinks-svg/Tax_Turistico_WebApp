import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TEMP_PASSWORD_HOURS, isValidLogin, normalizeLogin } from '@tax/shared';
import { roles, users } from '../db/schema';
import { hashSecret } from '../common/crypto';

/**
 * Crea un usuario de la oficina (§8.1).
 *
 * Existe para no tener que sembrar el de ejemplo en producción, y para crear
 * el primer administrador: el panel solo lo deja hacer a otro administrador,
 * y con el código de su teléfono.
 * La contraseña se genera aquí, se imprime una sola vez y es temporal: caduca
 * a las 72 horas y al entrar hay que cambiarla.
 *
 * El usuario puede ser un correo o un nombre de usuario (`marcela.ruiz`).
 *
 * El segundo factor NO se activa aquí. Lo da de alta la propia persona al
 * entrar al panel por primera vez, escaneando el QR con su teléfono, y hasta
 * que lo haga el servidor no le deja usar nada más. Así el secreto TOTP nunca
 * pasa por las manos de quien crea la cuenta.
 *
 * El rol es la clave de cualquiera de los que hay (los de base, `administrador`
 * y `operador`, o uno creado en el panel).
 *
 *   node dist/cli/crear-usuario.js ana@taxturistico.co "Ana Gómez" administrador
 */

async function main(): Promise<void> {
  const [email, name, role = 'operador'] = process.argv.slice(2);

  if (!email || !name) {
    console.error('Uso: crear-usuario.js <correo-o-usuario> "<nombre>" [rol, por defecto operador]');
    process.exitCode = 1;
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');

  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);

  try {
    const [rol] = await db.select({ key: roles.key }).from(roles).where(eq(roles.key, role)).limit(1);
    if (!rol) {
      const hay = await db.select({ key: roles.key }).from(roles);
      console.error(`Rol inválido: «${role}». Los que hay: ${hay.map((r) => r.key).join(', ')}.`);
      process.exitCode = 1;
      return;
    }

    const correo = normalizeLogin(email);
    if (!isValidLogin(correo)) {
      console.error(`«${correo}» no es un correo ni un nombre de usuario válido.`);
      process.exitCode = 1;
      return;
    }
    const [existe] = await db.select({ id: users.id }).from(users).where(eq(users.email, correo)).limit(1);
    if (existe) {
      console.error(`Ya existe un usuario ${correo}.`);
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
      tempPasswordExpiresAt: new Date(Date.now() + TEMP_PASSWORD_HOURS * 3600_000),
    });

    console.log(`\nUsuario creado: ${name} <${correo}> · ${role}`);
    console.log(`Contraseña temporal (no se vuelve a mostrar, caduca en ${TEMP_PASSWORD_HOURS} h):\n\n  ${password}\n`);
    console.log('Al entrar al panel le pedirá cambiarla y después activar el segundo factor.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Falló la creación:', error);
  process.exitCode = 1;
});
