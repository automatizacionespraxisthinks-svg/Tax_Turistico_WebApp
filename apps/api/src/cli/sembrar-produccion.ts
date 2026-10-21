import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Database } from '../db/db.module';
import { sembrarTarifas, sembrarZonas } from '../db/datos-base';

/**
 * Datos mínimos para arrancar en producción: solo zonas y tarifas.
 *
 * Deliberadamente NO crea conductores, ni vehículos, ni usuarios, ni líneas
 * de WhatsApp. Ese es el trabajo de `seed.ts`, que siembra cinco conductores
 * con el PIN `4821` y una oficina con contraseña de ejemplo: perfecto para
 * desarrollar y un agujero de seguridad si toca la base real.
 *
 * Es idempotente: repetirlo no duplica nada.
 *
 *   # en el VPS, desde el terminal del contenedor
 *   node dist/cli/sembrar-produccion.js
 */

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');

  const pool = new Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool, { schema, casing: 'snake_case' }) as unknown as Database;

  try {
    const yaHabia = await db.execute<{ zonas: number; tarifas: number; conductores: number }>(sql`
      select
        (select count(*) from zones)::int as zonas,
        (select count(*) from fare_rules)::int as tarifas,
        (select count(*) from drivers)::int as conductores
    `);
    const antes = yaHabia.rows[0];

    console.log('Sembrando zonas de Paipa…');
    const zonas = await sembrarZonas(db);

    console.log('Sembrando tarifas vigentes…');
    const tarifas = await sembrarTarifas(db);

    const despues = await db.execute<{ zonas: number; tarifas: number }>(sql`
      select
        (select count(*) from zones)::int as zonas,
        (select count(*) from fare_rules)::int as tarifas
    `);
    const total = despues.rows[0];

    console.log(`\nListo.`);
    console.log(`  zonas   : ${total?.zonas ?? 0} en total (${zonas} definidas)`);
    console.log(`  tarifas : ${total?.tarifas ?? 0} en total (${tarifas} definidas)`);

    if ((antes?.conductores ?? 0) > 0) {
      console.log(
        `\n  Aviso: ya hay ${antes?.conductores} conductor(es) en la base. Si son los` +
          `\n  de ejemplo del sembrado de desarrollo, tienen PIN conocido: revísalos.`,
      );
    } else {
      console.log(`\n  No hay conductores: los da de alta la oficina, uno a uno.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Falló el sembrado:', error);
  process.exitCode = 1;
});
