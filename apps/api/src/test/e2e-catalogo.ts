import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';

/**
 * Prueba de extremo a extremo de zonas y lugares, contra la API en marcha.
 *
 * Crea una zona y un lugar como lo haría la oficina, comprueba lo que se
 * rechaza (zona montada, palabra clave repetida, lugar fuera de servicio) y
 * pide una carrera sin ubicación ni dirección, solo con la palabra clave: el
 * taxi tiene que salir hacia el punto del lugar. Al final borra lo suyo.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-catalogo.ts <clave-de-api>
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;
const SUFIJO = Date.now().toString(36);
const TOKEN = `token-e2e-catalogo-${SUFIJO}`;
const USUARIO = '01a20000-0000-7000-8000-0000000ca7a1';

let fallos = 0;
function assert(condicion: boolean, mensaje: string, contexto?: unknown): void {
  if (condicion) {
    console.log(`  ✓ ${mensaje}`);
    return;
  }
  fallos += 1;
  console.error(`  ✗ ${mensaje}`);
  if (contexto !== undefined) console.error('   ', JSON.stringify(contexto).slice(0, 400));
}

async function llamar(ruta: string, opciones: { method?: string; body?: unknown; panel?: boolean } = {}) {
  const cabeceras: Record<string, string> = { 'content-type': 'application/json' };
  if (opciones.panel) cabeceras.cookie = `tax_session=${TOKEN}`;
  else cabeceras['x-api-key'] = API_KEY!;
  const respuesta = await fetch(`${BASE}${ruta}`, {
    method: opciones.method ?? 'GET',
    headers: cabeceras,
    body: opciones.body === undefined ? undefined : JSON.stringify(opciones.body),
  });
  const texto = await respuesta.text();
  return { status: respuesta.status, body: (texto ? JSON.parse(texto) : {}) as Record<string, any> };
}

async function main() {
  if (!API_KEY) {
    console.error('Falta la clave de API. Pásala como argumento o en TAX_API_KEY.');
    process.exit(1);
  }
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const hash = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
  await db.query(
    `insert into users (id, email, name, password_hash, role, totp_enabled)
     values ($1, 'e2e-catalogo@taxturistico.local', 'Prueba Catálogo', 'x', 'administrador', true)
     on conflict (id) do nothing`,
    [USUARIO],
  );
  await db.query(
    `insert into sessions (id, user_id, token_hash, expires_at) values (gen_random_uuid(), $1, $2, now() + interval '1 hour')`,
    [USUARIO, hash],
  );

  let zonaId: string | undefined;
  const lugares: string[] = [];
  const carreras: string[] = [];

  try {
    console.log('\n1. Zonas');
    const montada = await llamar('/v1/admin/zones', {
      method: 'POST',
      panel: true,
      body: { name: `Encima del centro ${SUFIJO}`, kind: 'urbano', center: { lat: 5.7803, lng: -73.105 }, radiusKm: 1 },
    });
    assert(montada.status === 409 && montada.body.code === 'ZONE_OVERLAP', `una zona encima del Centro se rechaza (${montada.status} ${montada.body.code})`, montada.body);
    assert(String(montada.body.detail ?? '').includes('Centro'), 'y dice sobre cuál se monta', montada.body.detail);

    const nueva = await llamar('/v1/admin/zones', {
      method: 'POST',
      panel: true,
      body: { name: `Vereda de prueba ${SUFIJO}`, kind: 'rural', center: { lat: 5.875, lng: -73.11 }, radiusKm: 1.5 },
    });
    assert(nueva.status === 201 && typeof nueva.body.id === 'string', `una zona libre se crea (${nueva.status})`, nueva.body);
    zonaId = nueva.body.id;

    const zonas = await llamar('/v1/admin/zones', { panel: true });
    const creada = (zonas.body as unknown as { id: string; kind: string; waves: { radiusKm: number }[]; polygon: { coordinates: number[][][] } }[]).find((z) => z.id === zonaId);
    assert(Boolean(creada), 'aparece en la lista de zonas al instante, sin reiniciar');
    assert(creada?.polygon.coordinates[0]?.length === 65, `como círculo de 64 lados (${creada?.polygon.coordinates[0]?.length} puntos)`);
    assert(creada?.waves[0]?.radiusKm === 5, `con las oleadas de vereda (${creada?.waves[0]?.radiusKm} km la primera)`);

    const repetida = await llamar('/v1/admin/zones', {
      method: 'POST',
      panel: true,
      body: { name: `Vereda de prueba ${SUFIJO}`, kind: 'rural', center: { lat: 5.95, lng: -73.3 }, radiusKm: 1 },
    });
    assert(repetida.status === 409 && repetida.body.code === 'NAME_TAKEN', `el mismo nombre otra vez se rechaza (${repetida.body.code})`);

    const mal = await llamar(`/v1/admin/zones/${zonaId}`, {
      method: 'PATCH',
      panel: true,
      body: {
        waves: [
          { wave: 1, radiusKm: 8, candidates: 3, timeoutSeconds: 70 },
          { wave: 2, radiusKm: 4, candidates: 6, timeoutSeconds: 90 },
          { wave: 3, radiusKm: 20, candidates: 14, timeoutSeconds: 120 },
        ],
      },
    });
    assert(mal.status === 400, `oleadas que buscan más cerca que la anterior se rechazan (${mal.status})`);
    const bien = await llamar(`/v1/admin/zones/${zonaId}`, {
      method: 'PATCH',
      panel: true,
      body: {
        waves: [
          { wave: 1, radiusKm: 4, candidates: 3, timeoutSeconds: 70 },
          { wave: 2, radiusKm: 9, candidates: 6, timeoutSeconds: 90 },
          { wave: 3, radiusKm: 20, candidates: 14, timeoutSeconds: 120 },
        ],
      },
    });
    assert(bien.status === 200 && bien.body.waves?.[0]?.radiusKm === 4, `cambiar las oleadas guarda de verdad (${bien.status})`, bien.body);

    console.log('\n2. Lugares');
    const lugar = await llamar('/v1/admin/places', {
      method: 'POST',
      panel: true,
      body: {
        name: `Tienda Don Prueba ${SUFIJO}`,
        aliases: [`donde don prueba ${SUFIJO}`, `la tienda azul ${SUFIJO}`, `Donde Don Prueba ${SUFIJO}`],
        point: { lat: 5.7811, lng: -73.1136 },
      },
    });
    assert(lugar.status === 201 && typeof lugar.body.id === 'string', `un lugar en el Centro se crea (${lugar.status})`, lugar.body);
    if (lugar.body.id) lugares.push(lugar.body.id);

    const enLista = await llamar('/v1/admin/places', { panel: true });
    const fila = (enLista.body as unknown as { id: string; aliases: string[]; kind: string }[]).find((p) => p.id === lugar.body.id);
    assert(fila?.aliases.length === 2, `las palabras repetidas con otra mayúscula se juntan (${fila?.aliases.length})`, fila?.aliases);
    assert(fila?.kind === 'urbano', `y toma el tipo de su zona (${fila?.kind})`);

    const robada = await llamar('/v1/admin/places', {
      method: 'POST',
      panel: true,
      body: { name: `Otra tienda ${SUFIJO}`, aliases: [`DONDE DON PRUEBA ${SUFIJO}`], point: { lat: 5.782, lng: -73.112 } },
    });
    assert(robada.status === 409 && robada.body.code === 'KEYWORD_TAKEN', `una palabra clave de otro lugar se rechaza (${robada.body.code})`);

    const fuera = await llamar('/v1/admin/places', {
      method: 'POST',
      panel: true,
      body: { name: `Lejísimos ${SUFIJO}`, aliases: [], point: { lat: 6.2, lng: -73.5 } },
    });
    assert(fuera.status === 422 && fuera.body.code === 'OUT_OF_COVERAGE', `un lugar fuera de servicio se rechaza (${fuera.body.code})`);

    console.log('\n3. Una carrera pedida solo con la palabra clave');
    const telefono = `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const carrera = await llamar('/v1/rides', {
      method: 'POST',
      body: { customerPhone: telefono, pickup: { text: `Estoy donde Don Prueba ${SUFIJO}, la casa del portón café` } },
    });
    if (carrera.body.id) carreras.push(carrera.body.id);
    assert(carrera.status === 201, `se crea (${carrera.status})`, carrera.body);
    assert(carrera.body.pickupSource === 'catalogo', `ubicada por el catálogo (${carrera.body.pickupSource})`);
    assert(carrera.body.pickupLat === 5.7811 && carrera.body.pickupLng === -73.1136, 'en el punto del lugar');

    const { rows } = await db.query('select uses from places where id = $1', [lugar.body.id]);
    assert(rows[0]?.uses === 1, `y el lugar cuenta un uso (${rows[0]?.uses})`);

    const quitado = await llamar(`/v1/admin/places/${lugar.body.id}`, { method: 'PATCH', panel: true, body: { active: false } });
    assert(quitado.status === 200, `quitarlo del catálogo funciona (${quitado.status})`);
    const otraCarrera = await llamar('/v1/rides', {
      method: 'POST',
      body: { customerPhone: `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, pickup: { text: `donde don prueba ${SUFIJO}` } },
    });
    if (otraCarrera.body.id) carreras.push(otraCarrera.body.id);
    assert(otraCarrera.body.pickupSource !== 'catalogo', `y ya no lo reconoce (${otraCarrera.body.pickupSource})`);
  } finally {
    for (const id of carreras) {
      await llamar(`/v1/rides/${id}/cancel`, { method: 'POST', body: { reason: 'Fin de la prueba del catálogo' } });
    }
    if (lugares.length) await db.query('delete from places where id = any($1::uuid[])', [lugares]);
    if (zonaId) {
      await db.query('delete from zones where id = $1', [zonaId]);
      // La API tiene las zonas en memoria: guardar las oleadas de otra zona
      // tal como están las vuelve a cargar, ya sin la de prueba.
      const centro = await db.query(`select id, waves from zones where name = 'Centro'`);
      if (centro.rows[0]) {
        await llamar(`/v1/admin/zones/${centro.rows[0].id}`, { method: 'PATCH', panel: true, body: { waves: centro.rows[0].waves } });
      }
    }
    await db.query('delete from sessions where user_id = $1', [USUARIO]);
    await db.query('delete from users where id = $1', [USUARIO]);
    await db.end();
  }

  console.log(fallos ? `\n${fallos} comprobaciones fallaron.` : '\nTodo correcto.');
  process.exit(fallos ? 1 : 0);
}

void main();
