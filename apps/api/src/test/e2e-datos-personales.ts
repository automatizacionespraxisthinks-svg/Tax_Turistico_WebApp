import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../db/schema';
import { hashSecret } from '../common/crypto';
import { base32Decode, totp } from '../common/totp';

/**
 * Datos personales (Ley 1581 de 2012), de extremo a extremo (17/11/2026).
 *
 *  - La autorización que manda n8n con el pedido queda guardada en el
 *    cliente, con la hora del servidor; una versión nueva la actualiza, la
 *    misma no.
 *  - La oficina busca al titular por su teléfono, descarga sus datos
 *    (consulta) y los suprime (reclamo); las dos quedan en la bitácora.
 *  - Suprimir no se puede con una carrera abierta, borra lo que identifica a
 *    la persona y deja la carrera en las cifras.
 *  - Sin el permiso `clientes.datos` no se puede nada de esto.
 *
 * Crea su propio administrador y su propio cliente, y los limpia al terminar.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-datos-personales.ts <clave-de-api>
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;
const ADMIN = { email: 'prueba-datos@taxturistico.local', pass: 'clave-de-prueba-suficientemente-larga' };
const CENTRO = { lat: 5.78034, lng: -73.11421 };

let fallos = 0;
function assert(condicion: boolean, mensaje: string, contexto?: unknown): void {
  if (condicion) {
    console.log(`  ✓ ${mensaje}`);
    return;
  }
  fallos += 1;
  console.error(`  ✗ ${mensaje}`);
  if (contexto !== undefined) console.error('   ', JSON.stringify(contexto).slice(0, 400));
}

type Json = Record<string, unknown>;
async function call(
  path: string,
  o: { method?: string; body?: unknown; apiKey?: boolean; cookie?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Json; setCookie: string | null }> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.apiKey && API_KEY) headers['x-api-key'] = API_KEY;
  if (o.cookie) headers.cookie = o.cookie;
  const r = await fetch(`${BASE}${path}`, {
    method: o.method ?? 'GET',
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    body = { raw: text };
  }
  return { status: r.status, body, setCookie: r.headers.get('set-cookie') };
}

async function main() {
  if (!API_KEY) {
    console.error('Falta la clave de API. Pásala como argumento o en TAX_API_KEY.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = drizzle(pool, { schema });
  const telefono = `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const rideIds: string[] = [];
  const pedir = async (consent?: { version: string; channel: string }) => {
    const r = await call('/v1/rides', {
      method: 'POST',
      apiKey: true,
      headers: { 'idempotency-key': `datos-${uuidv7()}` },
      body: {
        customerPhone: telefono,
        customerName: 'Titular De Prueba',
        pickup: { text: 'Calle 25 # 18-40, casa azul', reference: 'Portón verde', point: CENTRO },
        dropoff: { text: 'Terminal' },
        notes: 'Lleva una maleta',
        ...(consent ? { consent } : {}),
      },
    });
    if (typeof r.body.id === 'string') rideIds.push(r.body.id);
    return r;
  };
  const cliente = async () =>
    (await db.select().from(schema.customers).where(eq(schema.customers.phone, telefono)).limit(1))[0];

  await db.delete(schema.users).where(eq(schema.users.email, ADMIN.email));
  await db.insert(schema.users).values({
    id: uuidv7(),
    email: ADMIN.email,
    name: 'Admin de prueba de datos',
    passwordHash: await hashSecret(ADMIN.pass),
    role: 'administrador',
  });

  try {
    const acceso = await call('/v1/auth/session', { method: 'POST', body: { email: ADMIN.email, password: ADMIN.pass } });
    let cookie = acceso.setCookie!.split(';')[0]!;
    const setup = await call('/v1/auth/totp/setup', { method: 'POST', cookie });
    const activar = await call('/v1/auth/totp/activate', {
      method: 'POST',
      cookie,
      body: { code: totp(base32Decode((setup.body as { secret: string }).secret)) },
    });
    cookie = activar.setCookie?.split(';')[0] ?? cookie;
    const admin = (path: string, o: { method?: string; body?: unknown } = {}) => call(path, { ...o, cookie });

    console.log('\n1. La autorización se guarda con el pedido');
    {
      const r = await pedir({ version: '1', channel: 'WhatsApp · aviso en el primer mensaje' });
      assert(r.status < 400, `pedido con autorización (HTTP ${r.status})`, r.body);
      const c = await cliente();
      assert(c?.consentVersion === '1' && c.consentChannel?.startsWith('WhatsApp') === true && c.consentAt !== null, 'el cliente queda con versión, canal y hora');
      const primera = c!.consentAt!.getTime();
      await call(`/v1/rides/${r.body.id}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Prueba' } });

      const r2 = await pedir({ version: '1', channel: 'WhatsApp · aviso en el primer mensaje' });
      await call(`/v1/rides/${r2.body.id}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Prueba' } });
      assert((await cliente())!.consentAt!.getTime() === primera, 'la misma versión no la vuelve a escribir');

      const r3 = await pedir({ version: '2', channel: 'WhatsApp · aviso en el primer mensaje' });
      assert((await cliente())!.consentVersion === '2', 'una versión nueva de la política sí la actualiza');
      // Queda abierta para la prueba de supresión con carrera abierta.
      void r3;
    }

    console.log('\n2. Buscar al titular');
    const local = telefono.replace('+57', '');
    const buscado = await admin(`/v1/admin/customers/titular?telefono=${encodeURIComponent(`${local.slice(0, 3)} ${local.slice(3)}`)}`);
    assert(buscado.status === 200 && buscado.body.telefono === telefono, `lo encuentra escrito como la oficina («310 …») (HTTP ${buscado.status})`, buscado.body);
    assert(buscado.body.carreras === 3 && buscado.body.abiertas === 1, `con sus 3 carreras, 1 abierta (${buscado.body.carreras}, ${buscado.body.abiertas})`);
    const id = buscado.body.id as string;
    const noHay = await admin('/v1/admin/customers/titular?telefono=3009999999');
    assert(noHay.status === 404, 'un teléfono que no está: 404');

    console.log('\n3. Consulta: sus datos para entregárselos');
    {
      const datos = await admin(`/v1/admin/customers/${id}/datos`);
      const titular = datos.body.titular as Json;
      const carreras = datos.body.carreras as Json[];
      assert(datos.status === 200 && titular.telefono === telefono && carreras.length === 3, 'trae teléfono, nombre y sus 3 carreras', datos.body);
      assert(carreras.every((c) => c.recogida === 'Calle 25 # 18-40, casa azul' && c.notas === 'Lleva una maleta'), 'con direcciones y notas');
      assert((titular.autorizacion as Json | null)?.version === '2', 'y la autorización que dio');
      const [bitacora] = await pool
        .query(`select count(*)::int n from audit_log where entity_id = $1 and action like 'Entregó los datos%'`, [id])
        .then((r) => r.rows);
      assert(bitacora.n === 1, 'queda en la bitácora');
      assert(!JSON.stringify((await pool.query(`select after from audit_log where entity_id = $1`, [id])).rows).includes(telefono), 'sin el teléfono completo');
    }

    console.log('\n4. Supresión');
    {
      const abierta = await admin(`/v1/admin/customers/${id}/suprimir`, { method: 'POST', body: { motivo: 'Solicitud por WhatsApp' } });
      assert(abierta.status === 400 && /carrera abierta/.test(String(abierta.body.detail)), 'con una carrera abierta no se puede', abierta.body);
      for (const rid of rideIds) await call(`/v1/rides/${rid}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Prueba' } });

      const corto = await admin(`/v1/admin/customers/${id}/suprimir`, { method: 'POST', body: { motivo: 'x' } });
      assert(corto.status === 400, 'sin motivo no se puede');

      const hecho = await admin(`/v1/admin/customers/${id}/suprimir`, { method: 'POST', body: { motivo: 'Solicitud por WhatsApp del 17/11' } });
      assert(hecho.status < 400 && hecho.body.carreras === 3, `suprime (HTTP ${hecho.status}, ${hecho.body.carreras} carreras)`, hecho.body);

      const c = (await db.select().from(schema.customers).where(eq(schema.customers.id, id)).limit(1))[0]!;
      assert(c.phone === `suprimido:${id}` && c.name === null && c.suprimidoAt !== null, 'el cliente queda sin teléfono ni nombre');
      assert(c.consentVersion === '2', 'la autorización se conserva como prueba');
      const filas = (await pool.query('select pickup_text, pickup_reference, dropoff_text, notes, pickup_lat, status, zone_id from rides where customer_id = $1', [id])).rows;
      assert(filas.length === 3 && filas.every((f) => f.pickup_text === '[suprimido]' && f.pickup_reference === null && f.dropoff_text === null && f.notes === null),
        'las carreras quedan sin direcciones ni notas', filas);
      assert(filas.every((f) => f.status === 'CANCELLED' && f.zone_id !== null && Math.abs(f.pickup_lat - 5.78) < 1e-9), 'pero siguen en las cifras, con la recogida redondeada a ~1 km');
      const llaves = (await pool.query(`select count(*)::int n from idempotency_keys where response_body::text like $1`, [`%${telefono}%`])).rows[0].n;
      assert(llaves === 0, 'no quedan respuestas guardadas con su teléfono');
      const otraVez = await admin(`/v1/admin/customers/${id}/suprimir`, { method: 'POST', body: { motivo: 'Otra vez' } });
      assert(otraVez.status === 400, 'no se suprime dos veces');
      const yaNo = await admin(`/v1/admin/customers/titular?telefono=${encodeURIComponent(telefono)}`);
      assert(yaNo.status === 404, 'su teléfono ya no lo encuentra');

      const nuevo = await pedir();
      assert(nuevo.status < 400 && (await cliente())?.id !== id, 'si vuelve a escribir, es un cliente nuevo');
      for (const rid of rideIds.slice(-1)) await call(`/v1/rides/${rid}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Prueba' } });
    }

    console.log('\n5. Sin el permiso, nada');
    {
      await db.update(schema.users).set({ role: 'operador' }).where(eq(schema.users.email, ADMIN.email));
      const sin = await admin('/v1/admin/customers/titular?telefono=3001112233');
      assert(sin.status === 403, `un operador sin «clientes.datos»: 403 (HTTP ${sin.status})`);
    }
  } finally {
    await db.delete(schema.sessions).where(
      eq(schema.sessions.userId, (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, ADMIN.email)))[0]?.id ?? uuidv7()),
    );
    await db.delete(schema.users).where(eq(schema.users.email, ADMIN.email)).catch(() => undefined);
    if (rideIds.length) {
      await pool.query(`update rides set status = 'CANCELLED' where id = any($1) and status not in ('COMPLETED','CANCELLED')`, [rideIds]);
    }
    await pool.end();
  }

  console.log(fallos ? `\n${fallos} comprobaciones fallaron.` : '\nTodo en orden.');
  process.exit(fallos ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
