import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import { hashSecret, randomHex, randomToken } from '../common/crypto';

/**
 * Cuatro cambios en la carrera, comprobados contra la API de verdad:
 *
 *  1. Sin tarifas: no se calcula ningún precio, ni al crearla ni al cerrarla,
 *     y la ruta con la que el agente cotizaba ya no existe.
 *  2. Al aceptar, el evento hacia n8n lleva el nombre, el código interno y la
 *     placa del conductor, y la carrera guarda el taxi con el que va.
 *  3. La foto del lugar: llega con la carrera (un enlace que la API baja) o
 *     después (el archivo tal cual), y solo la ve el conductor que la lleva,
 *     y solo mientras va a recoger al cliente.
 *  4. No se puede finalizar antes de diez minutos con el pasajero a bordo, y
 *     el mensaje dice cuánto falta.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-ajustes-carrera.ts
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const CONDUCTOR = { code: '101', plate: 'UBP472' };
const OTRO = { code: '102', plate: 'TQR118' };
const APARTADOS = [OTRO, { code: '103', plate: 'SVM903' }];
const PIN = '4821';
const CENTRO = { lat: 5.7803, lng: -73.1142 };

/** Una foto JPEG de un píxel: lo justo para que sea una imagen de verdad. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);
/** Y una PNG cualquiera, la del icono de la PWA. */
const PNG = readFileSync(join(__dirname, '../../../driver/public/icon-192.png'));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
let apiKey = '';
let apiKeyId = '';

function assert(cond: boolean, msg: string, ctx?: unknown): void {
  if (!cond) {
    console.error(`  x ${msg}`);
    if (ctx !== undefined) console.error('    ', JSON.stringify(ctx));
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ok ${msg}`);
}

async function call(
  path: string,
  o: { method?: string; body?: unknown; token?: string; apiKey?: boolean; raw?: { type: string; data: Buffer } } = {},
) {
  const headers: Record<string, string> = {};
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.apiKey) headers['x-api-key'] = apiKey;
  let body: Uint8Array | string | undefined;
  if (o.raw) {
    headers['content-type'] = o.raw.type;
    body = new Uint8Array(o.raw.data);
  } else if (o.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  const r = await fetch(`${BASE}${path}`, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body });
  const tipo = r.headers.get('content-type') ?? '';
  if (tipo.startsWith('image/')) {
    return { status: r.status, tipo, bytes: Buffer.from(await r.arrayBuffer()), body: {} as Record<string, unknown> };
  }
  const t = await r.text();
  let json: Record<string, unknown> = {};
  try { json = t ? (JSON.parse(t) as Record<string, unknown>) : {}; } catch { json = { raw: t }; }
  return { status: r.status, tipo, bytes: Buffer.alloc(0), body: json };
}

async function entrar(q: { code: string; plate: string }): Promise<string> {
  const r = await call('/v1/auth/driver', {
    body: { code: q.code, plate: q.plate, pin: PIN, device: 'prueba', install: `ajustes-${q.code}` },
  });
  assert(r.status < 400, `conductor ${q.code} entra`, r.body);
  return (r.body as { token: string }).token;
}

const evento = async (rideId: string, tipo: string) =>
  (
    await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from outbox_events where ride_id = $1 and type = $2 order by created_at desc limit 1`,
      [rideId, tipo],
    )
  ).rows[0]?.payload;

