import 'dotenv/config';
import { Pool } from 'pg';

/**
 * Prueba de extremo a extremo de la idempotencia, contra la API en marcha.
 *
 * Reproduce lo que hace el flujo «Atención y pedido de carreras» de n8n: la
 * clave es `wa-<conversación>-msg-<mensaje>`, y el agente vuelve a llamar a
 * `crear_carrera` ante cualquier error, con el cuerpo redactado otra vez por
 * el modelo. En todos esos casos tiene que recibir SU carrera, nunca un 409.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-idempotencia.ts <clave-de-api>
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;
const CENTRO = { lat: 5.7803, lng: -73.1142 };
const FUERA = { lat: 5.95, lng: -73.1142 };

let fallos = 0;
const creadas: string[] = [];

function assert(condicion: boolean, mensaje: string, contexto?: unknown): void {
  if (condicion) {
    console.log(`  ✓ ${mensaje}`);
    return;
  }
  fallos += 1;
  console.error(`  ✗ ${mensaje}`);
  if (contexto !== undefined) console.error('   ', JSON.stringify(contexto).slice(0, 400));
}

async function pedir(clave: string, cuerpo: unknown, ruta = '/v1/rides') {
  const respuesta = await fetch(`${BASE}${ruta}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY!, 'idempotency-key': clave },
    body: JSON.stringify(cuerpo),
  });
  const body = (await respuesta.json()) as Record<string, unknown> & { id?: string; code?: string };
  if (ruta === '/v1/rides' && typeof body.id === 'string' && !creadas.includes(body.id)) creadas.push(body.id);
  return { status: respuesta.status, body, repetida: respuesta.headers.get('idempotent-replayed') === 'true' };
}

/** Un teléfono que no tenga carreras: cada caso con su cliente. */
const telefono = () => `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
const clave = (caso: string) => `wa-prueba-${Date.now()}-msg-${caso}`;

/** Lo que mandaría el agente; `redaccion` cambia lo que el modelo escribe. */
const pedido = (tel: string, redaccion: string, punto: { lat: number; lng: number } | undefined = CENTRO) => ({
  customerPhone: tel,
  pickup: { text: `Ubicación compartida por WhatsApp. ${redaccion}`, point: punto, mapsUrl: 'https://maps.google.com/?q=x' },
  vehicleType: 'sedan',
  passengers: 1,
  notes: redaccion,
});

async function main() {
  if (!API_KEY) {
    console.error('Falta la clave de API. Pásala como argumento o en TAX_API_KEY.');
    process.exit(1);
  }
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

  console.log('\n1. El agente repite al instante, con el mismo cuerpo');
  {
    const k = clave('1');
    const cuerpo = pedido(telefono(), 'Portón verde');
    const a = await pedir(k, cuerpo);
    const b = await pedir(k, cuerpo);
    assert(a.status === 201, `la primera crea la carrera (HTTP ${a.status})`, a.body);
    assert(b.status === 201, `la repetición también responde 201 (HTTP ${b.status})`, b.body);
    assert(a.body.id === b.body.id, 'y es la misma carrera');
    assert(b.repetida && !a.repetida, 'solo la segunda viene marcada como repetida');
  }

  console.log('\n2. El agente repite con otras palabras (mismo cliente y mismo punto)');
  {
    const k = clave('2');
    const tel = telefono();
    const a = await pedir(k, pedido(tel, 'Casa del portón verde, al lado de la escuela'));
    const b = await pedir(k, pedido(tel, 'Portón verde junto a la escuela. Lleva una maleta'));
    assert(a.status === 201 && b.status === 201, `las dos responden 201 (HTTP ${a.status} y ${b.status})`, b.body);
    assert(a.body.id === b.body.id, 'y devuelven la misma carrera, no un 409');
  }

  console.log('\n3. Dos llamadas a la vez con la misma clave');
  {
    const k = clave('3');
    const tel = telefono();
    const [a, b] = await Promise.all([pedir(k, pedido(tel, 'A la vez')), pedir(k, pedido(tel, 'A la vez'))]);
    assert(a.status === 201 && b.status === 201, `las dos responden 201 (HTTP ${a.status} y ${b.status})`, [a.body, b.body]);
    assert(a.body.id === b.body.id, 'con la misma carrera');
    const { rows } = await db.query(
      `select count(*)::int as n from rides r join customers c on c.id = r.customer_id where c.phone = $1`,
      [tel],
    );
    assert(rows[0].n === 1, `y en la base hay una sola (${rows[0].n})`);
  }

  console.log('\n4. La misma clave para otro cliente o en otro punto');
  {
    const k = clave('4');
    const tel = telefono();
    const a = await pedir(k, pedido(tel, 'Primero'));
    const otroCliente = await pedir(k, pedido(telefono(), 'Primero'));
    const otroPunto = await pedir(k, pedido(tel, 'Primero', { lat: 5.7836, lng: -73.1177 }));
    assert(a.status === 201, `la primera crea la carrera (HTTP ${a.status})`, a.body);
    assert(
      otroCliente.status === 409 && otroCliente.body.code === 'IDEMPOTENCY_MISMATCH',
      `otro teléfono con la misma clave es un 409 IDEMPOTENCY_MISMATCH (HTTP ${otroCliente.status} ${otroCliente.body.code})`,
    );
    assert(
      otroPunto.status === 409 && otroPunto.body.code === 'IDEMPOTENCY_MISMATCH',
      `el mismo cliente en otro punto, también (HTTP ${otroPunto.status} ${otroPunto.body.code})`,
    );
  }

  console.log('\n5. Un error no se guarda: el reintento vuelve a intentarlo');
  {
    const k = clave('5');
    const cuerpo = pedido(telefono(), 'Lejos', FUERA);
    const a = await pedir(k, cuerpo);
    const b = await pedir(k, cuerpo);
    assert(a.status >= 400 && a.status !== 409, `fuera de cobertura falla (HTTP ${a.status} ${a.body.code})`, a.body);
    assert(b.body.code === a.body.code, `el reintento se ejecuta otra vez y da el mismo error (${b.body.code}), no «en curso»`);
    const { rows } = await db.query(`select count(*)::int as n from idempotency_keys where key like $1`, [`%|${k}`]);
    assert(rows[0].n === 0, 'y la clave quedó libre');
  }

  console.log('\n6. La misma clave en otra ruta es otra petición');
  {
    const k = clave('6');
    const a = await pedir(k, pedido(telefono(), 'Para cancelar'));
    const cancelada = await pedir(k, { reason: 'Prueba de idempotencia' }, `/v1/rides/${a.body.id}/cancel`);
    assert(cancelada.status < 300 && !cancelada.repetida, `cancelar con la clave de la creación cancela (HTTP ${cancelada.status})`, cancelada.body);
    assert(cancelada.body.status === 'CANCELLED', `y no devuelve la carrera recién creada (${cancelada.body.status})`);
  }

  // Limpieza: las carreras de la prueba no se quedan buscando conductor.
  for (const id of creadas) {
    await fetch(`${BASE}/v1/rides/${id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ reason: 'Fin de la prueba de idempotencia' }),
    });
  }
  await db.end();

  console.log(fallos ? `\n${fallos} comprobaciones fallaron.` : '\nTodo correcto.');
  process.exit(fallos ? 1 : 0);
}

void main();
