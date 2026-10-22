import 'dotenv/config';

/**
 * La pausa del turno, de extremo a extremo.
 *
 * La pausa vivía solo en el teléfono: la PWA se pintaba «En pausa» sin
 * decírselo a nadie, el conductor seguía `AVAILABLE` en la base y la
 * siguiente recuperación de estado le devolvía la pantalla a «esperando
 * carrera» un segundo después.
 *
 * Lo que de verdad hay que comprobar no es que el endpoint responda 200, sino
 * que **al conductor en pausa no le llegan carreras**. Y para que esa prueba
 * no pase por vacía —un despacho roto también deja a todo el mundo sin
 * ofertas—, la misma carrera se repite con el turno reanudado: ahí sí tiene
 * que ofrecérsela.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-pausa.ts <clave-de-api>
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;

/** El que se pausa. Los otros dos se apartan para que la prueba sea nítida. */
const EN_PRUEBA = { code: '101', plate: 'UBP472' };
const APARTADOS = [
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

async function entrar(quien: { code: string; plate: string }): Promise<string> {
  const login = await call('/v1/auth/driver', {
    method: 'POST',
    body: { code: quien.code, plate: quien.plate, pin: PIN, device: 'prueba', install: `pausa-${quien.code}` },
  });
  assert(login.status < 400, `conductor ${quien.code} entra`, login.body);
  return (login.body as { token: string }).token;
}

/** Pide la carrera y espera a que salga la oleada 1. Devuelve a quién se ofreció. */
async function carreraYOfertas(etiqueta: string): Promise<{ rideId: string; ofertas: { driverId: string }[] }> {
  const creada = await call('/v1/rides', {
    method: 'POST',
    apiKey: true,
    body: {
      customerPhone: `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      customerName: etiqueta,
      pickup: { text: 'Carrera 21 # 24-18', reference: 'Frente a la plaza', point: CENTRO },
      dropoff: { text: 'Terminal de transportes', point: { lat: 5.7836, lng: -73.1177 } },
      vehicleType: 'sedan',
      passengers: 1,
    },
  });
  assert(creada.status < 400, `carrera creada (${etiqueta})`, creada.body);
  const rideId = (creada.body as { id: string }).id;

  // La oleada 1 dura 45 s; se espera lo justo para que haya salido.
  let ofertas: { driverId: string }[] = [];
  let consultable = false;
  for (let intento = 0; intento < 25; intento++) {
    const detalle = await call(`/v1/rides/${rideId}`, { apiKey: true });
    // Una clave sin el ámbito `rides:read` se ve igual que una oleada vacía,
    // y se acaba buscando el fallo en el despacho. Se comprueba una vez, no
    // en cada vuelta del bucle.
    consultable = detalle.status < 400;
    if (!consultable) break;

    const cuerpo = detalle.body as { status: string; offers: { driverId: string }[] };
    if (cuerpo.offers.length > 0) {
      ofertas = cuerpo.offers;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(consultable, 'la clave puede consultar la carrera');

  return { rideId, ofertas };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('Falta la clave de API. Pásala como argumento o en TAX_API_KEY.');
    process.exitCode = 1;
    return;
  }

  console.log('\n0. Limpieza: carreras activas y turnos de ejecuciones previas');
  const activas = await call('/v1/rides?status=ASSIGNED,DRIVER_ARRIVED,IN_PROGRESS,NOTIFIED', {
    apiKey: true,
  });
  const viejas = Array.isArray(activas.body) ? (activas.body as { id: string }[]) : [];
  for (const vieja of viejas) {
    await call(`/v1/rides/${vieja.id}/cancel`, {
      method: 'POST',
      apiKey: true,
      body: { reason: 'Limpieza de la prueba de pausa' },
    });
  }
  console.log(`  ${viejas.length} carreras liberadas`);

  /*
   * Los otros conductores se van del turno. Si quedaran disponibles, la
   * carrera de más abajo podría ofrecérseles a ellos y la prueba no sabría
   * distinguir «al pausado no le ofrecieron» de «le ofrecieron a otro».
   */
  for (const otro of APARTADOS) {
    const token = await entrar(otro);
    await call('/v1/driver/shift/close', { method: 'POST', token });
  }
  console.log(`  ${APARTADOS.length} conductores apartados`);

  console.log('\n1. El conductor abre turno y reporta posición');
  const token = await entrar(EN_PRUEBA);
  await call('/v1/driver/shift/close', { method: 'POST', token });

  const turno = await call('/v1/driver/shift/open', {
    method: 'POST',
    token,
    body: { plate: EN_PRUEBA.plate },
  });
  assert(turno.status < 400, 'abre turno', turno.body);

  const posicion = await call('/v1/driver/position', {
    method: 'POST',
    token,
    body: { point: { lat: CENTRO.lat + 0.001, lng: CENTRO.lng + 0.001 } },
  });
  assert(posicion.status < 400, 'reporta posición dentro de la oleada 1', posicion.body);

  const recienAbierto = await call('/v1/driver/rides/me', { token });
  const turnoAbierto = (recienAbierto.body as { shift: { paused: boolean } | null }).shift;
  assert(turnoAbierto !== null, 'la API confirma el turno abierto');
  assert(turnoAbierto?.paused === false, 'y que no está en pausa');

  console.log('\n2. Toma la pausa');
  const pausar = await call('/v1/driver/shift/pause', { method: 'POST', token });
  assert(pausar.status < 400, 'el servidor acepta la pausa', pausar.body);

  /*
   * Esta es la comprobación que faltaba. Antes la pausa no salía del
   * teléfono, así que aquí `paused` habría sido `false` y la PWA, al
   * recuperar el estado, se habría puesto en «esperando carrera» sola.
   */
  const enPausa = await call('/v1/driver/rides/me', { token });
  const estadoPausa = (enPausa.body as { shift: { paused: boolean } | null }).shift;
  assert(estadoPausa?.paused === true, 'y la recuperación de estado dice «en pausa»');

  console.log('\n3. En pausa no le llegan carreras');
  const durantePausa = await carreraYOfertas('Prueba de pausa — no debe ofrecerse');
  assert(
    durantePausa.ofertas.length === 0,
    'la oleada no le ofreció la carrera a nadie',
    durantePausa.ofertas,
  );

  await call(`/v1/rides/${durantePausa.rideId}/cancel`, {
    method: 'POST',
    apiKey: true,
    body: { reason: 'Fin del tramo en pausa' },
  });

  console.log('\n4. Pausar otra vez no es un error');
  /*
   * La cola sin conexión reenvía lo que no pudo mandar, y puede reenviar una
   * pausa que ya se aplicó. Si eso respondiera 409, la PWA le enseñaría al
   * conductor un error por algo que salió bien.
   */
  const repetida = await call('/v1/driver/shift/pause', { method: 'POST', token });
  assert(repetida.status < 400, 'repetir la pausa responde bien', repetida.body);

  console.log('\n5. Al reanudar, la misma carrera sí se le ofrece');
  const reanudar = await call('/v1/driver/shift/resume', { method: 'POST', token });
  assert(reanudar.status < 400, 'el servidor acepta la reanudación', reanudar.body);

  const trasReanudar = await call('/v1/driver/rides/me', { token });
  const estadoActivo = (trasReanudar.body as { shift: { paused: boolean } | null }).shift;
  assert(estadoActivo?.paused === false, 'y la recuperación de estado vuelve a «disponible»');

  const despues = await carreraYOfertas('Prueba de pausa — sí debe ofrecerse');
  assert(
    despues.ofertas.length > 0,
    `ahora sí se le ofrece (${despues.ofertas.length} oferta)`,
    despues.ofertas,
  );

  console.log('\n6. Con una carrera en curso no se puede pausar');
  const aceptar = await call(`/v1/driver/rides/${despues.rideId}/accept`, {
    method: 'POST',
    token,
  });
  assert(aceptar.status < 400, 'acepta la carrera', aceptar.body);

  const pausarEnCarrera = await call('/v1/driver/shift/pause', { method: 'POST', token });
  assert(pausarEnCarrera.status === 409, 'la pausa se rechaza con 409', pausarEnCarrera.status);
  assert(
    (pausarEnCarrera.body as { code?: string }).code === 'DRIVER_BUSY',
    'con DRIVER_BUSY',
    pausarEnCarrera.body,
  );

  console.log('\n7. Limpieza');
  await call(`/v1/rides/${despues.rideId}/cancel`, {
    method: 'POST',
    apiKey: true,
    body: { reason: 'Fin de la prueba de pausa' },
  });
  await call('/v1/driver/shift/close', { method: 'POST', token });
  console.log('  turno cerrado y carrera liberada');

  console.log('\n✓ La pausa se respeta de extremo a extremo\n');
}

main().catch((error) => {
  console.error('\nLa prueba falló:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
