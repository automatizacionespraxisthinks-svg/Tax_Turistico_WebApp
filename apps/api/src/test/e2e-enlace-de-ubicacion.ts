import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../db/schema';

/**
 * El enlace de ubicación del cliente, de extremo a extremo, más lo que usa
 * de la API el flujo de n8n.
 *
 *  - La carrera guarda el enlace que mandó el cliente (el que abre «Ir con
 *    Maps») y saca el punto de él si n8n no lo manda aparte.
 *  - Un enlace que no es de mapas no se guarda ni da el punto.
 *  - Si la ubicación cae en un lugar del catálogo, el conductor lee su nombre.
 *  - `PATCH /address` acepta el cuerpo envuelto en `pickup` (así lo mandaba
 *    el flujo y la API lo rechazaba) y una ubicación nueva reemplaza la vieja.
 *  - `PATCH /payment` con `relanzar` cambia a efectivo y relanza de una vez.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-enlace-de-ubicacion.ts <clave-de-api>
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;
const LUGAR = { name: 'Lugar De Prueba Enlace', lat: 5.7795, lng: -73.1133 };

interface Json {
  [key: string]: unknown;
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

async function call(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { 'x-api-key': API_KEY ?? '' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Json) : {} };
}

const telefono = () => `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('Falta la clave de API. Pásala como argumento o en TAX_API_KEY.');
    process.exitCode = 1;
    return;
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://tax:tax_dev_password@localhost:55432/tax',
    max: 2,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  const creadas: string[] = [];
  const lugarId = uuidv7();

  try {
    await db.insert(schema.places).values({ id: lugarId, name: LUGAR.name, kind: 'urbano', lat: LUGAR.lat, lng: LUGAR.lng, aliases: [] });

    console.log('\n1. La ubicación llega como enlace, sin punto aparte');
    const enlace = `https://www.google.com/maps?q=${LUGAR.lat + 0.0002},${LUGAR.lng}`;
    const uno = await call('/v1/rides', 'POST', {
      customerPhone: telefono(),
      pickup: { text: 'Carrera 21 # 24-18, Centro, Paipa', link: enlace },
      pagoElectronico: false,
    });
    assert(uno.status < 400, 'la carrera se crea', uno.body);
    creadas.push(uno.body.id as string);
    assert(uno.body.pickupSource === 'compartida', 'cuenta como ubicación compartida', uno.body.pickupSource);
    assert(uno.body.pickupLat === LUGAR.lat + 0.0002 && uno.body.pickupLng === LUGAR.lng, 'el punto sale del enlace', [uno.body.pickupLat, uno.body.pickupLng]);
    assert(uno.body.pickupLink === enlace, 'guarda el enlace tal cual (el que abre «Ir con Maps»)', uno.body.pickupLink);
    assert(String(uno.body.pickupText).startsWith(`${LUGAR.name}. `), 'cae en un lugar del catálogo y el conductor lee su nombre', uno.body.pickupText);

    console.log('\n2. Un enlace que no es de mapas no cuenta');
    const dos = await call('/v1/rides', 'POST', {
      customerPhone: telefono(),
      pickup: { text: 'Calle 25 # 18-40', link: `https://estafa.example.com/maps?q=${LUGAR.lat},${LUGAR.lng}` },
    });
    assert(dos.status < 400, 'la carrera se crea igual', dos.body);
    creadas.push(dos.body.id as string);
    assert(dos.body.pickupLink === null, 'no guarda el enlace', dos.body.pickupLink);
    assert(dos.body.pickupSource !== 'compartida', 'ni lo toma como ubicación compartida', dos.body.pickupSource);

    console.log('\n3. Corregir la dirección como la manda el flujo de n8n');
    const id = uno.body.id as string;
    const envuelta = await call(`/v1/rides/${id}/address`, 'PATCH', {
      pickup: { text: String(uno.body.pickupText), reference: 'Portón negro' },
    });
    assert(envuelta.status < 400, 'el cuerpo envuelto en «pickup» ya no da VALIDATION_FAILED', envuelta.body);
    assert(envuelta.body.pickupReference === 'Portón negro', 'agrega la referencia', envuelta.body.pickupReference);
    assert(envuelta.body.pickupLink === enlace, 'sin ubicación nueva conserva el enlace', envuelta.body.pickupLink);

    const otro = `https://www.google.com/maps/place/Otro/@5.7700,-73.1200,17z/data=!3d5.7712345!4d-73.1187654`;
    const nueva = await call(`/v1/rides/${id}/address`, 'PATCH', { text: 'Otro sitio', link: otro });
    assert(nueva.status < 400, 'una ubicación nueva por enlace se acepta', nueva.body);
    assert(nueva.body.pickupLat === 5.7712345 && nueva.body.pickupLng === -73.1187654, 'el punto pasa al del enlace nuevo', [nueva.body.pickupLat, nueva.body.pickupLng]);
    assert(nueva.body.pickupLink === otro, 'y el enlace viejo se reemplaza', nueva.body.pickupLink);

    // Una carrera que no se pudo ubicar y a la que el cliente le comparte la
    // ubicación después: antes seguía `sin_ubicar` y la PWA no mostraba el punto.
    const sinUbicar = await call('/v1/rides', 'POST', {
      customerPhone: telefono(),
      pickup: { text: 'Donde la señora Rosa, subiendo por el camino de tierra' },
    });
    creadas.push(sinUbicar.body.id as string);
    assert(sinUbicar.body.pickupSource === 'sin_ubicar', 'una dirección que no se ubica queda sin ubicar', sinUbicar.body.pickupSource);
    const compartida = await call(`/v1/rides/${sinUbicar.body.id as string}/address`, 'PATCH', {
      text: 'Vereda El Rosal, Paipa',
      point: { lat: 5.7651234, lng: -73.1301234 },
      link: 'https://www.google.com/maps?q=5.7651234,-73.1301234',
    });
    assert(compartida.body.pickupSource === 'compartida', 'al compartir la ubicación después pasa a compartida', compartida.body.pickupSource);
    assert(compartida.body.pickupLink === 'https://www.google.com/maps?q=5.7651234,-73.1301234', 'con su enlace', compartida.body.pickupLink);

    console.log('\n4. Cambiar a efectivo y relanzar en una sola llamada');
    const tres = await call('/v1/rides', 'POST', {
      customerPhone: telefono(),
      pickup: { text: 'Calle 10 # 20-15', point: { lat: LUGAR.lat, lng: LUGAR.lng } },
      pagoElectronico: true,
    });
    creadas.push(tres.body.id as string);
    let estado = '';
    for (let i = 0; i < 40 && estado !== 'UNASSIGNED'; i++) {
      estado = String((await call(`/v1/rides/${tres.body.id as string}`)).body.status);
      if (estado !== 'UNASSIGNED') await new Promise((r) => setTimeout(r, 250));
    }
    assert(estado === 'UNASSIGNED', 'sin taxis con pago electrónico queda sin asignar', estado);
    const intentoAntes = (await db.select({ i: schema.rides.intentoDespacho }).from(schema.rides).where(eq(schema.rides.id, tres.body.id as string)))[0]!.i;
    const pago = await call(`/v1/rides/${tres.body.id as string}/payment`, 'PATCH', { pagoElectronico: false, relanzar: true });
    assert(pago.status < 400 && pago.body.relanzada === true, 'cambia y relanza', pago.body);
    assert(pago.body.pagoElectronico === false, 'queda en efectivo', pago.body.pagoElectronico);
    const intentoDespues = (await db.select({ i: schema.rides.intentoDespacho }).from(schema.rides).where(eq(schema.rides.id, tres.body.id as string)))[0]!.i;
    assert(intentoDespues === intentoAntes + 1, 'y el despacho arrancó otro intento', [intentoAntes, intentoDespues]);

    console.log('\n✓ Enlace de ubicación y pago, de extremo a extremo\n');
  } finally {
    for (const id of creadas) {
      await call(`/v1/rides/${id}/cancel`, 'POST', { reason: 'Fin de la prueba del enlace' });
    }
    await db.delete(schema.places).where(eq(schema.places.id, lugarId));
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\nLa prueba falló:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
