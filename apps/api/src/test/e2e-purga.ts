import 'dotenv/config';
import { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { MAINTENANCE_QUEUE, PURGE_POSITIONS_JOB } from '../modules/maintenance/retention.service';

/**
 * Purga del histórico de GPS con volumen real (§9.3).
 *
 * Lo que se comprueba no es solo que borre —eso es un `DELETE`— sino que
 * **no se note**: la razón de hacerlo por lotes con pausas es que una purga
 * de millones de filas no puede frenar el despacho de una carrera que esté
 * ocurriendo a esa hora.
 *
 * Así que la prueba siembra un atraso grande, mide la latencia de la API en
 * reposo, vuelve a medirla mientras la purga corre, y compara. Si la purga
 * generase picos, se vería aquí.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-purga.ts [filas]
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const FILAS = Number(process.argv[2] ?? 400_000);

function assert(condition: boolean, message: string, context?: unknown): void {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    if (context !== undefined) console.error('    ', JSON.stringify(context));
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

interface Latencias {
  muestras: number;
  p50: number;
  p95: number;
  max: number;
}

/**
 * Mide la latencia de un endpoint barato pero real, que toca la base.
 *
 * `/v1/zones` sirve: es lo que consulta el despacho para clasificar un punto,
 * así que si la purga bloquea la base, se nota aquí.
 */
async function medir(durationMs: number): Promise<Latencias> {
  const muestras: number[] = [];
  const hasta = Date.now() + durationMs;

  while (Date.now() < hasta) {
    const t0 = performance.now();
    try {
      await fetch(`${BASE}/v1/zones`);
    } catch {
      // Un fallo de red se cuenta como latencia pésima, no se ignora.
      muestras.push(10_000);
      continue;
    }
    muestras.push(performance.now() - t0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const ordenadas = [...muestras].sort((a, b) => a - b);
  const percentil = (p: number) => ordenadas[Math.min(ordenadas.length - 1, Math.floor(ordenadas.length * p))] ?? 0;

  return {
    muestras: muestras.length,
    p50: Math.round(percentil(0.5) * 10) / 10,
    p95: Math.round(percentil(0.95) * 10) / 10,
    max: Math.round(Math.max(...muestras, 0) * 10) / 10,
  };
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://tax:tax_dev_password@localhost:55432/tax',
    max: 4,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  const queue = new Queue(MAINTENANCE_QUEUE, {
    connection: { url: process.env.REDIS_URL ?? 'redis://localhost:56379' },
    prefix: 'tax:bull',
  });

  const contar = async (soloCaducadas = false) => {
    const result = await db.execute<{ n: string }>(
      soloCaducadas
        ? sql`select count(*)::text as n from driver_positions
               where recorded_at < now() - make_interval(days => 180)`
        : sql`select count(*)::text as n from driver_positions`,
    );
    return Number(result.rows[0]?.n ?? 0);
  };

  try {
    console.log(`1. Se siembra un atraso de ${FILAS.toLocaleString('es')} posiciones caducadas`);

    const [driver] = await db
      .select({ id: schema.drivers.id })
      .from(schema.drivers)
      .limit(1);
    assert(Boolean(driver), 'hay un conductor al que colgarlas');

    const antesDeSembrar = await contar();

    // `generate_series` siembra en la base: mandar 400.000 inserciones por la
    // red tardaría más que la propia prueba.
    const t0 = performance.now();
    await db.execute(sql`
      insert into driver_positions (id, driver_id, lat, lng, recorded_at)
      select
        gen_random_uuid(),
        ${driver!.id}::uuid,
        5.78 + random() / 100,
        -73.11 + random() / 100,
        -- Repartidas entre hace 7 meses y hace 6 meses y pico: todas caducadas.
        now() - make_interval(days => 185) - make_interval(secs => s * 10)
      from generate_series(1, ${FILAS}) as s
    `);
    const sembrado = Math.round(performance.now() - t0);

    const total = await contar();
    const caducadas = await contar(true);
    assert(
      total - antesDeSembrar === FILAS,
      `sembradas en ${(sembrado / 1000).toFixed(1)} s · ${total.toLocaleString('es')} filas en total`,
    );
    assert(caducadas >= FILAS, `${caducadas.toLocaleString('es')} están fuera del plazo de 180 días`);

    console.log('\n2. Latencia de la API en reposo');
    const reposo = await medir(6_000);
    console.log(`  p50 ${reposo.p50} ms · p95 ${reposo.p95} ms · max ${reposo.max} ms  (${reposo.muestras} muestras)`);

    console.log('\n3. Se lanza la purga y se mide mientras corre');
    const job = await queue.add(PURGE_POSITIONS_JOB, {}, { removeOnComplete: 5, removeOnFail: 5 });
    assert(Boolean(job.id), `trabajo encolado (${job.id})`);

    // Un momento para que el trabajador lo recoja y esté de verdad borrando.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const durante = await medir(15_000);
    console.log(`  p50 ${durante.p50} ms · p95 ${durante.p95} ms · max ${durante.max} ms  (${durante.muestras} muestras)`);

    const restantesDurante = await contar(true);
    assert(
      restantesDurante < caducadas,
      `va borrando: quedan ${restantesDurante.toLocaleString('es')} de ${caducadas.toLocaleString('es')}`,
    );

    console.log('\n4. El impacto en la API');
    /*
     * El umbral es deliberadamente generoso: lo que se busca no es que la
     * purga sea gratis, sino que no haya picos. Un p95 que se dispara a
     * segundos significaría que alguna consulta se quedó esperando un
     * bloqueo, que es exactamente lo que los lotes evitan.
     */
    assert(
      durante.p95 < 250,
      `el p95 se mantiene por debajo de 250 ms durante la purga (${durante.p95} ms)`,
    );
    assert(
      durante.max < 1_000,
      `ninguna petición se queda esperando: la peor fue ${durante.max} ms`,
    );
    console.log(
      `  referencia: p95 subió de ${reposo.p95} ms a ${durante.p95} ms (${
        reposo.p95 > 0 ? `${(durante.p95 / reposo.p95).toFixed(1)}×` : 'n/d'
      })`,
    );

    console.log('\n5. Termina el trabajo y queda constancia');
    let restantes = restantesDurante;
    for (let i = 0; i < 300 && restantes > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      restantes = await contar(true);
    }
    assert(restantes === 0, `no queda ninguna posición caducada (${restantes})`);

    /*
     * La bitácora se escribe cuando el bucle termina, y el bucle solo termina
     * tras un lote que devuelve 0: es decir, una pausa después de haber
     * borrado la última fila. Mirar en cuanto el contador llega a cero es
     * mirar dos segundos antes de tiempo.
     */
    let fila: { action: string; after: unknown } | undefined;
    for (let i = 0; i < 30 && !fila; i++) {
      const bitacora = await db.execute<{ action: string; after: unknown }>(sql`
        select action, after from audit_log
         where entity = 'driver_positions' and action = 'Borrado por retención'
           and at > now() - interval '10 minutes'
         order by seq desc limit 1
      `);
      fila = bitacora.rows[0];
      if (!fila) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert(Boolean(fila), 'la bitácora registró el borrado');

    const detalle = fila!.after as { filas: number; lotes: number; plazoDias: number };
    assert(detalle.filas > 0, `con ${detalle.filas.toLocaleString('es')} filas en ${detalle.lotes} lotes`);
    assert(detalle.plazoDias === 180, `y el plazo aplicado: ${detalle.plazoDias} días`);

    const vivas = await contar();
    assert(vivas === antesDeSembrar, `las posiciones dentro de plazo siguen ahí (${vivas})`);

    console.log('\nTodo correcto.\n');
  } finally {
    await queue.close();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('\nLa prueba falló:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
