import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';
import { apiKeys } from '../db/schema';
import { hashSecret, randomHex, randomToken } from '../common/crypto';

/**
 * Emite una clave de API para una integración (§7.1).
 *
 * El secreto se imprime una sola vez: en la base queda solo el hash Argon2,
 * así que si se pierde hay que emitir otra. Se usa para dar de alta n8n en el
 * VPS y para las pruebas de extremo a extremo.
 *
 * Vive dentro de `src/` para que se compile a `dist/` y esté disponible en el
 * contenedor de producción, donde no hay `tsx`:
 *
 *   # en desarrollo
 *   pnpm --filter @tax/api exec tsx src/cli/crear-clave-api.ts n8n rides:write rides:read
 *
 *   # en el VPS, desde el terminal del contenedor
 *   node dist/cli/crear-clave-api.js n8n rides:write rides:read
 */

async function main(): Promise<void> {
  const [name, ...scopes] = process.argv.slice(2);
  if (!name) {
    console.error('Uso: crear-clave-api.ts <nombre> [ámbito...]');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://tax:tax_dev_password@localhost:55432/tax',
    max: 1,
  });
  const db = drizzle(pool, { casing: 'snake_case' });

  const prefix = randomHex(4);
  const secret = randomToken(32);

  await db.insert(apiKeys).values({
    id: uuidv7(),
    name,
    prefix,
    keyHash: await hashSecret(secret),
    scopes: scopes.length > 0 ? scopes : ['rides:write'],
    webhookSecret: randomToken(32),
  });

  await pool.end();

  console.log(`\nClave para «${name}» (no se vuelve a mostrar):\n`);
  console.log(`  tax_${prefix}_${secret}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
