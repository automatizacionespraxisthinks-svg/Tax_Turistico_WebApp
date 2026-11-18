import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../db/schema';
import { hashSecret } from '../common/crypto';
import { base32Decode, totp } from '../common/totp';

/**
 * Vehículos y vehículos permitidos desde la oficina, de extremo a extremo
 * (18/11/2026).
 *
 * Comprueba: que un operador no pueda dar de alta vehículos; que el alta del
 * conductor con vehículos elegidos lo deje vinculado; que solo abra turno en
 * ellos; que al quitarle el carro en el que está en turno se le cierre; que
 * un vehículo desactivado no se pueda tomar aunque esté permitido; y que todo
 * quede en la bitácora con quién lo hizo.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-vehiculos-permitidos.ts
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const ADMIN = { email: 'prueba-vp-admin@taxturistico.local', pass: 'clave-de-prueba-suficientemente-larga' };
const OPERADOR = { email: 'prueba-vp-oper@taxturistico.local', pass: 'clave-de-prueba-suficientemente-larga' };
const CODIGO = '905';
const PLACAS = ['PRV905', 'PRV906', 'PRV907'];

function assert(condition: boolean, message: string, context?: unknown): void {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    if (context !== undefined) console.error('    ', JSON.stringify(context));
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

function crearSesion() {
  let cookie: string | undefined;
  return {
    async call(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
      if (options.body) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;
      const response = await fetch(`${BASE}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const set = response.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
    },
  };
}

async function conductor(path: string, token: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const code = (p: unknown) => (p as { code?: string } | null)?.code;

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://tax:tax_dev_password@localhost:55432/tax',
    max: 2,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  const limpiar = async () => {
    const usuarios = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(inArray(schema.users.email, [ADMIN.email, OPERADOR.email]));
    for (const u of usuarios) await db.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, u.id));
    await db.delete(schema.users).where(inArray(schema.users.email, [ADMIN.email, OPERADOR.email]));
    const conductores = await db.select({ id: schema.drivers.id }).from(schema.drivers).where(eq(schema.drivers.code, CODIGO));
    for (const c of conductores) {
      await db.delete(schema.driverPositions).where(eq(schema.driverPositions.driverId, c.id));
      await db.delete(schema.driverShifts).where(eq(schema.driverShifts.driverId, c.id));
      await db.delete(schema.driverDevices).where(eq(schema.driverDevices.driverId, c.id));
    }
    await db.delete(schema.drivers).where(eq(schema.drivers.code, CODIGO));
    await db.delete(schema.vehicles).where(inArray(schema.vehicles.plate, PLACAS));
  };

  const entrarCon = async (quien: typeof ADMIN, rol: 'administrador' | 'operador') => {
    await db.insert(schema.users).values({
      id: uuidv7(),
      email: quien.email,
      name: rol === 'administrador' ? 'Admin de prueba' : 'Operador de prueba',
      passwordHash: await hashSecret(quien.pass),
      role: rol,
    });
    const s = crearSesion();
    const acceso = await s.call('/v1/auth/session', { method: 'POST', body: { email: quien.email, password: quien.pass } });
    assert(acceso.status < 400, `${rol} entra con contraseña`, acceso.body);
    const setup = await s.call('/v1/auth/totp/setup', { method: 'POST' });
    const { secret } = setup.body as { secret: string };
    const activar = await s.call('/v1/auth/totp/activate', { method: 'POST', body: { code: totp(base32Decode(secret)) } });
    assert(activar.status < 400, `${rol} activa su segundo factor`, activar.body);
    return s;
  };

  try {
    await limpiar();

    console.log('1. Vehículos: solo quien gestiona conductores los da de alta');
    const operador = await entrarCon(OPERADOR, 'operador');
    const intento = await operador.call('/v1/admin/vehicles', { method: 'POST', body: { plate: PLACAS[0], type: 'sedan' } });
    assert(intento.status === 403, 'un operador recibe 403', intento.status);

    const admin = await entrarCon(ADMIN, 'administrador');
    const ids: string[] = [];
    for (const [i, plate] of PLACAS.entries()) {
      const alta = await admin.call('/v1/admin/vehicles', {
        method: 'POST',
        body: { plate, internalNumber: `9${i}5`, type: 'sedan' },
      });
      assert(alta.status === 201, `alta de ${plate}`, alta.body);
      ids.push((alta.body as { id: string }).id);
    }
    const repetida = await admin.call('/v1/admin/vehicles', { method: 'POST', body: { plate: PLACAS[0], type: 'sedan' } });
    assert(code(repetida.body) === 'VALIDATION_FAILED', 'una placa repetida se rechaza');

    console.log('\n2. El alta del conductor elige sus vehículos');
    const sinVehiculos = await admin.call('/v1/admin/drivers', {
      method: 'POST',
      body: { code: CODIGO, name: 'Conductor De Prueba', phone: '+573110000905', vehicleIds: [] },
    });
    assert(sinVehiculos.status === 400, 'sin ningún vehículo se rechaza', sinVehiculos.body);
    const alta = await admin.call('/v1/admin/drivers', {
      method: 'POST',
      body: { code: CODIGO, name: 'Conductor De Prueba', phone: '+573110000905', vehicleIds: [ids[0], ids[1]] },
    });
    assert(alta.status === 201, 'alta con dos vehículos', alta.body);
    const { id: driverId, pin } = alta.body as { id: string; pin: string };
    const vinculos = await db
      .select({ origen: schema.vehicleDrivers.origen })
      .from(schema.vehicleDrivers)
      .where(eq(schema.vehicleDrivers.driverId, driverId));
    assert(vinculos.length === 2 && vinculos.every((v) => v.origen === 'panel'), 'quedan dos vínculos, asignados en el panel');

    console.log('\n3. Solo abre turno en sus vehículos');
    const entrada = await fetch(`${BASE}/v1/auth/driver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: CODIGO, pin, device: 'prueba', install: 'prueba-vp' }),
    });
    const { token } = (await entrada.json()) as { token: string };
    const ajeno = await conductor('/v1/driver/shift/open', token, { plate: PLACAS[2] });
    assert(ajeno.status === 403 && code(ajeno.body) === 'VEHICLE_NOT_ALLOWED', 'en uno no permitido: 403', ajeno.body);
    const propio = await conductor('/v1/driver/shift/open', token, { plate: PLACAS[0] });
    assert(propio.status < 400, `en uno permitido abre (HTTP ${propio.status})`, propio.body);

    console.log('\n4. Quitarle el carro en el que está en turno le cierra el turno');
    const fijar = await admin.call(`/v1/admin/drivers/${driverId}/vehicles`, { method: 'POST', body: { vehicleIds: [ids[1], ids[2]] } });
    assert(fijar.status < 400, 'la oficina cambia sus vehículos', fijar.body);
    const abiertos = await db
      .select({ id: schema.driverShifts.id })
      .from(schema.driverShifts)
      .where(and(eq(schema.driverShifts.driverId, driverId), isNull(schema.driverShifts.endedAt)));
    assert(abiertos.length === 0, 'su turno en el vehículo quitado quedó cerrado');
    const ahora = await conductor('/v1/driver/vehicles', token);
    const placas = (ahora.body as unknown as { plate: string }[]).map((v) => v.plate).sort();
    assert(placas.join(',') === [PLACAS[1], PLACAS[2]].sort().join(','), `la PWA ve los nuevos (${placas.join(', ')})`);

    console.log('\n5. Un vehículo desactivado no se toma aunque esté permitido');
    const desactivar = await admin.call(`/v1/admin/vehicles/${ids[2]}`, { method: 'PATCH', body: { active: false } });
    assert(desactivar.status === 204, 'la oficina lo desactiva');
    const inactivo = await conductor('/v1/driver/shift/open', token, { plate: PLACAS[2] });
    assert(inactivo.status === 404, `abrir turno en él falla (HTTP ${inactivo.status})`, inactivo.body);

    console.log('\n6. La bitácora');
    const entradas = await db
      .select({ action: schema.auditLog.action, actorName: schema.auditLog.actorName })
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.entityId, [CODIGO, ...PLACAS]));
    const acciones = entradas.map((e) => e.action);
    for (const esperada of [
      'Dio de alta un vehículo',
      'Dio de alta un conductor',
      'Cambió los vehículos permitidos de un conductor',
      'Desactivó un vehículo',
      `Intentó tomar el móvil ${PLACAS[2]}, que no tiene permitido`,
    ]) {
      assert(acciones.includes(esperada), `registrado: «${esperada}»`);
    }
    assert(
      entradas.filter((e) => e.action === 'Cambió los vehículos permitidos de un conductor').every((e) => e.actorName === 'Admin de prueba'),
      'con el nombre de quien lo hizo',
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
