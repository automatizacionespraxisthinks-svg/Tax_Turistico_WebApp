import 'dotenv/config';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';

const ejecutar = promisify(execFile);

/**
 * Los comandos de `cli/`, ejecutados COMPILADOS.
 *
 * Esta prueba existe por un fallo concreto: los comandos se probaron con
 * `tsx` y pasaron, pero `tsx` no emite los metadatos de decoradores, así que
 * Nest no veía las dependencias de los guardias y los instanciaba vacíos sin
 * protestar. Compilado sí las ve, y el comando moría al arrancar con
 * «can't resolve dependencies of the SessionGuard». Pasaban en desarrollo por
 * la razón equivocada y fallaban en el VPS, que es donde importan.
 *
 * Así que esto corre `node dist/cli/*.js`, exactamente como el contenedor.
 *
 *   pnpm --filter @tax/api exec nest build
 *   pnpm --filter @tax/api exec tsx src/test/e2e-cli.ts
 */

const DIST = join(__dirname, '../../dist/cli');
const CODIGO = '994';
const PLACA = 'CLI994';
const CORREO = 'prueba-cli@taxturistico.local';

function assert(condition: boolean, message: string, context?: unknown): void {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    if (context !== undefined) console.error('    ', String(context).slice(0, 500));
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

/** Lanza el comando y devuelve su salida; nunca lanza por código de salida. */
async function correr(archivo: string, args: string[] = []) {
  try {
    const { stdout, stderr } = await ejecutar('node', [join(DIST, archivo), ...args], {
      env: process.env,
      timeout: 60_000,
    });
    return { ok: true, salida: `${stdout}\n${stderr}` };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, salida: `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}` };
  }
}

/** Los errores de inyección de Nest son el fallo que esta prueba persigue. */
function sinErrorDeNest(salida: string): boolean {
  return (
    !salida.includes('UnknownDependenciesException') &&
    !salida.includes("can't resolve dependencies") &&
    !salida.includes('Nest can not find')
  );
}

async function main(): Promise<void> {
  if (!existsSync(DIST)) {
    console.error(`No existe ${DIST}. Compila primero: pnpm --filter @tax/api exec nest build`);
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://tax:tax_dev_password@localhost:55432/tax',
    max: 2,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  const limpiar = async () => {
    const conductores = await db
      .select({ id: schema.drivers.id })
      .from(schema.drivers)
      .where(eq(schema.drivers.code, CODIGO));
    for (const c of conductores) {
      await db.delete(schema.driverDevices).where(eq(schema.driverDevices.driverId, c.id));
    }
    await db.delete(schema.drivers).where(eq(schema.drivers.code, CODIGO));
    await db.delete(schema.vehicles).where(eq(schema.vehicles.plate, PLACA));
    await db.delete(schema.users).where(eq(schema.users.email, CORREO));
    await db.delete(schema.apiKeys).where(eq(schema.apiKeys.name, 'prueba-cli'));
  };

  try {
    await limpiar();

    console.log('1. sembrar-produccion.js');
    const sembrado = await correr('sembrar-produccion.js');
    assert(sinErrorDeNest(sembrado.salida), 'arranca sin errores de inyección', sembrado.salida);
    assert(sembrado.ok, 'termina bien', sembrado.salida);
    assert(sembrado.salida.includes('zonas'), 'y siembra las zonas');

    console.log('\n2. crear-clave-api.js');
    const clave = await correr('crear-clave-api.js', ['prueba-cli', 'rides:read']);
    assert(sinErrorDeNest(clave.salida), 'arranca sin errores de inyección', clave.salida);
    assert(clave.ok && /tax_[0-9a-f]{8}_/.test(clave.salida), 'emite una clave', clave.salida);

    console.log('\n3. crear-conductor.js  (levanta Nest)');
    const conductor = await correr('crear-conductor.js', [
      CODIGO,
      'Prueba CLI',
      '+573110000994',
      PLACA,
      'sedan',
    ]);
    // Este es el que fallaba: su módulo traía el controlador de auditoría y
    // con él un guardia que necesita media aplicación.
    assert(sinErrorDeNest(conductor.salida), 'arranca sin errores de inyección', conductor.salida);
    assert(conductor.ok, 'termina bien', conductor.salida);
    assert(/\n\s{2}\d{4}\n/.test(conductor.salida), 'imprime un PIN de cuatro dígitos');

    const [enBase] = await db
      .select({ code: schema.drivers.code })
      .from(schema.drivers)
      .where(eq(schema.drivers.code, CODIGO));
    assert(Boolean(enBase), 'y el conductor quedó en la base');

    console.log('\n4. crear-usuario.js');
    const usuario = await correr('crear-usuario.js', [CORREO, 'Prueba CLI', 'operador']);
    assert(sinErrorDeNest(usuario.salida), 'arranca sin errores de inyección', usuario.salida);
    assert(usuario.ok && usuario.salida.includes('Usuario creado'), 'crea el usuario', usuario.salida);

    console.log('\n5. usuarios.js  (levanta Nest)');
    const listado = await correr('usuarios.js');
    assert(sinErrorDeNest(listado.salida), 'arranca sin errores de inyección', listado.salida);
    assert(listado.ok && listado.salida.includes(CORREO), 'lista los usuarios', listado.salida);

    const reinicio = await correr('usuarios.js', [CORREO]);
    assert(sinErrorDeNest(reinicio.salida), 'el reinicio arranca igual', reinicio.salida);
    assert(
      reinicio.ok && reinicio.salida.includes('Contraseña nueva'),
      'y genera una contraseña',
      reinicio.salida,
    );

    console.log('\n6. Los argumentos equivocados no revientan');
    const sinArgs = await correr('crear-conductor.js');
    assert(sinErrorDeNest(sinArgs.salida), 'sin argumentos tampoco hay error de inyección');
    assert(sinArgs.salida.includes('Uso:'), 'explica cómo se usa');

    const inexistente = await correr('usuarios.js', ['no-existe@ejemplo.co']);
    assert(
      inexistente.salida.includes('No existe'),
      'un correo inexistente se explica, no se traga',
      inexistente.salida,
    );

    console.log('\nTodo correcto.\n');
  } finally {
    await limpiar();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('\nLa prueba falló:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
