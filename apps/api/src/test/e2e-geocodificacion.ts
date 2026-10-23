import 'dotenv/config';

/**
 * El punto de recogida, resuelto por la API y no por el agente.
 *
 * Por WhatsApp la gente escribe «Cra. 12 A # 31B-14», no coordenadas. Antes
 * las resolvia el agente de n8n y se las pasaba a la API; ahora manda solo
 * texto y las resuelve la API. Un modelo que copia coordenadas de una
 * respuesta a otra puede cambiar un digito sin que nadie lo note, y un
 * digito en la cuarta decimal son once metros.
 *
 * Esta prueba comprueba el cableado, no al geocodificador:
 *
 *  - que una ubicacion compartida siga mandando sobre cualquier otra cosa;
 *  - que quede anotado de donde salio el punto;
 *  - que sin poder resolver la direccion la API lo diga con un mensaje que
 *    le sirva al agente para saber que pedir, en vez de un error opaco.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-geocodificacion.ts <clave-de-api>
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;
const HAY_GEOCODIFICADOR = Boolean(process.env.GOOGLE_GEOCODING_API_KEY);

const CENTRO = { lat: 5.7803, lng: -73.1142 };

interface Json { [k: string]: unknown }

async function call(path: string, o: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (API_KEY) headers['x-api-key'] = API_KEY;
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

const telefono = () => `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('Falta la clave de API. Pasala como argumento o en TAX_API_KEY.');
    process.exitCode = 1;
    return;
  }

  console.log('\n1. Con ubicacion compartida: manda esa, sin geocodificar nada');
  const conPunto = await call('/v1/rides', {
    method: 'POST',
    body: {
      customerPhone: telefono(),
      pickup: { text: 'Donde sea que diga este texto', point: CENTRO },
      passengers: 1,
    },
  });
  assert(conPunto.status < 400, 'la carrera se crea', conPunto.body);

  const id1 = (conPunto.body as { id: string }).id;
  const d1 = (await call(`/v1/rides/${id1}`)).body as {
    pickupLat: number; pickupLng: number; pickupSource: string;
  };
  assert(d1.pickupLat === CENTRO.lat && d1.pickupLng === CENTRO.lng, 'con el punto exacto que se mando');
  assert(d1.pickupSource === 'compartida', 'y anotado como ubicacion compartida');

  await call(`/v1/rides/${id1}/cancel`, { method: 'POST', body: { reason: 'Fin de la prueba' } });

  console.log('\n2. Solo con direccion en texto');
  const soloTexto = await call('/v1/rides', {
    method: 'POST',
    body: {
      customerPhone: telefono(),
      pickup: { text: 'Carrera 21 # 24-18, frente a la plaza' },
      passengers: 1,
    },
  });

  if (HAY_GEOCODIFICADOR) {
    assert(soloTexto.status < 400, 'la API la resuelve sola', soloTexto.body);
    const id2 = (soloTexto.body as { id: string }).id;
    const d2 = (await call(`/v1/rides/${id2}`)).body as {
      pickupLat: number; pickupLng: number; pickupSource: string; pickupText: string;
    };
    assert(d2.pickupSource === 'geocodificada', 'anotada como geocodificada');
    assert(Number.isFinite(d2.pickupLat), `con coordenadas ${d2.pickupLat}, ${d2.pickupLng}`);
    // Lo que lee el conductor sigue siendo lo que escribio el cliente.
    assert(
      d2.pickupText === 'Carrera 21 # 24-18, frente a la plaza',
      'y el conductor sigue viendo la direccion con su numero',
    );
    await call(`/v1/rides/${id2}/cancel`, { method: 'POST', body: { reason: 'Fin de la prueba' } });
  } else {
    /*
     * Sin clave configurada la API no adivina. Lo importante no es que
     * falle, sino COMO: el agente tiene que poder deducir que lo siguiente
     * es pedirle la ubicacion al cliente, no reintentar lo mismo.
     */
    assert(soloTexto.status === 422, 'sin geocodificador responde 422', soloTexto.status);
    const cuerpo = soloTexto.body as { code?: string; detail?: string };
    assert(cuerpo.code === 'MISSING_LOCATION', 'con MISSING_LOCATION', cuerpo.code);
    assert(
      (cuerpo.detail ?? '').toLowerCase().includes('comparta su ubicaci'),
      `y un detalle que dice que hacer: «${cuerpo.detail}»`,
    );
    console.log('\n  (sin GOOGLE_GEOCODING_API_KEY: no se probo la resolucion real)');
  }

  console.log('\n3. Una direccion que no existe en ningun lado');
  const inventada = await call('/v1/rides', {
    method: 'POST',
    body: {
      customerPhone: telefono(),
      pickup: { text: 'asdfgh qwerty zxcvbn 12345' },
      passengers: 1,
    },
  });
  assert(inventada.status === 422, 'tambien se rechaza con 422', inventada.status);
  assert(
    (inventada.body as { code?: string }).code === 'MISSING_LOCATION',
    'y no se crea una carrera con un punto inventado',
  );

  console.log('\nok El punto lo resuelve la API, y cuando no puede lo dice claro\n');
}

main().catch((e) => {
  console.error('\nLa prueba fallo:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
