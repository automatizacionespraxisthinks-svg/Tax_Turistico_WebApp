import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../db/schema';
import { hashSecret } from '../common/crypto';
import { base32Decode, totp } from '../common/totp';

/**
 * Eliminar conductores desde la oficina, de extremo a extremo (18/11/2026).
 *
 * Comprueba lo que importa: que un operador no pueda; que sin el código
 * escrito no se elimine; que un conductor sin historial se borre entero y
 * uno con historial se dé de baja conservando sus turnos pero sin sus datos
 * personales; que pierda el acceso al instante, desaparezca de Flota y su
 * código no se reasigne; y que la bitácora diga quién lo hizo y por qué.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-eliminar-conductor.ts
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const ADMIN = { email: 'prueba-elim-admin@taxturistico.local', pass: 'clave-de-prueba-suficientemente-larga' };
const OPERADOR = { email: 'prueba-elim-oper@taxturistico.local', pass: 'clave-de-prueba-suficientemente-larga' };
const SIN_HISTORIAL = { code: '903', plate: 'PRB903', phone: '+573110000903' };
const CON_HISTORIAL = { code: '904', plate: 'PRB904', phone: '+573110000904' };

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

const code = (p: unknown) => (p as { code?: string } | null)?.code;

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://tax:tax_dev_password@localhost:55432/tax',
    max: 2,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  const codigos = [SIN_HISTORIAL.code, CON_HISTORIAL.code];
  const placas = [SIN_HISTORIAL.plate, CON_HISTORIAL.plate];

  const limpiar = async () => {
    const usuarios = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(inArray(schema.users.email, [ADMIN.email, OPERADOR.email]));
    for (const u of usuarios) await db.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, u.id));
    await db.delete(schema.users).where(inArray(schema.users.email, [ADMIN.email, OPERADOR.email]));

    const conductores = await db
      .select({ id: schema.drivers.id })
      .from(schema.drivers)
      .where(inArray(schema.drivers.code, codigos));
    for (const c of conductores) {
      await db.delete(schema.driverPositions).where(eq(schema.driverPositions.driverId, c.id));
      await db.delete(schema.driverShifts).where(eq(schema.driverShifts.driverId, c.id));
      await db.delete(schema.driverDevices).where(eq(schema.driverDevices.driverId, c.id));
    }
    await db.delete(schema.drivers).where(inArray(schema.drivers.code, codigos));
    await db.delete(schema.vehicles).where(inArray(schema.vehicles.plate, placas));
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

    console.log('1. Preparación: dos conductores, uno de ellos con un turno');
    const admin = await entrarCon(ADMIN, 'administrador');
    const altas: Record<string, { id: string; pin: string }> = {};
    for (const c of [SIN_HISTORIAL, CON_HISTORIAL]) {
      const alta = await admin.call('/v1/admin/drivers', {
        method: 'POST',
        body: { code: c.code, name: `Conductor ${c.code}`, phone: c.phone, plate: c.plate, vehicleType: 'sedan' },
      });
      assert(alta.status === 201, `alta de ${c.code}`, alta.body);
      altas[c.code] = alta.body as { id: string; pin: string };
    }

    const entrada = await fetch(`${BASE}/v1/auth/driver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: CON_HISTORIAL.code,
        plate: CON_HISTORIAL.plate,
        pin: altas[CON_HISTORIAL.code]!.pin,
        device: 'prueba',
        install: 'prueba-eliminar',
      }),
    });
    const { token } = (await entrada.json()) as { token?: string };
    assert(Boolean(token), `${CON_HISTORIAL.code} entra a la PWA`);
    const turno = await fetch(`${BASE}/v1/driver/shift/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ plate: CON_HISTORIAL.plate }),
    });
    assert(turno.status < 400, `${CON_HISTORIAL.code} abre turno (ya tiene historial)`, turno.status);

    console.log('\n2. Un operador NO puede eliminar');
    const operador = await entrarCon(OPERADOR, 'operador');
    const intento = await operador.call(`/v1/admin/drivers/${altas[SIN_HISTORIAL.code]!.id}/eliminar`, {
      method: 'POST',
      body: { motivo: 'No debería poder', confirmacion: SIN_HISTORIAL.code },
    });
    assert(intento.status === 403, 'el servidor responde 403', intento.status);

    console.log('\n3. Sin el código bien escrito no se elimina');
    const malConfirmado = await admin.call(`/v1/admin/drivers/${altas[SIN_HISTORIAL.code]!.id}/eliminar`, {
      method: 'POST',
      body: { motivo: 'Se retiró de la empresa', confirmacion: '000' },
    });
    assert(code(malConfirmado.body) === 'VALIDATION_FAILED', 'con otro código se rechaza', malConfirmado.body);
    const sinMotivo = await admin.call(`/v1/admin/drivers/${altas[SIN_HISTORIAL.code]!.id}/eliminar`, {
      method: 'POST',
      body: { motivo: '', confirmacion: SIN_HISTORIAL.code },
    });
    assert(sinMotivo.status === 400, 'sin motivo se rechaza', sinMotivo.body);

    console.log('\n4. Sin historial se borra entero');
    const borrado = await admin.call(`/v1/admin/drivers/${altas[SIN_HISTORIAL.code]!.id}/eliminar`, {
      method: 'POST',
      body: { motivo: 'Alta duplicada por error', confirmacion: SIN_HISTORIAL.code },
    });
    assert(borrado.status < 400 && (borrado.body as { modo?: string }).modo === 'borrado', 'responde modo «borrado»', borrado.body);
    const [restos] = await db.select({ id: schema.drivers.id }).from(schema.drivers).where(eq(schema.drivers.code, SIN_HISTORIAL.code));
    assert(restos === undefined, 'la fila ya no existe');

    console.log('\n5. Con historial se da de baja y se borran sus datos');
    const idConHistorial = altas[CON_HISTORIAL.code]!.id;
    const baja = await admin.call(`/v1/admin/drivers/${idConHistorial}/eliminar`, {
      method: 'POST',
      body: { motivo: 'Se retiró de la empresa', confirmacion: CON_HISTORIAL.code },
    });
    assert(baja.status < 400 && (baja.body as { modo?: string }).modo === 'baja', 'responde modo «baja»', baja.body);

    const [fila] = await db.select().from(schema.drivers).where(eq(schema.drivers.id, idConHistorial));
    assert(Boolean(fila?.eliminadoAt), 'la fila se queda, marcada como eliminada');
    assert(fila?.name === `Conductor ${CON_HISTORIAL.code}` && fila?.code === CON_HISTORIAL.code, 'conserva nombre y código');
    assert(fila?.phone === null && fila?.documentEncrypted === null && fila?.documentHash === null, 'sin teléfono ni cédula');
    assert(fila?.active === false && fila?.status === 'OFF_SHIFT', 'inactivo y fuera de turno');

    const turnos = await db.select().from(schema.driverShifts).where(eq(schema.driverShifts.driverId, idConHistorial));
    assert(turnos.length === 1 && turnos[0]!.endedAt !== null, 'su turno se conserva, ya cerrado');

    const vivos = await db
      .select({ id: schema.driverDevices.id, revokedAt: schema.driverDevices.revokedAt })
      .from(schema.driverDevices)
      .where(eq(schema.driverDevices.driverId, idConHistorial));
    assert(vivos.length > 0 && vivos.every((d) => d.revokedAt !== null), 'sus celulares quedaron revocados');

    console.log('\n6. Pierde el acceso y desaparece de Flota');
    const conToken = await fetch(`${BASE}/v1/driver/rides/me`, { headers: { authorization: `Bearer ${token}` } });
    assert(conToken.status === 401, 'su token deja de valer');
    const reentrar = await fetch(`${BASE}/v1/auth/driver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: CON_HISTORIAL.code, plate: CON_HISTORIAL.plate, pin: altas[CON_HISTORIAL.code]!.pin, device: 'prueba' }),
    });
    assert(reentrar.status === 401, 'con su PIN de antes ya no entra');

    const flota = await admin.call('/v1/admin/drivers');
    const enFlota = (flota.body as { code: string }[]).some((d) => d.code === CON_HISTORIAL.code);
    assert(!enFlota, 'no aparece en Flota');

    console.log('\n7. No se puede reactivar ni reusar su código');
    const reactivar = await admin.call(`/v1/admin/drivers/${idConHistorial}`, { method: 'PATCH', body: { active: true } });
    assert(code(reactivar.body) === 'VALIDATION_FAILED', 'reactivarlo se rechaza', reactivar.body);
    const otraVez = await admin.call(`/v1/admin/drivers/${idConHistorial}/eliminar`, {
      method: 'POST',
      body: { motivo: 'Otra vez', confirmacion: CON_HISTORIAL.code },
    });
    assert(code(otraVez.body) === 'VALIDATION_FAILED', 'eliminarlo dos veces se rechaza');
    const reuso = await admin.call('/v1/admin/drivers', {
      method: 'POST',
      body: { code: CON_HISTORIAL.code, name: 'Otra Persona', phone: '+573110000999', plate: CON_HISTORIAL.plate },
    });
    assert(code(reuso.body) === 'VALIDATION_FAILED', 'su código no se asigna a otro', reuso.body);

    console.log('\n8. La bitácora dice quién, cuándo y por qué');
    const entradas = await db
      .select({ actorName: schema.auditLog.actorName, after: schema.auditLog.after, at: schema.auditLog.at })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'Eliminó un conductor'), inArray(schema.auditLog.entityId, codigos)));
    assert(entradas.length === 2, `dos entradas «Eliminó un conductor» (hay ${entradas.length})`);
    assert(entradas.every((e) => e.actorName === 'Admin de prueba'), 'con el nombre de quien lo hizo');
    assert(
      entradas.some((e) => (e.after as { motivo?: string } | null)?.motivo === 'Se retiró de la empresa'),
      'y el motivo',
    );
    assert(
      entradas.every((e) => !JSON.stringify(e.after).includes('+5731')),
      'sin el teléfono del conductor',
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
