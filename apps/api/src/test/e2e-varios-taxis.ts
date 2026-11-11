import 'dotenv/config';
import { Pool } from 'pg';

/**
 * Prueba de extremo a extremo del pedido de varios taxis en un mismo mensaje,
 * contra la API en marcha.
 *
 * Reproduce lo que hace la herramienta `crear_carrera` del flujo «Atención y
 * pedido de carreras»: una llamada por taxi, con la clave
 * `wa-<conversación>-msg-<mensaje>-<n>` y `numeroEnPedido: n`. Comprueba que
 * la API crea una carrera por taxi, que el tope de 5 se respeta, y deja
 * documentado lo que pasa cuando el agente no numera bien los taxis.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-varios-taxis.ts <clave-de-api>
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;
const TERMINAL = { lat: 5.7795, lng: -73.1148 };

let fallos = 0;
const creadas = new Set<string>();

function assert(condicion: boolean, mensaje: string, contexto?: unknown): void {
  if (condicion) {
    console.log(`  ✓ ${mensaje}`);
    return;
  }
  fallos += 1;
  console.error(`  ✗ ${mensaje}`);
  if (contexto !== undefined) console.error('   ', JSON.stringify(contexto).slice(0, 400));
}

type Respuesta = { status: number; body: Record<string, unknown> & { id?: string; code?: string }; repetida: boolean };

async function crear(clave: string, cuerpo: unknown): Promise<Respuesta> {
  const r = await fetch(`${BASE}/v1/rides`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY!, 'idempotency-key': clave },
    body: JSON.stringify(cuerpo),
  });
  const body = (await r.json()) as Respuesta['body'];
  if (typeof body.id === 'string') creadas.add(body.id);
  return { status: r.status, body, repetida: r.headers.get('idempotent-replayed') === 'true' };
}

const telefono = () => `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
const base = (caso: string) => `wa-prueba-${Date.now()}-msg-${caso}`;

/** El cuerpo que arma `crear_carrera` para el taxi `n` de `total` en la terminal. */
const taxi = (tel: string, n: number, total: number, numeroEnPedido: number | undefined = n) => ({
  customerPhone: tel,
  pickup: { text: 'terminal', point: TERMINAL },
  vehicleType: 'sedan',
  passengers: 1,
  pagoElectronico: false,
  notes: `Taxi ${n} de ${total} en el mismo punto`,
  ...(numeroEnPedido === undefined ? {} : { numeroEnPedido }),
});

const codigoDe = (r: Respuesta) => (r.body as { code?: string; error?: { code?: string } }).error?.code ?? r.body.code;

