import 'dotenv/config';

/**
 * Prueba de extremo a extremo del despacho, contra la API en marcha.
 *
 * Recorre el camino real: entrar al turno, reportar posición, crear la
 * carrera por el contrato de n8n y hacer que varios conductores acepten EN EL
 * MISMO INSTANTE. Lo que se comprueba es RF-23: exactamente uno gana y los
 * demás reciben «carrera ya tomada».
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-dispatch.ts <clave-de-api>
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;

const DRIVERS = [
  { code: '101', plate: 'UBP472' },
  { code: '102', plate: 'TQR118' },
  { code: '103', plate: 'SVM903' },
];

const PIN = '4821';
const CENTRO = { lat: 5.7803, lng: -73.1142 };

interface Json {
  [key: string]: unknown;
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; token?: string; apiKey?: boolean } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.apiKey && API_KEY) headers['x-api-key'] = API_KEY;

  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

function assert(condition: boolean, message: string, context?: unknown): void {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    if (context !== undefined) console.error('    respuesta:', JSON.stringify(context));
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('Falta la clave de API. Pásala como argumento o en TAX_API_KEY.');
    process.exitCode = 1;
    return;
  }

  console.log('\n0. Limpieza: liberar carreras activas de ejecuciones previas');
  const active = await call('/v1/rides?status=ASSIGNED,DRIVER_ARRIVED,IN_PROGRESS', {
    apiKey: true,
  });
  const stale = Array.isArray(active.body) ? (active.body as { id: string }[]) : [];
  for (const old of stale) {
    await call(`/v1/rides/${old.id}/cancel`, {
      method: 'POST',
      apiKey: true,
      body: { reason: 'Limpieza de la prueba automatizada' },
    });
  }
  console.log(`  ${stale.length} carreras liberadas`);

  console.log('\n1. Conductores entran al turno y reportan posición');
  const tokens: string[] = [];

  for (const driver of DRIVERS) {
    const login = await call('/v1/auth/driver', {
      method: 'POST',
      body: {
        code: driver.code,
        plate: driver.plate,
        pin: PIN,
        device: 'prueba',
        // Fijo por conductor: la prueba se ejecuta muchas veces y sin esto
        // dejaría un dispositivo vivo más en cada pasada.
        install: `prueba-e2e-${driver.code}`,
      },
    });
    assert(login.status === 201 || login.status === 200, `conductor ${driver.code} entra`, login);
    const token = (login.body as { token: string }).token;
    tokens.push(token);

    // Si quedó un turno abierto de una ejecución anterior, se cierra primero.
    await call('/v1/driver/shift/close', { method: 'POST', token });
    const shift = await call('/v1/driver/shift/open', {
      method: 'POST',
      token,
      body: { plate: driver.plate },
    });
    assert(shift.status < 400, `conductor ${driver.code} abre turno`, shift);

    // Todos a pocos metros del centro, dentro del radio de la oleada 1.
    const position = await call('/v1/driver/position', {
      method: 'POST',
      token,
      body: {
        point: { lat: CENTRO.lat + Math.random() * 0.002, lng: CENTRO.lng + Math.random() * 0.002 },
      },
    });
    assert(position.status < 400, `conductor ${driver.code} reporta posición`, position);
  }

  console.log('\n2. El agente crea la carrera por el contrato de n8n');
  const created = await call('/v1/rides', {
    method: 'POST',
    apiKey: true,
    body: {
      customerPhone: `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      customerName: 'Prueba de concurrencia',
      pickup: { text: 'Carrera 21 # 24-18', reference: 'Frente a la plaza', point: CENTRO },
      dropoff: { text: 'Terminal de transportes', point: { lat: 5.7836, lng: -73.1177 } },
      vehicleType: 'sedan',
      passengers: 1,
    },
  });

  assert(created.status < 400, `carrera creada (HTTP ${created.status})`, created);
  const ride = created.body as { id: string; code: string; fareEstimate: number };
  assert(Boolean(ride.id), `tiene identificador: ${ride.code}`);
  assert(ride.fareEstimate > 0, `tarifa estimada calculada: ${ride.fareEstimate}`);

  console.log('\n3. Esperando a que salga la oleada 1');
  let offers: unknown[] = [];
  for (let attempt = 0; attempt < 25; attempt++) {
    const detail = await call(`/v1/rides/${ride.id}`, { apiKey: true });
    // Sin esto, una clave sin el ámbito rides:read se ve igual que una oleada
    // vacía, y se acaba buscando el fallo en el despacho.
    assert(detail.status < 400, 'la clave puede consultar la carrera', detail.body);
    const body = detail.body as { status: string; offers: unknown[] };
    if (body.status === 'NOTIFIED' && body.offers.length > 0) {
      offers = body.offers;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert(offers.length > 0, `la oleada ofreció a ${offers.length} conductores`);

  console.log('\n4. Todos aceptan a la vez');
  const results = await Promise.all(
    tokens.map((token) =>
      call(`/v1/driver/rides/${ride.id}/accept`, { method: 'POST', token }),
    ),
  );

  const winners = results.filter((r) => r.status < 400);
  const losers = results.filter((r) => r.status >= 400);

  console.log(
    `  respuestas: ${results.map((r) => `${r.status}:${(r.body as { code?: string }).code ?? 'ok'}`).join('  ')}`,
  );

  assert(winners.length === 1, `exactamente un conductor gana (fueron ${winners.length})`);
  assert(
    losers.every((r) => {
      const code = (r.body as { code?: string }).code;
      return code === 'RIDE_ALREADY_TAKEN' || code === 'OFFER_NOT_VALID';
    }),
    'los demás reciben «carrera ya tomada» con código estable',
  );

  console.log('\n5. La carrera queda asignada a uno solo');
  const after = await call(`/v1/rides/${ride.id}`, { apiKey: true });
  const finalRide = after.body as { status: string; driverId: string | null; version: number };
  assert(finalRide.status === 'ASSIGNED', `estado final: ${finalRide.status}`);
  assert(Boolean(finalRide.driverId), 'tiene un conductor asignado');
  assert(finalRide.version >= 2, `la versión avanzó a ${finalRide.version}`);

  console.log('\n6. El ganador completa el ciclo de vida');
  const winnerToken = tokens[results.findIndex((r) => r.status < 400)]!;

  for (const [step, label] of [
    ['arrived', 'llegó al punto'],
    ['board', 'pasajero a bordo'],
    ['finish', 'finalizó la carrera'],
  ] as const) {
    const response = await call(`/v1/driver/rides/${ride.id}/${step}`, {
      method: 'POST',
      token: winnerToken,
      body: { at: CENTRO },
    });
    assert(response.status < 400, `el conductor ${label}`, response);
  }

  const completed = await call(`/v1/rides/${ride.id}`, { apiKey: true });
  assert(
    (completed.body as { status: string }).status === 'COMPLETED',
    'la carrera queda finalizada',
    completed,
  );

  console.log('\n7. Idempotencia: la misma clave no crea dos carreras');
  const key = `prueba-${Date.now()}`;
  const payload = {
    customerPhone: `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    pickup: { text: 'Calle 23 # 5-82', point: CENTRO },
    vehicleType: 'sedan',
    passengers: 1,
  };

  const conClave = async () => {
    const response = await fetch(`${BASE}/v1/rides`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'idempotency-key': key },
      body: JSON.stringify(payload),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown> & { code?: string },
    };
  };

  const first = await conClave();
  const second = await conClave();

  assert(first.status === 201, `la primera crea la carrera (HTTP ${first.status})`, first.body);
  assert(
    second.status === first.status,
    `la repetición devuelve el mismo estado (HTTP ${second.status})`,
  );
  assert(
    first.body.id === second.body.id,
    `la segunda llamada devuelve la misma carrera ${first.body.code}`,
  );

  /*
   * Y la misma respuesta entera, no solo el mismo identificador.
   *
   * La repetida sale de la columna `jsonb`, que reordena las claves al
   * guardarlas, así que comparar el texto daría un falso negativo: hay que
   * ordenar las claves en profundidad antes de comparar. Lo que importa es
   * que n8n reintentando un webhook reciba exactamente los mismos campos con
   * los mismos valores, no en qué orden vienen.
   */
  const ordenar = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordenar);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((k) => [k, ordenar((value as Record<string, unknown>)[k])]),
      );
    }
    return value;
  };

  const campos = (body: Record<string, unknown>) => Object.keys(body).sort().join(',');
  assert(
    campos(first.body) === campos(second.body),
    `lleva los mismos ${Object.keys(first.body).length} campos`,
    { primera: campos(first.body), segunda: campos(second.body) },
  );
  assert(
    JSON.stringify(ordenar(first.body)) === JSON.stringify(ordenar(second.body)),
    'con exactamente los mismos valores',
  );

  console.log('\nTodo correcto.\n');
}

main().catch((error: unknown) => {
  console.error('\nLa prueba falló:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
