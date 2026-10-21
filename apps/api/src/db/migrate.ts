import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * Aplica las migraciones pendientes.
 *
 * Se ejecuta antes de arrancar el contenedor nuevo. Las migraciones son
 * compatibles hacia atrás (expand/contract) para poder desplegar sin detener
 * la operación (§10.3): primero se añade, luego se usa, y solo en un
 * despliegue posterior se retira lo viejo.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');

  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);

  console.log('Aplicando migraciones…');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migraciones al día.');

  await pool.end();
}

main().catch((error: unknown) => {
  console.error('Fallo al migrar:', error);
  process.exitCode = 1;
});
