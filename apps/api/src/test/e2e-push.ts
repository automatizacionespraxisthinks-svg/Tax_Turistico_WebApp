import 'dotenv/config';
import { createECDH, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema';

/**
 * Prueba de Web Push contra la API en marcha (ADR-07).
 *
 * El navegador de pruebas deniega las notificaciones, así que lo que se
 * comprueba aquí es la otra mitad, la que vive en el servidor: que la API
 * cifra el aviso y lo entrega al servicio de push con las cabeceras
 * correctas, que no filtra datos del cliente por el camino, y que limpia la
 * suscripción cuando el servicio dice que caducó.
 *
 * Se levanta un servicio de push falso en local y se apunta la suscripción
 * del conductor ahí: desde el punto de vista de la API es indistinguible del
 * de Google.
 *
 * El falso habla HTTPS porque `web-push` llama siempre a `https.request`, sin
 * mirar el protocolo del endpoint; contra un servidor de texto plano el
 * saludo TLS falla con EPROTO y el envío no sale nunca. De ahí el certificado
 * autofirmado, que la API tiene que aceptar:
 *
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
 *     -keyout .certs/localhost.key -out .certs/localhost.crt \
 *     -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
 *
 *   NODE_EXTRA_CA_CERTS=.certs/localhost.crt node -r dotenv/config dist/main.js
 *   pnpm --filter @tax/api exec tsx src/test/e2e-push.ts <clave-de-api>
 *
 * `NODE_EXTRA_CA_CERTS` añade esa autoridad a las de siempre en vez de apagar
 * la verificación entera con NODE_TLS_REJECT_UNAUTHORIZED: así lo que se
 * prueba sigue siendo el camino real, con TLS verificado de verdad.
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;
const FAKE_PORT = 4555;
const CENTRO = { lat: 5.7803, lng: -73.1142 };

const DRIVER = { code: '101', plate: 'UBP472' };
const PIN = '4821';
/** Fijo a propósito: dos accesos con el mismo deben reutilizar el dispositivo. */
const INSTALL = 'prueba-push-instalacion-fija';

interface Recibido {
  headers: IncomingMessage['headers'];
  bytes: number;
}

function assert(condition: boolean, message: string, context?: unknown): void {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    if (context !== undefined) console.error('    ', JSON.stringify(context));
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; token?: string; apiKey?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (options.body) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.apiKey) headers['x-api-key'] = API_KEY!;

  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

/** Claves de una suscripción real: par ECDH P-256 más el secreto de auth. */
function nuevaSuscripcion(endpoint: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    expirationTime: null,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('Falta la clave de API.');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://tax:tax_dev_password@localhost:55432/tax',
    max: 2,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  const recibidos: Recibido[] = [];
  let responder = 201;

  const fake = createServer(
    {
      key: readFileSync(join(__dirname, '../../.certs/localhost.key')),
      cert: readFileSync(join(__dirname, '../../.certs/localhost.crt')),
    },
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        recibidos.push({ headers: request.headers, bytes: Buffer.concat(chunks).length });
        response.writeHead(responder).end();
      });
    },
  );

  await new Promise<void>((resolve) => fake.listen(FAKE_PORT, resolve));
  console.log(`Servicio de push falso escuchando en el puerto ${FAKE_PORT}\n`);

  const reportarPosicion = (token: string) =>
    call('/v1/driver/position', {
      method: 'POST',
      token,
      body: { point: { lat: CENTRO.lat + 0.001, lng: CENTRO.lng + 0.001 } },
    });

  try {
    console.log(`1. El conductor ${DRIVER.code} entra desde el mismo celular dos veces`);

    const entrar = () =>
      call('/v1/auth/driver', {
        method: 'POST',
        body: {
          code: DRIVER.code,
          plate: DRIVER.plate,
          pin: PIN,
          device: 'Celular de prueba',
          install: INSTALL,
        },
      });

    const primero = await entrar();
    assert(primero.status < 400, 'primer acceso', primero);
    const segundo = await entrar();
    assert(segundo.status < 400, 'segundo acceso desde la misma instalación', segundo);
    const token = (segundo.body as { token: string }).token;

    const [driver] = await db
      .select({ id: schema.drivers.id })
      .from(schema.drivers)
      .where(eq(schema.drivers.code, DRIVER.code))
      .limit(1);
    assert(Boolean(driver), `el conductor ${DRIVER.code} existe`);

    const vivos = await db
      .select({ id: schema.driverDevices.id })
      .from(schema.driverDevices)
      .where(
        and(
          eq(schema.driverDevices.driverId, driver!.id),
          eq(schema.driverDevices.installId, INSTALL),
          isNull(schema.driverDevices.revokedAt),
        ),
      );
    // Lo que cuenta: dos accesos del mismo celular dejan un dispositivo, no
    // dos. Si no, el conductor recibiría la misma oferta una vez por acceso.
    // Puede tener otros celulares registrados; esos son otra instalación.
    assert(vivos.length === 1, 'el celular reutiliza su dispositivo', vivos.length);
    const deviceId = vivos[0]!.id;

    // El token anterior se invalida al emitir el nuevo: es la misma fila.
    const conViejo = await call('/v1/driver/rides/me', {
      token: (primero.body as { token: string }).token,
    });
    assert(conViejo.status === 401, 'el acceso anterior queda invalidado', conViejo.status);

    await call('/v1/driver/shift/close', { method: 'POST', token });
    const turno = await call('/v1/driver/shift/open', {
      method: 'POST',
      token,
      body: { plate: DRIVER.plate },
    });
    assert(turno.status < 400, 'abre turno', turno);

    const posicion = await reportarPosicion(token);
    assert(posicion.status < 400, 'reporta posición', posicion);

    console.log('\n2. El celular se registra para recibir avisos');

    const clave = await call('/v1/driver/push/key', { token });
    const { enabled, publicKey } = clave.body as { enabled: boolean; publicKey: string | null };
    assert(enabled && Boolean(publicKey), 'el servidor publica su clave VAPID');

    const suscripcion = nuevaSuscripcion(`https://localhost:${FAKE_PORT}/push/abc123`);
    const registro = await call('/v1/driver/push/subscribe', {
      method: 'POST',
      token,
      body: suscripcion,
    });
    assert(registro.status < 400, 'la suscripción queda registrada', registro);

    const [guardada] = await db
      .select({ sub: schema.driverDevices.pushSubscription })
      .from(schema.driverDevices)
      .where(eq(schema.driverDevices.id, deviceId));
    assert(Boolean(guardada?.sub), 'y queda asociada a ese dispositivo');

    console.log('\n3. El agente crea una carrera y sale la oleada');
    const creada = await call('/v1/rides', {
      method: 'POST',
      apiKey: true,
      body: {
        customerPhone: `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        customerName: 'Prueba de avisos',
        pickup: { text: 'Carrera 21 # 24-18', point: CENTRO },
        vehicleType: 'sedan',
        passengers: 1,
      },
    });
    assert(creada.status === 201, `carrera creada (HTTP ${creada.status})`, creada.body);

    // La oleada y el envío son asíncronos: se espera a que llegue.
    for (let i = 0; i < 40 && recibidos.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    console.log('\n4. El aviso llegó al servicio de push');
    assert(recibidos.length > 0, `se recibió ${recibidos.length} envío(s)`);

    // Se deja correr un momento más: si quedaran dispositivos duplicados de
    // accesos anteriores, sus envíos llegarían ahora.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert(recibidos.length === 1, 'salió un solo aviso, no uno por acceso', recibidos.length);

    const aviso = recibidos[0]!;
    assert(
      String(aviso.headers.authorization ?? '').startsWith('vapid '),
      'va firmado con VAPID',
      aviso.headers.authorization,
    );
    assert(aviso.headers['content-encoding'] === 'aes128gcm', 'el cuerpo va cifrado (aes128gcm)');
    assert(aviso.bytes > 0, `el cuerpo cifrado ocupa ${aviso.bytes} bytes`);
    assert(aviso.headers.ttl === '60', 'caduca en 60 s, la ventana de la oleada', aviso.headers.ttl);
    assert(aviso.headers.urgency === 'high', 'marcado como urgente');
    assert(Boolean(aviso.headers.topic), 'lleva topic para reemplazar el aviso anterior');

    console.log('\n5. El contenido no filtra datos del cliente');
    // El cuerpo va cifrado de extremo a extremo: ni el servicio de push ni
    // esta prueba pueden leerlo. Lo que sí se comprueba es que las cabeceras,
    // que sí van en claro, no lleven nada identificable.
    const enClaro = JSON.stringify(aviso.headers).toLowerCase();
    assert(!enClaro.includes('+57'), 'ningún teléfono en las cabeceras');
    assert(!enClaro.includes('carrera 21'), 'ninguna dirección en las cabeceras');

    console.log('\n6. Una suscripción caducada se retira sola');
    responder = 410; // «Gone»: el navegador rotó la suscripción
    recibidos.length = 0;

    // El GPS caduca a los 60 s: se refresca para que el conductor vuelva a
    // ser candidato de esta segunda oleada.
    await reportarPosicion(token);

    await call('/v1/rides', {
      method: 'POST',
      apiKey: true,
      body: {
        customerPhone: `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        pickup: { text: 'Calle 23 # 5-82', point: CENTRO },
        vehicleType: 'sedan',
        passengers: 1,
      },
    });

    for (let i = 0; i < 40 && recibidos.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(recibidos.length > 0, 'se intentó el envío');

    // La limpieza ocurre tras la respuesta del servicio.
    let limpia = false;
    for (let i = 0; i < 20 && !limpia; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const [row] = await db
        .select({ sub: schema.driverDevices.pushSubscription })
        .from(schema.driverDevices)
        .where(eq(schema.driverDevices.id, deviceId));
      limpia = !row?.sub;
    }
    assert(limpia, 'la suscripción caducada se borró de la base');

    // Se deja el turno cerrado para no dejar al conductor recibiendo ofertas.
    await call('/v1/driver/shift/close', { method: 'POST', token });

    console.log('\nTodo correcto.\n');
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('\nLa prueba falló:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
