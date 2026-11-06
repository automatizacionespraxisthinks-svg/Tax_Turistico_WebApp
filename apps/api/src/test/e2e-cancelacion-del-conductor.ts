import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import * as schema from '../db/schema';
import { hashSecret, randomHex, randomToken } from '../common/crypto';
import { leerPeriodo, resumir } from '../modules/reports/exports.data';

/**
 * El conductor cancela una carrera por una causa mayor, contra la API de
 * verdad:
 *
 *  1. Sin motivo de la lista, o con «Otro» y sin contar qué pasó, no se
 *     cancela; y otro conductor no puede cancelar una carrera ajena.
 *  2. Con la carrera aceptada (yendo a recoger) se cancela: queda quién fue,
 *     el motivo, la bitácora con su nombre y su posición, y el evento hacia
 *     n8n dice que la canceló el conductor. Él queda libre y le llega la
 *     siguiente.
 *  3. Con «Llegué» también se puede: el cliente no aparece.
 *  4. Con el pasajero a bordo ya no: la respuesta lo dice claro, y la
 *     carrera se termina como siempre.
 *  5. Reportes las cuenta: cuántas canceló el conductor, cuántas él mismo, y
 *     agrupadas por el motivo de la lista, no por lo que escribió. La que
 *     cancela el cliente cuenta como cancelada, pero no del conductor.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-cancelacion-del-conductor.ts
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const CONDUCTOR = { code: '101', plate: 'UBP472' };
const OTRO = { code: '102', plate: 'TQR118' };
const APARTADOS = [OTRO, { code: '103', plate: 'SVM903' }];
const PIN = '4821';
const CENTRO = { lat: 5.7803, lng: -73.1142 };
/** El mínimo a bordo antes de poder finalizar, el mismo que usa la API. */
const MIN_A_BORDO = Number(process.env.MIN_DURACION_CARRERA_MIN ?? 10);
/** Dónde estaba el conductor al cancelar: un poco al norte del centro. */
const EN_LA_VIA = { lat: 5.7861, lng: -73.1125 };

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const db = drizzle(pool, { schema, casing: 'snake_case' });

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

async function call(path: string, o: { method?: string; body?: unknown; token?: string; apiKey?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.apiKey) headers['x-api-key'] = apiKey;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, {
    method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = t ? (JSON.parse(t) as Record<string, unknown>) : {};
  } catch {
    json = { raw: t };
  }
  return { status: r.status, body: json };
}

async function entrar(q: { code: string; plate: string }): Promise<string> {
  const r = await call('/v1/auth/driver', {
    body: { code: q.code, plate: q.plate, pin: PIN, device: 'prueba', install: `cancelacion-${q.code}` },
  });
  assert(r.status < 400, `conductor ${q.code} entra`, r.body);
  return (r.body as { token: string }).token;
}

