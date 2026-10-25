import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import { sql } from 'drizzle-orm';
import * as schema from './schema';
import type { Database } from './db.module';
import { sembrarTarifas, sembrarZonas } from './datos-base';
import { hashSecret, randomHex, randomToken } from '../common/crypto';

/**
 * Datos mínimos para arrancar en desarrollo: las zonas de Paipa, la tabla de
 * tarifas vigente, unos conductores y una clave de API para n8n.
 *
 * No es un volcado de producción: los conductores reales, sus PIN y las
 * tarifas autorizadas los carga la empresa.
 */

const DRIVERS = [
  { code: '101', name: 'Jairo Pérez Sánchez', plate: 'UBP472', type: 'sedan' as const },
  { code: '102', name: 'Luz Marina Cárdenas', plate: 'TQR118', type: 'sedan' as const },
  { code: '103', name: 'Héctor Buitrago Niño', plate: 'SVM903', type: 'sedan' as const },
  { code: '104', name: 'Gloria Rincón Mesa', plate: 'UZK240', type: 'camioneta' as const },
  { code: '105', name: 'Omar Parra Pinzón', plate: 'TJA556', type: 'van' as const },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');

  const pool = new Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  console.log('Sembrando zonas y tarifas…');
  // Compartidas con `cli/sembrar-produccion.ts`: una sola fuente de verdad,
  // para que lo que se prueba en desarrollo sea lo que corre en producción.
  await sembrarZonas(db as unknown as Database);
  await sembrarTarifas(db as unknown as Database);

  console.log('Sembrando flota…');
  // Un PIN de desarrollo, igual para todos. En producción cada conductor fija
  // el suyo en la vinculación y nunca se almacena en claro.
  const devPinHash = await hashSecret('4821');
  for (const driver of DRIVERS) {
    const vehicleId = uuidv7();
    await db
      .insert(schema.vehicles)
      .values({ id: vehicleId, plate: driver.plate, type: driver.type, capacity: 4 })
      .onConflictDoNothing();

    await db
      .insert(schema.drivers)
      .values({
        id: uuidv7(),
        code: driver.code,
        name: driver.name,
        phone: `+5731${driver.code}0000`,
        pinHash: devPinHash,
      })
      .onConflictDoNothing();
  }

  console.log('Creando usuario de oficina y clave de API…');
  await db
    .insert(schema.users)
    .values({
      id: uuidv7(),
      email: 'operadora@taxturistico.local',
      name: 'Marcela Ruiz',
      passwordHash: await hashSecret('desarrollo-no-usar-en-produccion'),
      role: 'operador',
    })
    .onConflictDoNothing();

  // Las líneas de WhatsApp ya no se siembran: las escribe el monitor a partir
  // de lo que dice WAHA. Unas inventadas aquí saldrían como caídas en cuanto
  // el monitor mirara, porque WAHA no las conoce.

  const prefix = randomHex(4);
  const secret = randomToken(32);
  await db
    .insert(schema.apiKeys)
    .values({
      id: uuidv7(),
      name: 'n8n',
      prefix,
      keyHash: await hashSecret(secret),
      scopes: ['rides:read', 'rides:write'],
      webhookSecret: randomToken(32),
    })
    .onConflictDoNothing();

  const zoneCount = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from zones`,
  );
  const count = zoneCount.rows[0]?.count ?? 0;

  console.log(`\nListo. Zonas: ${count}.`);
  console.log(`Clave de API para n8n (solo se muestra una vez):\n  tax_${prefix}_${secret}\n`);
  console.log('PIN de los conductores de desarrollo: 4821');

  await pool.end();
}

main().catch((error: unknown) => {
  console.error('Fallo al sembrar:', error);
  process.exitCode = 1;
});