async function main() {
  if (!API_KEY) {
    console.error('Falta la clave de API. Pásala como argumento o en TAX_API_KEY.');
    process.exit(1);
  }
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

  console.log('\n1. Cinco taxis en la terminal, bien numerados (lo que debe hacer el agente)');
  {
    const tel = telefono();
    const k = base('cinco');
    const r: Respuesta[] = [];
    for (let n = 1; n <= 5; n++) r.push(await crear(`${k}-${n}`, taxi(tel, n, 5)));
    assert(r.every((x) => x.status === 201), `las cinco responden 201 (${r.map((x) => x.status).join(', ')})`, r.map((x) => x.body));
    assert(new Set(r.map((x) => x.body.id)).size === 5, 'y son cinco carreras distintas');

    const sexto = await crear(`${k}-6`, taxi(tel, 6, 6, 5));
    assert(sexto.status >= 400 && codigoDe(sexto) === 'MAX_ACTIVE_RIDES', `el sexto se rechaza con MAX_ACTIVE_RIDES (HTTP ${sexto.status}, ${codigoDe(sexto)})`, sexto.body);

    const repetido = await crear(`${k}-3`, taxi(tel, 3, 5));
    assert(repetido.status === 201 && repetido.repetida && repetido.body.id === r[2]!.body.id, 'un reintento del taxi 3 devuelve el taxi 3, sin crear otro');
  }

  // Con un cliente NUEVO: antes, las peticiones que perdían la carrera por
  // crear el cliente respondían 500 y de cinco taxis quedaban dos o tres.
  console.log('\n2. Cinco llamadas en paralelo de un cliente nuevo (el modelo pide las cinco a la vez)');
  {
    const tel = telefono();
    const k = base('paralelo');
    const r = await Promise.all([1, 2, 3, 4, 5].map((n) => crear(`${k}-${n}`, taxi(tel, n, 5))));
    assert(r.every((x) => x.status === 201), `las cinco responden 201 (${r.map((x) => x.status).join(', ')})`, r.map((x) => x.body));
    assert(new Set(r.map((x) => x.body.id)).size === 5, 'y son cinco carreras distintas');
  }

  console.log('\n3. El agente llama cinco veces SIN numerar (numero_en_pedido = 1 en todas)');
  {
    const tel = telefono();
    const k = base('sin-numero');
    const r: Respuesta[] = [];
    for (let n = 1; n <= 5; n++) r.push(await crear(`${k}-1`, taxi(tel, n, 5, 1)));
    const ids = new Set(r.map((x) => x.body.id));
    console.log(`    → ${r.map((x) => `${x.status}${x.repetida ? ' (repetida)' : ''}`).join(', ')}; carreras distintas: ${ids.size}`);
    assert(ids.size === 1, 'la API devuelve la MISMA carrera las cinco veces, cada una con 201: el agente cree que pidió cinco');
  }

  console.log('\n4. Claves distintas pero numeroEnPedido = 1 en todas');
  {
    const tel = telefono();
    const k = base('todas-uno');
    const r: Respuesta[] = [];
    for (let n = 1; n <= 3; n++) r.push(await crear(`${k}-${n}`, taxi(tel, n, 3, 1)));
    console.log(`    → ${r.map((x) => `${x.status} ${codigoDe(x) ?? ''}`).join(', ')}`);
    assert(r[0]!.status === 201 && r.slice(1).every((x) => codigoDe(x) === 'RIDE_ALREADY_ACTIVE'), 'solo se crea la primera; las demás chocan con RIDE_ALREADY_ACTIVE');
  }

  type ConLista = { rides?: { id: string; code: string; notes: string | null; allowsConcurrent: boolean }[]; cantidad?: number };

  console.log('\n5. «5 taxis en la terminal» con UNA llamada y cantidad: 5');
  {
    const tel = telefono();
    const k = `${base('cantidad')}-1`;
    const cuerpo = { ...taxi(tel, 1, 5), notes: 'Taxi 1 de 5 en el mismo punto. Van al cementerio', cantidad: 5 };
    const r = await crear(k, cuerpo);
    const lista = (r.body as ConLista).rides ?? [];
    lista.forEach((x) => creadas.add(x.id));
    assert(r.status === 201, `responde 201 (HTTP ${r.status})`, r.body);
    assert(lista.length === 5 && new Set(lista.map((x) => x.id)).size === 5, `trae las cinco carreras en «rides» (${lista.length})`);
    assert(r.body.id === lista[0]?.id && (r.body as ConLista).cantidad === 5, 'id y code de arriba son los del primer taxi, y cantidad es 5');
    assert(
      lista.every((x, i) => x.notes === `Taxi ${i + 1} de 5 en el mismo punto. Van al cementerio`),
      'cada una lleva «Taxi i de 5» puesto por la API, sin la cuenta vieja del agente',
      lista.map((x) => x.notes),
    );
    assert(lista.map((x) => x.allowsConcurrent).join() === 'false,true,true,true,true', 'solo el taxi 1 queda sin la marca de concurrente');

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int n from outbox_events where type = 'ride.created' and ride_id = any($1)`,
      [lista.map((x) => x.id)],
    );
    assert(rows[0]?.n === 5, `cinco eventos ride.created, uno por taxi (${rows[0]?.n})`);

    const otra = await crear(k, cuerpo);
    const listaOtra = (otra.body as ConLista).rides ?? [];
    assert(otra.repetida && listaOtra.map((x) => x.id).join() === lista.map((x) => x.id).join(), 'un reintento devuelve los mismos cinco, sin crear más');

    const distinta = await crear(k, { ...cuerpo, cantidad: 4 });
    assert(codigoDe(distinta) === 'IDEMPOTENCY_MISMATCH', `la misma clave con otra cantidad es otro pedido (${codigoDe(distinta)})`);

    const sexto = await crear(`${base('cantidad')}-6`, { ...taxi(tel, 1, 1, 1) });
    assert(codigoDe(sexto) === 'RIDE_ALREADY_ACTIVE' || codigoDe(sexto) === 'MAX_ACTIVE_RIDES', `ya no cabe otro taxi (${codigoDe(sexto)})`);
  }

  console.log('\n6. Pide más de los que caben: no se crea ninguno y la API dice el cupo');
  {
    const tel = telefono();
    const k = base('cupo');
    const tres = await crear(`${k}-1`, { ...taxi(tel, 1, 3), cantidad: 3 });
    ((tres.body as ConLista).rides ?? []).forEach((x) => creadas.add(x.id));
    assert(tres.status === 201, `tiene tres activos (HTTP ${tres.status})`);
    const r = await crear(base('cupo-2') + '-4', { ...taxi(tel, 4, 5, 4), cantidad: 2 });
    assert(r.status === 201, `dos más numerados 4 y 5 sí caben (HTTP ${r.status})`, r.body);
    ((r.body as ConLista).rides ?? []).forEach((x) => creadas.add(x.id));

    const tel2 = telefono();
    const dos = await crear(`${base('cupo-3')}-1`, { ...taxi(tel2, 1, 4), cantidad: 4 });
    ((dos.body as ConLista).rides ?? []).forEach((x) => creadas.add(x.id));
    const { rows: antes } = await db.query<{ n: number }>(`select count(*)::int n from rides r join customers c on c.id = r.customer_id where c.phone = $1`, [tel2]);
    const mucho = await crear(`${base('cupo-4')}-1`, { ...taxi(tel2, 1, 3, 2), numeroEnPedido: 2, cantidad: 3 });
    const { rows: despues } = await db.query<{ n: number }>(`select count(*)::int n from rides r join customers c on c.id = r.customer_id where c.phone = $1`, [tel2]);
    const errores = JSON.stringify(mucho.body);
    assert(codigoDe(mucho) === 'MAX_ACTIVE_RIDES' && /cupo: 1/.test(errores), `con 4 activos, pedir 3 más da MAX_ACTIVE_RIDES con cupo 1 (${codigoDe(mucho)})`, mucho.body);
    assert(antes[0]?.n === despues[0]?.n, 'y no se crea ninguno a medias');
  }

  console.log('\n7. Dos en la terminal y uno en el hotel: dos llamadas, numeradas 1-2 y 3');
  {
    const tel = telefono();
    const k = base('mixto');
    const a = await crear(`${k}-1`, { ...taxi(tel, 1, 2), cantidad: 2 });
    const b = await crear(`${k}-3`, { ...taxi(tel, 3, 3, 3), pickup: { text: 'Hotel Sochagota', point: { lat: 5.7712, lng: -73.1105 } } });
    ((a.body as ConLista).rides ?? []).forEach((x) => creadas.add(x.id));
    assert(a.status === 201 && ((a.body as ConLista).rides ?? []).length === 2, `la terminal: dos carreras (HTTP ${a.status})`);
    assert(b.status === 201 && !(b.body as ConLista).rides, `el hotel: una, con la respuesta de siempre (HTTP ${b.status})`, b.body);
  }

  console.log('\n8. Numeración que se pasa de 5');
  {
    const r = await crear(`${base('pasa')}-4`, { ...taxi(telefono(), 4, 6, 4), cantidad: 3 });
    assert(r.status === 400 || r.status === 422, `numeroEnPedido 4 con cantidad 3 se rechaza (HTTP ${r.status})`, r.body);
  }

  // Limpieza: las carreras de prueba se cancelan para no dejar despachos vivos.
  if (creadas.size) {
    await db.query(`update rides set status = 'CANCELLED', updated_at = now() where id = any($1) and status not in ('COMPLETED','CANCELLED')`, [[...creadas]]);
  }
  await db.end();

  console.log(fallos ? `\n${fallos} comprobaciones fallaron.` : '\nTodo en orden.');
  process.exit(fallos ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
