import 'dotenv/config';

/**
 * El recorrido de las oleadas, tal como se ve desde el panel.
 *
 * El caso es el de las pruebas con un solo teléfono: un conductor en turno,
 * pero lejos, fuera de los 12 km de la tercera oleada. Las tres oleadas por
 * radio no lo encuentran nunca, así que sin la ronda final no habría forma
 * de ver un aviso llegando de verdad.
 *
 * Lo que se comprueba:
 *
 *  - que cada oleada quede registrada, también las que no hallaron a nadie
 *    —antes no dejaban rastro y el panel no podía contarlas—;
 *  - que las vacías pasen al instante, sin esperar el reloj;
 *  - que la ronda final llegue al conductor lejano y él pueda aceptarla;
 *  - que con `OLEADA_FINAL_A_TODOS=false` la carrera acabe sin asignar,
 *    como antes, para poder apagar esto cuando dejen de hacer falta pruebas.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-oleadas.ts <clave-de-api>
 *
 * El último punto depende de cómo se arrancó la API, así que la prueba lee
 * el mismo interruptor y comprueba el comportamiento que toca.
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;
const A_TODOS = (process.env.OLEADA_FINAL_A_TODOS ?? 'true') === 'true';

const CONDUCTOR = { code: '101', plate: 'UBP472' };
const APARTADOS = [
  { code: '102', plate: 'TQR118' },
  { code: '103', plate: 'SVM903' },
];
const PIN = '4821';

const CENTRO = { lat: 5.7803, lng: -73.1142 };
/** Unos 19 km al norte: fuera de los 12 km de la tercera oleada urbana. */
const LEJOS = { lat: 5.95, lng: -73.1142 };

interface WaveLogEntry {
  wave: number;
  startedAt: string;
  expiresAt: string | null;
  radiusKm: number | null;
  candidates: number;
  sinGps?: number;
}

interface Json { [k: string]: unknown }

async function call(
  path: string,
  o: { method?: string; body?: unknown; token?: string; apiKey?: boolean } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.apiKey && API_KEY) headers['x-api-key'] = API_KEY;
  const r = await fetch(`${BASE}${path}`, {
    method: o.method ?? 'GET',
    headers,
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  let body: Json = {};
  try { body = t ? (JSON.parse(t) as Json) : {}; } catch { body = { raw: t }; }
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
    body: { code: q.code, plate: q.plate, pin: PIN, device: 'prueba', install: `oleadas-${q.code}` },
  });
  assert(r.status < 400, `conductor ${q.code} entra`, r.body);
  return (r.body as { token: string }).token;
}

/** Espera a que el registro tenga `n` oleadas, o a que la carrera se asiente. */
async function esperarOleadas(rideId: string, n: number) {
  for (let i = 0; i < 40; i++) {
    const d = (await call(`/v1/rides/${rideId}`, { apiKey: true })).body as {
      status: string; waveLog: WaveLogEntry[]; offers: { wave: number; driverId: string; response: string }[];
    };
    if ((d.waveLog?.length ?? 0) >= n || d.status === 'UNASSIGNED') return d;
    await new Promise((r) => setTimeout(r, 250));
  }
  return (await call(`/v1/rides/${rideId}`, { apiKey: true })).body as {
    status: string; waveLog: WaveLogEntry[]; offers: { wave: number; driverId: string; response: string }[];
  };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('Falta la clave de API. Pasala como argumento o en TAX_API_KEY.');
    process.exitCode = 1;
    return;
  }
  console.log(`\n  (ronda final a todos: ${A_TODOS ? 'encendida' : 'apagada'})`);

  console.log('\n0. Un solo conductor en turno, lejos del punto');
  const activas = await call('/v1/rides?status=ASSIGNED,DRIVER_ARRIVED,IN_PROGRESS,NOTIFIED,PENDING', { apiKey: true });
  for (const v of Array.isArray(activas.body) ? (activas.body as { id: string }[]) : []) {
    await call(`/v1/rides/${v.id}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Limpieza' } });
  }
  for (const otro of APARTADOS) {
    const t = await entrar(otro);
    await call('/v1/driver/shift/close', { method: 'POST', token: t });
  }
  const token = await entrar(CONDUCTOR);
  await call('/v1/driver/shift/close', { method: 'POST', token });
  await call('/v1/driver/shift/open', { method: 'POST', token, body: { plate: CONDUCTOR.plate } });
  const pos = await call('/v1/driver/position', { method: 'POST', token, body: { point: LEJOS } });
  assert(pos.status < 400, 'el conductor reporta su posicion a unos 19 km', pos.body);

  console.log('\n1. Se pide una carrera en el centro');
  const creada = await call('/v1/rides', {
    method: 'POST',
    apiKey: true,
    body: { customerPhone: `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, pickup: { text: 'Carrera 21 # 24-18', point: CENTRO }, passengers: 1 },
  });
  assert(creada.status < 400, 'carrera creada', creada.body);
  const rideId = (creada.body as { id: string }).id;

  const esperadas = A_TODOS ? 4 : 3;
  const d = await esperarOleadas(rideId, esperadas);

  console.log('\n2. Las tres oleadas por radio quedan registradas, aunque no hallen a nadie');
  for (const ola of [1, 2, 3]) {
    const e = d.waveLog.find((x) => x.wave === ola);
    assert(Boolean(e), `la oleada ${ola} quedo en el registro`);
    assert(e!.candidates === 0, `  y no encontro a nadie en ${e!.radiusKm} km`);
    assert(e!.expiresAt === null, '  y paso al instante, sin esperar el reloj');
  }

  if (A_TODOS) {
    console.log('\n3. La ronda final llega al conductor lejano');
    const final = d.waveLog.find((x) => x.wave === 4);
    assert(Boolean(final), 'la ronda a todos quedo en el registro');
    assert(final!.radiusKm === null, '  sin limite de distancia');
    assert(final!.candidates === 1, `  con ${final!.candidates} conductor`);
    assert(final!.expiresAt !== null, '  y con su reloj corriendo');

    const oferta = d.offers.find((o) => o.wave === 4);
    assert(oferta?.response === 'pending', 'el conductor tiene la oferta pendiente');
    assert(d.status === 'NOTIFIED', 'la carrera esta notificada');

    const aceptar = await call(`/v1/driver/rides/${rideId}/accept`, { method: 'POST', token });
    assert(aceptar.status < 400, 'y puede aceptarla', aceptar.body);

    const tras = (await call(`/v1/rides/${rideId}`, { apiKey: true })).body as { status: string };
    assert(tras.status === 'ASSIGNED', 'la carrera queda asignada');
  } else {
    console.log('\n3. Sin ronda final: la carrera queda sin asignar, como antes');
    assert(!d.waveLog.some((x) => x.wave === 4), 'no hubo ronda a todos');
    assert(d.status === 'UNASSIGNED', 'y la carrera quedo sin asignar');
  }

  console.log('\n4. Limpieza');
  await call(`/v1/rides/${rideId}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Fin de la prueba' } });
  await call('/v1/driver/shift/close', { method: 'POST', token });
  console.log('  carrera cancelada y turno cerrado');

  console.log('\nok Las oleadas quedan registradas de punta a punta\n');
}

main().catch((e) => {
  console.error('\nLa prueba fallo:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
