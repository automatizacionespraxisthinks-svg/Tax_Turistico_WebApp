import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../db/schema';
import { hashSecret } from '../common/crypto';
import { base32Decode, totp } from '../common/totp';

/**
 * Gestión de conductores desde la oficina, de extremo a extremo (§6, §8.1).
 *
 * Comprueba lo que de verdad importa de esta funcionalidad: que un operador
 * NO pueda dar de alta ni revocar, que el PIN generado sirva para entrar a la
 * PWA, que revocar un celular lo deje fuera de inmediato, y que todo quede en
 * la bitácora. Crea sus propios usuarios y los borra al terminar.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-flota.ts
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const ADMIN = { email: 'prueba-admin@taxturistico.local', pass: 'clave-de-prueba-suficientemente-larga' };
const OPERADOR = { email: 'prueba-oper@taxturistico.local', pass: 'clave-de-prueba-suficientemente-larga' };
const CODIGO = '901';
const PLACA = 'PRB901';

function assert(condition: boolean, message: string, context?: unknown): void {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    if (context !== undefined) console.error('    ', JSON.stringify(context));
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

/** Cada sesión lleva su propia cookie: `fetch` no las guarda. */
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

const code = (p: unknown) => (p as { code?: string } | null)?.code;

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://tax:tax_dev_password@localhost:55432/tax',
    max: 2,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  const limpiar = async () => {
    const usuarios = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(inArray(schema.users.email, [ADMIN.email, OPERADOR.email]));
    for (const u of usuarios) {
      await db.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, u.id));
    }
    await db.delete(schema.users).where(inArray(schema.users.email, [ADMIN.email, OPERADOR.email]));

    const conductores = await db
      .select({ id: schema.drivers.id })
      .from(schema.drivers)
      .where(eq(schema.drivers.code, CODIGO));
    for (const c of conductores) {
      await db.delete(schema.driverDevices).where(eq(schema.driverDevices.driverId, c.id));
    }
    await db.delete(schema.drivers).where(eq(schema.drivers.code, CODIGO));
    await db.delete(schema.vehicles).where(eq(schema.vehicles.plate, PLACA));
  };

  /** Crea el usuario, entra y activa su segundo factor. Devuelve la sesión. */
  const entrarCon = async (quien: typeof ADMIN, rol: 'administrador' | 'operador') => {
    await db.insert(schema.users).values({
      id: uuidv7(),
      email: quien.email,
      name: rol === 'administrador' ? 'Admin de prueba' : 'Operador de prueba',
      passwordHash: await hashSecret(quien.pass),
      role: rol,
    });

    const s = crearSesion();
    const acceso = await s.call('/v1/auth/session', {
      method: 'POST',
      body: { email: quien.email, password: quien.pass },
    });
    assert(acceso.status < 400, `${rol} entra con contraseña`, acceso.body);

    const setup = await s.call('/v1/auth/totp/setup', { method: 'POST' });
    const { secret } = setup.body as { secret: string };
    const activar = await s.call('/v1/auth/totp/activate', {
      method: 'POST',
      body: { code: totp(base32Decode(secret)) },
    });
    assert(activar.status < 400, `${rol} activa su segundo factor`, activar.body);
    return s;
  };

  try {
    await limpiar();

    console.log('1. Un operador NO puede dar de alta conductores');
    const operador = await entrarCon(OPERADOR, 'operador');
    const intento = await operador.call('/v1/admin/drivers', {
      method: 'POST',
      body: { code: CODIGO, name: 'No Deberia Existir', phone: '+573110000901', plate: PLACA },
    });
    // Esto es lo que convierte el rol en algo real: el servidor cierra la
    // puerta, no la interfaz. Ocultar el botón no sería una barrera.
    assert(intento.status === 403, 'el servidor responde 403', intento.status);
    assert(code(intento.body) === 'FORBIDDEN', 'con FORBIDDEN', code(intento.body));

    const lectura = await operador.call('/v1/admin/drivers');
    assert(lectura.status < 400, 'pero sí puede ver la flota, que necesita para despachar');

    console.log('\n2. Un administrador da de alta');
    const admin = await entrarCon(ADMIN, 'administrador');
    const alta = await admin.call('/v1/admin/drivers', {
      method: 'POST',
      body: { code: CODIGO, name: 'Conductor De Prueba', phone: '+573110000901', plate: PLACA, vehicleType: 'sedan' },
    });
    assert(alta.status === 201, `creado (HTTP ${alta.status})`, alta.body);

    const { id: driverId, pin } = alta.body as { id: string; code: string; pin: string };
    assert(/^\d{4}$/.test(pin), 'devuelve un PIN de cuatro dígitos');

    const repetido = await admin.call('/v1/admin/drivers', {
      method: 'POST',
      body: { code: CODIGO, name: 'Otro', phone: '+573110000902', plate: 'PRB902' },
    });
    assert(code(repetido.body) === 'VALIDATION_FAILED', 'un código repetido se rechaza');

    console.log('\n3. El PIN generado sirve para entrar a la PWA');
    const accesoConductor = await fetch(`${BASE}/v1/auth/driver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: CODIGO, plate: PLACA, pin, device: 'prueba', install: 'prueba-flota' }),
    });
    const sesionConductor = (await accesoConductor.json()) as { token?: string };
    assert(Boolean(sesionConductor.token), 'el conductor entra con ese PIN');

    console.log('\n4. Revocar el celular lo deja fuera de inmediato');
    const dispositivos = await admin.call(`/v1/admin/drivers/${driverId}/devices`);
    const lista = dispositivos.body as { id: string; revokedAt: string | null }[];
    assert(lista.length === 1, `tiene ${lista.length} dispositivo registrado`);

    const revocar = await admin.call(`/v1/admin/drivers/devices/${lista[0]!.id}/revoke`, {
      method: 'POST',
    });
    assert(revocar.status === 204, 'la oficina lo revoca');

    const conTokenRevocado = await fetch(`${BASE}/v1/driver/rides/me`, {
      headers: { authorization: `Bearer ${sesionConductor.token}` },
    });
    assert(conTokenRevocado.status === 401, 'su token deja de valer en la siguiente petición');

    console.log('\n5. Reiniciar el PIN invalida el anterior');
    const nuevo = await admin.call(`/v1/admin/drivers/${driverId}/pin`, { method: 'POST' });
    const { pin: pinNuevo } = nuevo.body as { pin: string };
    assert(pinNuevo !== pin, 'genera uno distinto');

    const conViejo = await fetch(`${BASE}/v1/auth/driver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: CODIGO, plate: PLACA, pin, device: 'prueba' }),
    });
    assert(conViejo.status === 401, 'el PIN anterior ya no entra');

    console.log('\n6. Desactivar lo saca de las oleadas');
    const desactivar = await admin.call(`/v1/admin/drivers/${driverId}`, {
      method: 'PATCH',
      body: { active: false },
    });
    assert(desactivar.status === 204, 'queda desactivado');

    const [fila] = await db
      .select({ active: schema.drivers.active })
      .from(schema.drivers)
      .where(eq(schema.drivers.id, driverId));
    assert(fila?.active === false, 'y la base lo refleja');

    console.log('\n7. Todo quedó en la bitácora');
    const entradas = await db
      .select({ action: schema.auditLog.action, actorName: schema.auditLog.actorName })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, CODIGO));

    const acciones = entradas.map((e) => e.action);
    for (const esperada of [
      'Dio de alta un conductor',
      'Revocó un dispositivo',
      'Reinició el PIN de un conductor',
      'Desactivó un conductor',
    ]) {
      assert(acciones.includes(esperada), `registrado: «${esperada}»`);
    }
    assert(
      entradas.every((e) => e.actorName === 'Admin de prueba'),
      'con el nombre de quien lo hizo, no «sistema»',
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