async function main(): Promise<void> {
  // Una clave de API solo para esta prueba; se borra al final.
  const prefix = randomHex(4);
  const secret = randomToken(32);
  apiKeyId = uuidv7();
  await pool.query(
    `insert into api_keys (id, name, prefix, key_hash, scopes) values ($1, 'prueba-ajustes', $2, $3, $4)`,
    [apiKeyId, prefix, await hashSecret(secret), JSON.stringify(['rides:read', 'rides:write'])],
  );
  apiKey = `tax_${prefix}_${secret}`;

  // Un servidor de fotos de mentira: el `data_url` de Chatwoot, en pequeño.
  const fotos = createServer((req, res) => {
    if (req.url === '/foto.jpg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(JPEG);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>no soy una foto</html>');
    }
  });
  await new Promise<void>((r) => fotos.listen(0, '127.0.0.1', () => r()));
  const puerto = (fotos.address() as AddressInfo).port;

  let token = '';
  const carreras: string[] = [];
  try {
    console.log('\n0. Preparación: un solo conductor en turno, en el centro');
    const activas = await call('/v1/rides?status=PENDING,NOTIFIED,ASSIGNED,DRIVER_ARRIVED,IN_PROGRESS,UNASSIGNED', { apiKey: true });
    for (const v of Array.isArray(activas.body) ? (activas.body as unknown as { id: string }[]) : []) {
      await call(`/v1/rides/${v.id}/cancel`, { apiKey: true, body: { reason: 'Limpieza de la prueba' } });
    }
    for (const otro of APARTADOS) await call('/v1/driver/shift/close', { method: 'POST', token: await entrar(otro) });
    token = await entrar(CONDUCTOR);
    await call('/v1/driver/shift/close', { method: 'POST', token });
    await call('/v1/driver/shift/open', { token, body: { plate: CONDUCTOR.plate } });
    await call('/v1/driver/position', { token, body: { point: CENTRO } });

    /* ---------------------------------------------------------------- 1 */
    console.log('\n1. Sin tarifas');
    const cotizar = await call('/v1/quotes', { apiKey: true, body: { origin: CENTRO } });
    assert(cotizar.status === 404, `la ruta de cotizar ya no existe (HTTP ${cotizar.status})`);

    const creada = await call('/v1/rides', {
      apiKey: true,
      body: {
        customerPhone: '+573001119911',
        customerName: 'Prueba Ajustes',
        pickup: { text: 'Carrera 21 # 24-18', point: CENTRO },
        pickupPhotoUrl: `http://127.0.0.1:${puerto}/foto.jpg`,
      },
    });
    assert(creada.status === 201, 'la carrera se crea', creada.body);
    const rideId = (creada.body as { id: string }).id;
    carreras.push(rideId);
    assert((creada.body as { fareEstimate: unknown }).fareEstimate === null, 'sin tarifa estimada');
    const alCrear = await evento(rideId, 'ride.created');
    assert(alCrear !== undefined && !('fareEstimate' in alCrear), 'y el evento hacia n8n no lleva precio', alCrear);

    /* ---------------------------------------------------------------- 3a */
    console.log('\n2. La foto llega con la carrera');
    let conFoto = false;
    for (let i = 0; i < 25 && !conFoto; i++) {
      const d = await call(`/v1/rides/${rideId}`, { apiKey: true });
      conFoto = Boolean((d.body as { pickupPhotoAt?: string | null }).pickupPhotoAt);
      if (!conFoto) await new Promise((r) => setTimeout(r, 200));
    }
    assert(conFoto, 'la API bajó la foto del enlace sin hacer esperar la carrera');

    /* ---------------------------------------------------------------- 2 */
    console.log('\n3. Al aceptar: nombre, código y placa');
    for (let i = 0; i < 30; i++) {
      const d = await call(`/v1/rides/${rideId}`, { apiKey: true });
      if (((d.body as { offers?: unknown[] }).offers ?? []).length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const acepta = await call(`/v1/driver/rides/${rideId}/accept`, { method: 'POST', token });
    assert(acepta.status < 400, 'el conductor acepta', acepta.body);

    const asignada = (await evento(rideId, 'ride.assigned')) as { driver?: Record<string, unknown> } | undefined;
    assert(asignada?.driver?.code === CONDUCTOR.code, `el evento lleva el código ${asignada?.driver?.code}`, asignada);
    assert(typeof asignada?.driver?.name === 'string' && (asignada.driver.name as string).length > 0, `y el nombre: ${asignada?.driver?.name}`);
    assert(asignada?.driver?.plate === CONDUCTOR.plate, `y la placa: ${asignada?.driver?.plate}`);

    const detalle = (await call(`/v1/rides/${rideId}`, { apiKey: true })).body as {
      driver?: { code: string; plate: string | null };
      vehicleId?: string | null;
    };
    assert(Boolean(detalle.vehicleId), 'la carrera guarda el taxi con el que va');
    assert(detalle.driver?.plate === CONDUCTOR.plate, 'y el detalle de la carrera también trae la placa');

    /* ---------------------------------------------------------------- 3b */
    console.log('\n4. La foto, en la pantalla del conductor');
    const ver = await call(`/v1/driver/rides/${rideId}/photo`, { token });
    assert(ver.status === 200 && ver.tipo === 'image/jpeg', 'el conductor la ve', { status: ver.status, tipo: ver.tipo });
    assert(ver.bytes.equals(JPEG), 'y es exactamente la que mandó el cliente');

    const otro = await entrar(OTRO);
    const ajena = await call(`/v1/driver/rides/${rideId}/photo`, { token: otro });
    assert(ajena.status === 403, 'otro conductor no la ve');

    const archivo = await call(`/v1/rides/${rideId}/photo`, { apiKey: true, raw: { type: 'image/png', data: PNG } });
    assert(archivo.status === 201, 'n8n manda otra como archivo, sin enlace', archivo.body);
    const nueva = await call(`/v1/driver/rides/${rideId}/photo`, { token });
    assert(nueva.tipo === 'image/png' && nueva.bytes.equals(PNG), 'y reemplaza a la anterior');

    const html = await call(`/v1/rides/${rideId}/photo`, { apiKey: true, body: { url: `http://127.0.0.1:${puerto}/pagina` } });
    assert(html.status === 400, 'un enlace que no es una foto se rechaza', html.body);
    const disfrazada = await call(`/v1/rides/${rideId}/photo`, {
      apiKey: true,
      raw: { type: 'image/jpeg', data: Buffer.from('esto no es un jpeg') },
    });
    assert(disfrazada.status === 400, 'y un texto con content-type de imagen también');
    const gif = await call(`/v1/rides/${rideId}/photo`, { apiKey: true, raw: { type: 'image/gif', data: PNG } });
    assert(gif.status === 415, `un tipo que no se acepta ni se lee (HTTP ${gif.status})`);

    /* ---------------------------------------------------------------- 4 */
    console.log('\n5. Diez minutos a bordo antes de poder finalizar');
    await call(`/v1/driver/rides/${rideId}/arrived`, { token, body: { at: CENTRO } });
    const sube = await call(`/v1/driver/rides/${rideId}/board`, { token, body: { at: CENTRO } });
    assert(sube.status < 400, 'el pasajero sube', sube.body);

    const yaNo = await call(`/v1/driver/rides/${rideId}/photo`, { token });
    assert(yaNo.status === 404, 'con el pasajero a bordo, la foto deja de mostrarse');

    const enseguida = await call(`/v1/driver/rides/${rideId}/finish`, { token, body: { at: CENTRO } });
    assert(
      enseguida.status === 409 && (enseguida.body as { code?: string }).code === 'RIDE_TOO_SHORT',
      'finalizar en el acto se rechaza',
      enseguida.body,
    );
    assert(/faltan 10 minutos/.test(String((enseguida.body as { detail?: string }).detail)), `y dice cuánto falta: «${(enseguida.body as { detail?: string }).detail}»`);

    await pool.query(`update rides set started_at = now() - interval '9 minutes 30 seconds' where id = $1`, [rideId]);
    const casi = await call(`/v1/driver/rides/${rideId}/finish`, { token, body: { at: CENTRO } });
    assert(
      casi.status === 409 && /falta 1 minuto/.test(String((casi.body as { detail?: string }).detail)),
      `a los nueve minutos y medio tampoco: «${(casi.body as { detail?: string }).detail}»`,
    );

    await pool.query(`update rides set started_at = now() - interval '10 minutes 5 seconds' where id = $1`, [rideId]);
    const ahora = await call(`/v1/driver/rides/${rideId}/finish`, { token, body: { at: CENTRO } });
    assert(ahora.status < 400, 'pasados los diez minutos, sí', ahora.body);

    const cierre = await evento(rideId, 'ride.completed');
    assert(cierre !== undefined && !('fareFinal' in cierre), 'el cierre tampoco lleva precio', cierre);
    const yo = (await call('/v1/driver/rides/me', { token })).body as { totals: Record<string, unknown> };
    assert(!('earned' in yo.totals), 'y la PWA ya no recibe lo «ganado» del día', yo.totals);

    console.log('\nok La carrera se cierra a su tiempo, sin precios, con foto y con placa\n');
  } finally {
    for (const id of carreras) {
      await call(`/v1/rides/${id}/cancel`, { apiKey: true, body: { reason: 'Fin de la prueba' } });
    }
    if (token) await call('/v1/driver/shift/close', { method: 'POST', token });
    await pool.query(`delete from api_keys where id = $1`, [apiKeyId]);
    fotos.close();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('\nLa prueba falló:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
