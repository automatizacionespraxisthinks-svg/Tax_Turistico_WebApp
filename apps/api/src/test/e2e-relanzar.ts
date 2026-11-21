import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { Pool } from 'pg';

/**
 * Relanzar el despacho de una carrera que nadie aceptó.
 *
 * Fallaba con un 500. Las ofertas eran únicas por carrera + conductor +
 * oleada, y al relanzar, la ronda final intentaba ofrecérsela otra vez al
 * mismo conductor en la misma oleada 4: el índice lo rechazaba y el
 * relanzamiento entero caía. Cada intento fallido dejaba además tres
 * oleadas vacías en el registro.
 *
 * Y había un problema de fondo: relanzar excluía de las oleadas por radio a
 * todo el que alguna vez vio la carrera. Con pocos conductores, relanzar no
 * encontraba nunca a nadie, que es justo para lo que existe el botón.
 *
 * Ahora cada lanzamiento es un intento propio, y desde el 19/11/2026 el
 * sistema relanza solo al agotar las oleadas y cierra la carrera si tampoco
 * así la toma nadie. Se comprueba:
 *
 *  1. agotada la ronda final, queda sin asignar y se relanza sola, sin 500;
 *  2. quien no contestó vuelve a contar en la oleada 1 del relanzamiento;
 *  3. el teléfono confirma el aviso con la firma de la oferta, y una firma
 *     falsa no marca nada (acuse de recibo, 21/11/2026);
 *  4. si tampoco así la toma nadie, NO se cierra: sigue relanzándose, con
 *     aviso urgente, y al cliente se le escribe una sola vez; solo la cierra
 *     la cancelación del cliente (BUSCAR_HASTA_CANCELAR, 21/11/2026);
 *  5. quien rechazó la carrera no vuelve a recibirla, relance quien relance,
 *     y un relanzamiento de la oficina no choca con el automático.
 *
 * Tarda unos tres minutos: espera vencimientos reales de la ronda final.
 * Supone la configuración por defecto (RELANZAMIENTOS_AUTOMATICOS=1); el
 * tiempo del relanzamiento se lee de RELANZAMIENTO_ESPERA_SEG (20 s).
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-relanzar.ts <clave-de-api>
 *
 * Necesita la API con `OLEADA_FINAL_A_TODOS` encendida, que es lo normal.
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;

const CONDUCTOR = { code: '101', plate: 'UBP472' };
const APARTADOS = [
  { code: '102', plate: 'TQR118' },
  { code: '103', plate: 'SVM903' },
];
const PIN = '4821';

const CENTRO = { lat: 5.7803, lng: -73.1142 };
const CERCA = { lat: 5.7813, lng: -73.1132 };
/** Unos 19 km al norte: solo la ronda final llega hasta aquí. */
const LEJOS = { lat: 5.95, lng: -73.1142 };

interface Oferta { wave: number; intento: number; driverId: string; response: string }
interface Entrada { wave: number; intento?: number; candidates: number }
interface Detalle {
  status: string;
  cancelledBy?: string | null;
  cancelCode?: string | null;
  waveLog: Entrada[];
  offers: Oferta[];
  intentoDespacho: number;
  history: { toStatus: string; note?: string | null; actor?: string }[];
}

/** La nota del ultimo paso a «sin asignar»: dice por que se quedo sin conductor. */
const ultimaNotaSinAsignar = (d: Detalle) =>
  [...d.history].reverse().find((h) => h.toStatus === 'UNASSIGNED')?.note ?? null;