/** Pide una carrera en el centro y espera a que la oferta le llegue al conductor. */
async function carreraAceptada(token: string, nombre: string): Promise<{ id: string; code: string }> {
  const creada = await call('/v1/rides', {
    apiKey: true,
    body: { customerPhone: '+573001119922', customerName: nombre, pickup: { text: 'Carrera 21 # 24-18', point: CENTRO } },
  });
  assert(creada.status === 201, `se pide la carrera de ${nombre}`, creada.body);
  const ride = creada.body as { id: string; code: string };
  for (let i = 0; i < 30; i++) {
    const d = await call(`/v1/rides/${ride.id}`, { apiKey: true });
    if (((d.body as { offers?: unknown[] }).offers ?? []).length > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const acepta = await call(`/v1/driver/rides/${ride.id}/accept`, { method: 'POST', token });
  assert(acepta.status < 400, 'el conductor la acepta', acepta.body);
  return ride;
}

const fila = async (rideId: string) =>
  (
    await pool.query<{ status: string; cancelled_by: string | null; cancel_code: string | null; cancel_reason: string | null }>(
      `select status, cancelled_by, cancel_code, cancel_reason from rides where id = $1`,
      [rideId],
    )
  ).rows[0]!;

async function main(): Promise<void> {
  const prefix = randomHex(4);
  const secret = randomToken(32);
  apiKeyId = uuidv7();
  await pool.query(
    `insert into api_keys (id, name, prefix, key_hash, scopes) values ($1, 'prueba-cancelacion', $2, $3, $4)`,
    [apiKeyId, prefix, await hashSecret(secret), JSON.stringify(['rides:read', 'rides:write'])],
  );
  apiKey = `tax_${prefix}_${secret}`;

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
    console.log('\n1. Sin un motivo válido no se cancela');
    const primera = await carreraAceptada(token, 'Prueba Cancelación Uno');
    carreras.push(primera.id);

    const sinMotivo = await call(`/v1/driver/rides/${primera.id}/cancel`, { token, body: {} });
    assert(sinMotivo.status === 400, `sin motivo, no (HTTP ${sinMotivo.status})`, sinMotivo.body);
    const inventado = await call(`/v1/driver/rides/${primera.id}/cancel`, { token, body: { motivo: 'me_aburri' } });
    assert(inventado.status === 400, `un motivo que no está en la lista, tampoco (HTTP ${inventado.status})`);
    const otroSinTexto = await call(`/v1/driver/rides/${primera.id}/cancel`, { token, body: { motivo: 'otro', detalle: 'ya' } });
    assert(
      otroSinTexto.status === 400 && JSON.stringify(otroSinTexto.body).includes('Cuenta en pocas palabras'),
      '«Otro» sin contar qué pasó, tampoco, y se lo pide',
      otroSinTexto.body,
    );
    const ajeno = await call(`/v1/driver/rides/${primera.id}/cancel`, {
      token: await entrar(OTRO),
      body: { motivo: 'accidente' },
    });
    assert(ajeno.status === 403, `otro conductor no puede cancelarla (HTTP ${ajeno.status})`);
    assert((await fila(primera.id)).status === 'ASSIGNED', 'y la carrera sigue asignada');

    /* ---------------------------------------------------------------- 2 */
    console.log('\n2. Yendo a recoger: se cancela, con trazabilidad');
    const cancela = await call(`/v1/driver/rides/${primera.id}/cancel`, {
      token,
      body: { motivo: 'falla_mecanica', detalle: 'Se pinchó la llanta en la vía', at: EN_LA_VIA },
    });
    assert(cancela.status < 400, 'el conductor la cancela', cancela.body);

    const f1 = await fila(primera.id);
    assert(f1.status === 'CANCELLED', 'la carrera queda cancelada');
    assert(f1.cancelled_by === 'driver', `cancelada por: ${f1.cancelled_by}`);
    assert(f1.cancel_code === 'falla_mecanica', `con la clave del motivo: ${f1.cancel_code}`);
    assert(
      f1.cancel_reason === 'Falla mecánica o pinchazo: Se pinchó la llanta en la vía',
      `y el motivo escrito: «${f1.cancel_reason}»`,
    );

    const paso = (
      await pool.query<{ actor: string; actor_name: string; note: string | null; lat: number | null }>(
        `select actor, actor_name, note, lat
           from ride_status_history where ride_id = $1 and to_status = 'CANCELLED'`,
        [primera.id],
      )
    ).rows[0];
    assert(paso?.actor === 'driver', `la bitácora dice que fue el conductor (${paso?.actor_name})`, paso);
    assert(paso?.note === f1.cancel_reason, 'con el mismo motivo');
    assert(paso?.lat !== null && Math.abs((paso?.lat ?? 0) - EN_LA_VIA.lat) < 1e-4, 'y dónde estaba al cancelar', paso);

    const evento = (
      await pool.query<{ payload: Record<string, unknown> }>(
        `select payload from outbox_events where ride_id = $1 and type = 'ride.cancelled' order by created_at desc limit 1`,
        [primera.id],
      )
    ).rows[0]?.payload;
    assert(evento?.cancelledBy === 'driver' && evento?.code === 'falla_mecanica', 'el evento hacia n8n dice quién y por qué', evento);

    /* ---------------------------------------------------------------- 3 */
    console.log('\n3. Con «Llegué» también: el cliente no aparece');
    const segunda = await carreraAceptada(token, 'Prueba Cancelación Dos');
    carreras.push(segunda.id);
    // `carreraAceptada` espera la oferta y la acepta: si no hubiera quedado
    // libre, la oferta no le llegaba y aceptar fallaba.
    console.log('  ok quedó libre: la siguiente carrera le llegó a él');
    const llego = await call(`/v1/driver/rides/${segunda.id}/arrived`, { token, body: { at: CENTRO } });
    assert(llego.status < 400, 'marca «Llegué»', llego.body);
    const noAparece = await call(`/v1/driver/rides/${segunda.id}/cancel`, { token, body: { motivo: 'cliente_no_aparece' } });
    assert(noAparece.status < 400, 'la cancela porque el cliente no aparece', noAparece.body);
    const f2 = await fila(segunda.id);
    assert(
      f2.cancelled_by === 'driver' && f2.cancel_reason === 'El cliente no aparece o no contesta',
      `sin detalle, el motivo es el de la lista: «${f2.cancel_reason}»`,
    );

    /* ---------------------------------------------------------------- 4 */
    console.log('\n4. Con el pasajero a bordo ya no');
    const tercera = await carreraAceptada(token, 'Prueba Cancelación Tres');
    carreras.push(tercera.id);
    await call(`/v1/driver/rides/${tercera.id}/arrived`, { token, body: { at: CENTRO } });
    const sube = await call(`/v1/driver/rides/${tercera.id}/board`, { token, body: { at: CENTRO } });
    assert(sube.status < 400, 'el pasajero sube', sube.body);
    const tarde = await call(`/v1/driver/rides/${tercera.id}/cancel`, { token, body: { motivo: 'emergencia' } });
    assert(
      tarde.status === 409 && String((tarde.body as { detail?: string }).detail).includes('pasajero a bordo'),
      `se rechaza y lo dice: «${(tarde.body as { detail?: string }).detail}»`,
      tarde.body,
    );
    assert((await fila(tercera.id)).status === 'IN_PROGRESS', 'y la carrera sigue en curso');

    // Se termina como siempre, pasado el mínimo a bordo.
    await pool.query(`update rides set started_at = now() - ($2::int * interval '1 second') where id = $1`, [
      tercera.id,
      MIN_A_BORDO * 60 + 5,
    ]);
    const termina = await call(`/v1/driver/rides/${tercera.id}/finish`, { token, body: { at: CENTRO } });
    assert(termina.status < 400, 'y la termina', termina.body);

    // Y una que cancela el cliente antes de que nadie la tome.
    const cuarta = await call('/v1/rides', {
      apiKey: true,
      body: { customerPhone: '+573001119922', customerName: 'Prueba Cancelación Cuatro', pickup: { text: 'Carrera 21 # 24-18', point: CENTRO } },
    });
    const cuartaRide = cuarta.body as { id: string; code: string };
    carreras.push(cuartaRide.id);
    await call(`/v1/rides/${cuartaRide.id}/cancel`, { apiKey: true, body: { reason: 'El cliente ya no la necesita' } });
    const f4 = await fila(cuartaRide.id);
    assert(f4.status === 'CANCELLED' && f4.cancelled_by === 'customer', `la del cliente: cancelada por ${f4.cancelled_by}`);

    /* ---------------------------------------------------------------- 5 */
    console.log('\n5. Reportes');
    const codigos = new Set([primera.code, segunda.code, tercera.code, cuartaRide.code]);
    const periodo = await leerPeriodo(db, { days: 1 });
    const filas = periodo.filas.filter((f) => codigos.has(f.codigo));
    assert(filas.length === 4, `las cuatro carreras salen en el periodo (${filas.length})`);
    const r = resumir(filas);
    assert(r.canceladas === 3, `tres canceladas (${r.canceladas})`);
    assert(r.canceladasPorConductor === 2, `dos por el conductor (${r.canceladasPorConductor})`);
    const suyo = r.porConductor.find((c) => c.asignadas > 0);
    assert(
      suyo?.asignadas === 3 && suyo.canceladas === 2 && suyo.canceladasPorEl === 2 && suyo.finalizadas === 1,
      'por conductor: tomó 3, terminó 1 y canceló él 2',
      suyo,
    );
    assert(
      r.cancelaciones.some((c) => c.quien === 'Cliente' && c.motivo === 'El cliente ya no la necesita'),
      'la del cliente sale aparte, como del cliente',
      r.cancelaciones,
    );
    assert(
      r.cancelaciones.some((c) => c.quien === 'Conductor' && c.motivo === 'Falla mecánica o pinchazo' && c.carreras === 1),
      'el motivo del conductor se agrupa por la lista, sin el detalle',
      r.cancelaciones,
    );
    assert(
      r.cancelaciones.some((c) => c.quien === 'Conductor' && c.motivo === 'El cliente no aparece o no contesta'),
      'y la del cliente que no aparece, aparte',
    );

    console.log('\nok El conductor cancela antes de recoger, con motivo, y queda en la bitácora y en Reportes\n');
  } finally {
    for (const id of carreras) {
      await call(`/v1/rides/${id}/cancel`, { apiKey: true, body: { reason: 'Fin de la prueba' } });
    }
    if (token) await call('/v1/driver/shift/close', { method: 'POST', token });
    await pool.query(`delete from api_keys where id = $1`, [apiKeyId]);
    await pool.end();
  }
}

main().catch((e) => {
  console.error('\nLa prueba falló:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
