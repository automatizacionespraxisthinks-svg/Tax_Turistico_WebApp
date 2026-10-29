import 'dotenv/config';
import { Pool } from 'pg';
import { haversineKm } from '@tax/shared';

/**
 * El destino que se descubre al final.
 *
 * Casi nadie dice a donde va por WhatsApp: lo dice ya montado en el carro.
 * Asi que la mayoria de carreras nacen con punto de partida y nada mas, y el
 * destino aparece cuando el conductor marca finalizada, donde quiera que
 * este. De ahi sale la distancia recorrida.
 *
 * Lo que se comprueba aqui no es que el numero se guarde, sino las tres
 * cosas que pueden salir mal:
 *
 *  - que la posicion del conductor pise un destino que el cliente SI habia
 *    dicho, y acabe midiendo otra cosa;
 *  - que un GPS sin senal o con una lectura absurda deje al conductor sin
 *    poder cerrar la carrera, con el cliente ya bajandose del carro.
 *
 * Como no se puede finalizar antes del mínimo a bordo que fija
 * `MIN_DURACION_CARRERA_MIN`, la prueba adelanta en la base la hora de
 * abordaje en vez de esperarlo.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-destino.ts <clave-de-api>
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;

const CONDUCTOR = { code: '101', plate: 'UBP472' };
const APARTADOS = [
  { code: '102', plate: 'TQR118' },
  { code: '103', plate: 'SVM903' },
];
const PIN = '4821';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

/**
 * El mínimo para finalizar lo fija `MIN_DURACION_CARRERA_MIN` en la API, así
 * que la prueba lo lee del mismo entorno en vez de dar los diez por hechos:
 * con la regla en otro número, retrasar once minutos no bastaba y la prueba
 * fallaba sin que nada estuviera roto.
 */
const MIN_A_BORDO = Number(process.env.MIN_DURACION_CARRERA_MIN ?? 10);

/** Como si el pasajero llevara un minuto más del mínimo a bordo. */
async function pasarTiempoABordo(rideId: string): Promise<void> {
  await pool.query(`update rides set started_at = now() - ($2::int * interval '1 minute') where id = $1`, [
    rideId,
    MIN_A_BORDO + 1,
  ]);
}

const CENTRO = { lat: 5.7803, lng: -73.1142 };
/** Unos 2 km al noreste, dentro de la zona Centro. */
const DONDE_TERMINA = { lat: 5.7865, lng: -73.1075 };

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
    body: { code: q.code, plate: q.plate, pin: PIN, device: 'prueba', install: `destino-${q.code}` },
  });
  assert(r.status < 400, `conductor ${q.code} entra`, r.body);
  return (r.body as { token: string }).token;
}