async function call(
  path: string,
  o: { method?: string; body?: unknown; token?: string; apiKey?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.apiKey && API_KEY) headers['x-api-key'] = API_KEY;
  const r = await fetch(`${BASE}${path}`, {
    method: o.method ?? 'GET',
    headers,
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  let body: Record<string, unknown> = {};
  try { body = t ? JSON.parse(t) : {}; } catch { body = { raw: t }; }
  return { status: r.status, body };
}

function assert(cond: boolean, msg: string, ctx?: unknown): void {
  if (!cond) {
    console.error(`  x ${msg}`);
    if (ctx !== undefined) console.error('    ', JSON.stringify(ctx));
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ok ${msg}`);
}

async function entrar(q: { code: string; plate: string }): Promise<string> {
  const r = await call('/v1/auth/driver', {
    method: 'POST',
    body: { code: q.code, plate: q.plate, pin: PIN, device: 'prueba', install: `relanzar-${q.code}` },
  });
  assert(r.status < 400, `conductor ${q.code} entra`, r.body);
  return (r.body as { token: string }).token;
}

const detalle = async (id: string) => (await call(`/v1/rides/${id}`, { apiKey: true })).body as unknown as Detalle;

/** Espera a que la carrera llegue a un estado; los vencimientos son reales. */
async function esperarEstado(id: string, estado: string, segundos: number): Promise<Detalle> {
  const limite = Date.now() + segundos * 1000;
  let d = await detalle(id);
  while (d.status !== estado && Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 1000));
    d = await detalle(id);
  }
  return d;
}

/** Espera a que aparezca una oferta pendiente en un intento concreto. */
async function esperarOferta(id: string, intento: number): Promise<Detalle> {
  for (let i = 0; i < 40; i++) {
    const d = await detalle(id);
    if (d.offers.some((o) => o.intento === intento && o.response === 'pending')) return d;
    if (d.status === 'UNASSIGNED' && d.intentoDespacho === intento) return d;
    await new Promise((r) => setTimeout(r, 250));
  }
  return detalle(id);
}

const relanzar = (id: string) => call(`/v1/rides/${id}/redispatch`, { method: 'POST', apiKey: true });
const ESPERA_RELANZAMIENTO = Number(process.env.RELANZAMIENTO_ESPERA_SEG ?? 20);
const ESPERA_URGENTE = Number(process.env.REINTENTO_URGENTE_ESPERA_SEG ?? 45);

/** Espera la primera oferta de un intento: el relanzamiento automático la crea solo. */
async function esperarIntento(id: string, intento: number, segundos: number): Promise<Detalle> {
  const limite = Date.now() + segundos * 1000;
  let d = await detalle(id);
  while (d.intentoDespacho < intento && Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 1000));
    d = await detalle(id);
  }
  return esperarOferta(id, intento);
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('Falta la clave de API. Pasala como argumento o en TAX_API_KEY.');
    process.exitCode = 1;
    return;
  }

  console.log('\n0. Un solo conductor en turno, lejos');
  const activas = await call('/v1/rides?status=ASSIGNED,DRIVER_ARRIVED,IN_PROGRESS,NOTIFIED,PENDING', { apiKey: true });
  for (const v of Array.isArray(activas.body) ? (activas.body as unknown as { id: string }[]) : []) {
    await call(`/v1/rides/${v.id}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Limpieza' } });
  }
  for (const otro of APARTADOS) {
    await call('/v1/driver/shift/close', { method: 'POST', token: await entrar(otro) });
  }
  const token = await entrar(CONDUCTOR);
  await call('/v1/driver/shift/close', { method: 'POST', token });
  await call('/v1/driver/shift/open', { method: 'POST', token, body: { plate: CONDUCTOR.plate } });
  await call('/v1/driver/position', { method: 'POST', token, body: { point: LEJOS } });

  const creada = await call('/v1/rides', {
    method: 'POST',
    apiKey: true,
    body: { customerPhone: '+573001234599', pickup: { text: 'Carrera 21 # 24-18', point: CENTRO }, passengers: 1 },
  });
  assert(creada.status < 400, 'carrera creada', creada.body);
  const id = (creada.body as { id: string }).id;

  /* ------------------------------------------------------------------ 1 */
  console.log('\n1. La ronda final vence sin respuesta y se relanza sola');
  let d = await esperarOferta(id, 1);
  assert(d.offers.some((o) => o.wave === 4 && o.intento === 1), 'intento 1: la ronda final le llega');
  d = await esperarEstado(id, 'UNASSIGNED', 130);
  assert(d.status === 'UNASSIGNED', 'nadie contesta: queda sin asignar mientras se relanza');
  // Le llego y no la tomo: no es lo mismo que no haber nadie.
  assert(
    ultimaNotaSinAsignar(d)?.startsWith('Nadie aceptó la carrera') === true,
    `la bitacora dice por que: «${ultimaNotaSinAsignar(d)}»`,
  );

  // Se acerca antes de que se relance: la oleada 1 tiene que encontrarlo.
  await call('/v1/driver/position', { method: 'POST', token, body: { point: CERCA } });

  /* ------------------------------------------------------------------ 2 */
  console.log('\n2. El relanzamiento automático vuelve a contar con quien no contestó');
  d = await esperarIntento(id, 2, ESPERA_RELANZAMIENTO + 30);
  assert(d.intentoDespacho === 2, `es el intento 2, sin que nadie lo pidiera (${d.intentoDespacho})`);
  assert(
    d.history.some((h) => h.note?.startsWith('Relanzamiento automático')),
    'la bitacora dice que lo relanzo el sistema',
  );
  /*
   * El cambio de fondo de 2026-10. Antes, la oleada 1 de un relanzamiento
   * excluia a todo el que alguna vez vio la carrera; este conductor la vio
   * y no contesto, asi que nunca habria vuelto a recibirla por radio.
   */
  assert(
    d.offers.some((o) => o.wave === 1 && o.intento === 2 && o.response === 'pending'),
    'la oleada 1 vuelve a contar con quien no contesto',
  );

  /* ------------------------------------------------------------------ 3 */
  console.log('\n3. Acuse de recibo: el teléfono confirma el aviso');
  {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const fila = (
      await pool.query(`select id, aviso from ride_offers where ride_id = $1 and intento = 2 order by sent_at limit 1`, [id])
    ).rows[0] as { id: string; aviso: string | null };
    assert(Boolean(fila?.aviso), `la oferta dice qué pasó con el aviso («${fila?.aviso}»)`);
    const firma = createHmac('sha256', String(process.env.SESSION_SECRET)).update(`acuse:${fila.id}`).digest('base64url').slice(0, 32);
    const mala = await call('/v1/driver/push/recibido', { method: 'POST', body: { offerId: fila.id, firma: 'x'.repeat(32) } });
    let recibida = (await pool.query(`select recibida_at from ride_offers where id = $1`, [fila.id])).rows[0].recibida_at;
    assert(mala.status === 204 && recibida === null, 'con una firma falsa no se marca');
    const buena = await call('/v1/driver/push/recibido', { method: 'POST', body: { offerId: fila.id, firma } });
    recibida = (await pool.query(`select recibida_at from ride_offers where id = $1`, [fila.id])).rows[0].recibida_at;
    assert(buena.status === 204 && recibida !== null, 'con la firma del aviso queda como recibida');
    const conAcuse = (await detalle(id)).offers.some((o) => (o as Oferta & { recibidaAt?: string }).recibidaAt);
    assert(conAcuse, 'y el detalle que ve el panel lo muestra');
    await pool.end();
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n4. Tampoco la toma: sigue buscando, en silencio, hasta que el cliente cancele');
  const rechazo = await call(`/v1/driver/rides/${id}/reject`, { method: 'POST', token });
  assert(rechazo.status < 400, 'el conductor la rechaza', rechazo.body);
  d = await esperarEstado(id, 'UNASSIGNED', 20);
  assert(d.status === 'UNASSIGNED', `no se cierra: queda sin asignar mientras vuelve a buscar (${d.status})`);
  assert(
    ultimaNotaSinAsignar(d)?.includes('se vuelve a avisar como urgente') === true,
    `la bitácora dice que el siguiente aviso es urgente: «${ultimaNotaSinAsignar(d)}»`,
  );
  d = await esperarIntento(id, 3, ESPERA_URGENTE + 30);
  assert(d.intentoDespacho >= 3 && d.status !== 'CANCELLED', `relanza otra vez sola (intento ${d.intentoDespacho}, ${d.status})`);
  {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const n = (
      await pool.query(`select count(*)::int n from outbox_events where type = 'ride.no_driver' and ride_id = $1`, [id])
    ).rows[0].n as number;
    await pool.end();
    assert(n === 1, `al cliente se le escribió una sola vez «Estamos buscando…» (${n})`);
  }
  const cancelada = await call(`/v1/rides/${id}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Ya no lo necesito' } });
  assert(cancelada.status < 400, 'el cliente la cancela por el chat', cancelada.body);
  await new Promise((res) => setTimeout(res, (ESPERA_URGENTE + 5) * 1000));
  d = await detalle(id);
  assert(d.status === 'CANCELLED' && d.cancelledBy !== 'system', `solo la cancelación del cliente la cierra (${d.status}, ${d.cancelledBy})`);

  /* ------------------------------------------------------------------ 5 */
  console.log('\n5. Otra carrera: la rechaza y la oficina relanza antes que el sistema');
  const segunda = await call('/v1/rides', {
    method: 'POST',
    apiKey: true,
    body: { customerPhone: '+573001234599', pickup: { text: 'Carrera 21 # 24-18', point: CENTRO }, passengers: 1 },
  });
  assert(segunda.status < 400, 'el mismo cliente puede pedir otra', segunda.body);
  const id2 = (segunda.body as { id: string }).id;
  d = await esperarOferta(id2, 1);
  const rechazo2 = await call(`/v1/driver/rides/${id2}/reject`, { method: 'POST', token });
  assert(rechazo2.status < 400, 'el conductor la rechaza', rechazo2.body);
  d = await esperarEstado(id2, 'UNASSIGNED', 20);
  assert(d.status === 'UNASSIGNED', 'queda sin asignar, con el relanzamiento automatico en espera');

  const r = await relanzar(id2);
  assert(r.status < 400, `la oficina relanza: responde ${r.status}, no 500`, r.body);
  d = await esperarEstado(id2, 'UNASSIGNED', 20);
  assert(!d.offers.some((o) => o.intento === 2), 'el intento 2 no le ofrece nada a quien la rechazo');
  assert(
    d.waveLog.filter((e) => e.intento === 2).every((e) => e.candidates === 0),
    'y sus oleadas quedan registradas como vacias',
  );
  // Aqui no le llego a nadie: la nota no puede decir que «nadie acepto».
  assert(
    ultimaNotaSinAsignar(d)?.startsWith('Ninguna oleada encontró conductores') === true,
    `la bitacora lo distingue: «${ultimaNotaSinAsignar(d)}»`,
  );

  // El relanzamiento automático del intento 1 llega despues y no se suma.
  await new Promise((res) => setTimeout(res, (ESPERA_RELANZAMIENTO + 5) * 1000));
  d = await detalle(id2);
  assert(d.intentoDespacho === 2 || ESPERA_URGENTE <= ESPERA_RELANZAMIENTO + 5, `el relanzamiento pendiente del intento 1 no se suma (intento ${d.intentoDespacho})`);

  console.log('\n6. Limpieza');
  await call(`/v1/rides/${id2}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Limpieza' } });
  await call('/v1/driver/shift/close', { method: 'POST', token });
  console.log('  carrera cancelada y turno cerrado');

  console.log('\nok La búsqueda no se corta sola, y la oficina puede relanzar sin chocar con el sistema\n');
}

main().catch((e) => {
  console.error('\nLa prueba fallo:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
