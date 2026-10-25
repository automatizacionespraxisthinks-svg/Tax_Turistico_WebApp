import 'dotenv/config';

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
 * Ahora cada lanzamiento es un intento propio. Se comprueba:
 *
 *  1. relanzar tras una ronda final vencida no da 500 y vuelve a avisar;
 *  2. relanzar dos veces seguidas también funciona;
 *  3. quien no contestó vuelve a contar en la oleada 1 de un relanzamiento;
 *  4. quien rechazó la carrera no vuelve a recibirla, relance quien relance.
 *
 * Tarda unos tres minutos: espera vencimientos reales de la ronda final.
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
  console.log('\n1. La ronda final vence sin respuesta, y se relanza');
  let d = await esperarOferta(id, 1);
  assert(d.offers.some((o) => o.wave === 4 && o.intento === 1), 'intento 1: la ronda final le llega');
  d = await esperarEstado(id, 'UNASSIGNED', 130);
  assert(d.status === 'UNASSIGNED', 'nadie contesta: queda sin asignar');
  // Le llego y no la tomo: no es lo mismo que no haber nadie.
  assert(
    ultimaNotaSinAsignar(d) === 'Nadie aceptó la carrera',
    `la bitacora dice por que: «${ultimaNotaSinAsignar(d)}»`,
  );

  const r1 = await relanzar(id);
  assert(r1.status < 400, `relanzar responde ${r1.status}, no 500`, r1.body);
  d = await esperarOferta(id, 2);
  assert(d.intentoDespacho === 2, 'es el intento 2');
  assert(
    d.offers.some((o) => o.wave === 4 && o.intento === 2 && o.response === 'pending'),
    'y la ronda final vuelve a avisarle al mismo conductor',
  );
  assert(
    d.waveLog.filter((e) => e.intento === 2).length === 4,
    'el registro del intento 2 tiene sus cuatro oleadas, ni una mas',
  );

  /* ------------------------------------------------------------------ 2 */
  console.log('\n2. Vuelve a vencer; el conductor se acerca y se relanza otra vez');
  d = await esperarEstado(id, 'UNASSIGNED', 130);
  assert(d.status === 'UNASSIGNED', 'tampoco contesta el intento 2');
  await call('/v1/driver/position', { method: 'POST', token, body: { point: CERCA } });

  const r2 = await relanzar(id);
  assert(r2.status < 400, `segundo relanzamiento responde ${r2.status}`, r2.body);
  d = await esperarOferta(id, 3);
  assert(d.intentoDespacho === 3, 'es el intento 3');

  /*
   * El cambio de fondo. Antes, la oleada 1 de un relanzamiento excluia a
   * todo el que alguna vez vio la carrera; este conductor la vio dos veces
   * y no contesto, asi que nunca habria vuelto a recibirla por radio.
   */
  assert(
    d.offers.some((o) => o.wave === 1 && o.intento === 3 && o.response === 'pending'),
    'la oleada 1 vuelve a contar con quien no contesto',
  );

  /* ------------------------------------------------------------------ 3 */
  console.log('\n3. Esta vez la rechaza: un tercer relanzamiento ya no se la ofrece');
  const rechazo = await call(`/v1/driver/rides/${id}/reject`, { method: 'POST', token });
  assert(rechazo.status < 400, 'el conductor la rechaza', rechazo.body);
  d = await esperarEstado(id, 'UNASSIGNED', 20);
  assert(d.status === 'UNASSIGNED', 'sin nadie mas, queda sin asignar al instante');

  const r3 = await relanzar(id);
  assert(r3.status < 400, `tercer relanzamiento responde ${r3.status}`, r3.body);
  d = await esperarOferta(id, 4);
  assert(
    !d.offers.some((o) => o.intento === 4),
    'el intento 4 no le ofrece nada a quien la rechazo',
  );
  assert(
    d.waveLog.filter((e) => e.intento === 4).every((e) => e.candidates === 0),
    'y sus oleadas quedan registradas como vacias',
  );
  // Aqui no le llego a nadie: la nota no puede decir que «nadie acepto».
  d = await esperarEstado(id, 'UNASSIGNED', 10);
  assert(
    ultimaNotaSinAsignar(d) === 'Ninguna oleada encontró conductores',
    `y la bitacora lo distingue: «${ultimaNotaSinAsignar(d)}»`,
  );

  console.log('\n4. Limpieza');
  await call(`/v1/rides/${id}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Fin de la prueba' } });
  await call('/v1/driver/shift/close', { method: 'POST', token });
  console.log('  carrera cancelada y turno cerrado');

  console.log('\nok Relanzar funciona, y sirve para algo\n');
}

main().catch((e) => {
  console.error('\nLa prueba fallo:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