/** Crea la carrera, espera la oleada y la lleva hasta «a bordo». */
async function hastaABordo(token: string, dropoff?: unknown): Promise<string> {
  const creada = await call('/v1/rides', {
    method: 'POST',
    apiKey: true,
    body: {
      customerPhone: `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      customerName: 'Prueba de destino',
      pickup: { text: 'Carrera 21 # 24-18', point: CENTRO },
      ...(dropoff ? { dropoff } : {}),
      vehicleType: 'sedan',
      passengers: 1,
    },
  });
  assert(creada.status < 400, 'carrera creada', creada.body);
  const rideId = (creada.body as { id: string }).id;

  let ofrecida = false;
  for (let i = 0; i < 30; i++) {
    const d = await call(`/v1/rides/${rideId}`, { apiKey: true });
    if (((d.body as { offers?: unknown[] }).offers ?? []).length > 0) { ofrecida = true; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(ofrecida, 'la oleada se la ofrecio al conductor');

  const aceptar = await call(`/v1/driver/rides/${rideId}/accept`, { method: 'POST', token });
  assert(aceptar.status < 400, 'el conductor acepta', aceptar.body);
  const llegue = await call(`/v1/driver/rides/${rideId}/arrived`, { method: 'POST', token, body: { at: CENTRO } });
  assert(llegue.status < 400, 'marca que llego', llegue.body);
  const abordo = await call(`/v1/driver/rides/${rideId}/board`, { method: 'POST', token, body: { at: CENTRO } });
  assert(abordo.status < 400, 'el pasajero sube', abordo.body);
  await pasarTiempoABordo(rideId);
  return rideId;
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('Falta la clave de API. Pasala como argumento o en TAX_API_KEY.');
    process.exitCode = 1;
    return;
  }

  console.log('\n0. Limpieza y preparacion');
  const activas = await call('/v1/rides?status=ASSIGNED,DRIVER_ARRIVED,IN_PROGRESS,NOTIFIED', { apiKey: true });
  const viejas = Array.isArray(activas.body) ? (activas.body as { id: string }[]) : [];
  for (const v of viejas) {
    await call(`/v1/rides/${v.id}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Limpieza de la prueba' } });
  }
  for (const otro of APARTADOS) {
    const t = await entrar(otro);
    await call('/v1/driver/shift/close', { method: 'POST', token: t });
  }
  console.log(`  ${viejas.length} carreras liberadas, ${APARTADOS.length} conductores apartados`);

  const token = await entrar(CONDUCTOR);
  await call('/v1/driver/shift/close', { method: 'POST', token });
  await call('/v1/driver/shift/open', { method: 'POST', token, body: { plate: CONDUCTOR.plate } });
  await call('/v1/driver/position', { method: 'POST', token, body: { point: CENTRO } });

  /* ------------------------------------------------------------------ 1 */
  console.log('\n1. Sin destino: lo pone el conductor al finalizar');
  const r1 = await hastaABordo(token);
  const antes = await call(`/v1/rides/${r1}`, { apiKey: true });
  assert((antes.body as { dropoffLat: number | null }).dropoffLat === null, 'nace sin destino');

  const fin1 = await call(`/v1/driver/rides/${r1}/finish`, { method: 'POST', token, body: { at: DONDE_TERMINA } });
  assert(fin1.status < 400, 'el conductor la finaliza', fin1.body);

  const d1 = (await call(`/v1/rides/${r1}`, { apiKey: true })).body as {
    dropoffLat: number; dropoffLng: number; dropoffSource: string;
    distanceKm: number; status: string;
  };
  assert(d1.status === 'COMPLETED', 'queda completada');
  assert(d1.dropoffLat === DONDE_TERMINA.lat && d1.dropoffLng === DONDE_TERMINA.lng, 'el destino es donde paro el taxi');
  assert(d1.dropoffSource === 'conductor', 'y queda anotado que lo puso el conductor');
  assert(d1.distanceKm > 0, `con distancia de ${d1.distanceKm} km`);

  /* ------------------------------------------------------------------ 2 */
  console.log('\n2. Con destino dicho por el cliente: no se pisa');
  await call('/v1/driver/position', { method: 'POST', token, body: { point: CENTRO } });
  const DESTINO_DICHO = { lat: 5.7836, lng: -73.1177 };
  const r2 = await hastaABordo(token, { text: 'Terminal de transportes', point: DESTINO_DICHO });

  const fin2 = await call(`/v1/driver/rides/${r2}/finish`, { method: 'POST', token, body: { at: DONDE_TERMINA } });
  assert(fin2.status < 400, 'la finaliza en otro sitio distinto', fin2.body);

  const d2 = (await call(`/v1/rides/${r2}`, { apiKey: true })).body as {
    dropoffLat: number; dropoffSource: string; distanceKm: number;
  };
  assert(d2.dropoffLat === DESTINO_DICHO.lat, 'el destino sigue siendo el que dijo el cliente');
  assert(d2.dropoffSource === 'cliente', 'y asi queda anotado');

  /*
   * Y la distancia se mide hasta AHI, no hasta donde paro el taxi.
   *
   * Comprobar solo que es mayor que cero no sirve: con el destino
   * equivocado tambien sale un numero positivo, y la prueba pasaria
   * tranquilamente mientras los informes se llenan de distancias medidas
   * contra el punto que no era. El factor 1.25 es la tortuosidad de la zona
   * Centro, que es lo que la API aplica a la linea recta.
   */
  const esperada = Math.round(haversineKm(CENTRO, DESTINO_DICHO) * 1.25 * 100) / 100;
  const hastaDondeParo = Math.round(haversineKm(CENTRO, DONDE_TERMINA) * 1.25 * 100) / 100;
  assert(
    Math.abs(d2.distanceKm - esperada) < 0.05,
    `la distancia es ${d2.distanceKm} km, la del destino dicho (${esperada}), no la de donde paro (${hastaDondeParo})`,
    d2,
  );

  /* ------------------------------------------------------------------ 3 */
  console.log('\n3. Sin GPS: el conductor cierra igual');
  await call('/v1/driver/position', { method: 'POST', token, body: { point: CENTRO } });
  const r3 = await hastaABordo(token);
  const fin3 = await call(`/v1/driver/rides/${r3}/finish`, { method: 'POST', token, body: {} });
  assert(fin3.status < 400, 'cierra sin mandar ubicacion', fin3.body);

  const d3 = (await call(`/v1/rides/${r3}`, { apiKey: true })).body as {
    status: string; distanceKm: number | null; dropoffLat: number | null;
  };
  assert(d3.status === 'COMPLETED', 'la carrera queda completada igual');
  assert(d3.distanceKm === null && d3.dropoffLat === null, 'y sin distancia, que es preferible a una inventada');

  /* ------------------------------------------------------------------ 4 */
  console.log('\n4. GPS con lectura absurda: se descarta, pero cierra');
  await call('/v1/driver/position', { method: 'POST', token, body: { point: CENTRO } });
  const r4 = await hastaABordo(token);
  // (0, 0) es el golfo de Guinea: once mil kilometros de Paipa.
  const fin4 = await call(`/v1/driver/rides/${r4}/finish`, { method: 'POST', token, body: { at: { lat: 0, lng: 0 } } });
  assert(fin4.status < 400, 'cierra aunque el GPS devuelva (0, 0)', fin4.body);

  const d4 = (await call(`/v1/rides/${r4}`, { apiKey: true })).body as {
    status: string; distanceKm: number | null; dropoffLat: number | null;
  };
  assert(d4.status === 'COMPLETED', 'la carrera queda completada');
  assert(d4.dropoffLat === null, 'el punto absurdo NO se guardo como destino');
  assert(d4.distanceKm === null, 'ni se invento una distancia de once mil kilometros');

  console.log('\n5. Limpieza');
  await call('/v1/driver/shift/close', { method: 'POST', token });
  console.log('  turno cerrado');

  console.log('\nok La distancia queda registrada sin estorbarle al conductor\n');
}

main()
  .catch((e) => {
    console.error('\nLa prueba fallo:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
