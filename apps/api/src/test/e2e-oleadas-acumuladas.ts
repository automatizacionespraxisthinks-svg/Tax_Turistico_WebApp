import 'dotenv/config';
import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../db/schema';

/**
 * Las oleadas suman y nadie en el radio se queda fuera (prueba de producción
 * del 3/11/2026, con cuatro taxis en el mismo punto).
 *
 *  1. Un conductor con el GPS viejo —teléfono bloqueado— recibe la carrera
 *     igual que los que lo tienen al día. Antes, habiendo uno al día, los
 *     demás se quedaban fuera.
 *  2. Quien no contestó en una oleada sigue con la oferta en las siguientes,
 *     con el plazo alargado, y puede aceptarla en la tercera.
 *  3. Si todos los que la tienen la rechazan, se pasa a la siguiente en el
 *     acto, y el temporizador de la oleada anterior no la vuelve a lanzar.
 *  4. La ronda final mantiene a todos los de antes, y al agotarse las
 *     ofertas vencen todas juntas.
 *
 *  5. Lo que no se ubica sale del punto de partida que elige la oficina.
 *
 * Pone oleadas de 15 segundos en la zona Centro mientras corre y las deja
 * como estaban al terminar. Tarda un par de minutos.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-oleadas-acumuladas.ts <clave-de-api>
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;
const A_TODOS = (process.env.OLEADA_FINAL_A_TODOS ?? 'true') === 'true';
const PIN = '4821';
const CONDUCTORES = [
  { code: '101', plate: 'UBP472' },
  { code: '102', plate: 'TQR118' },
  { code: '103', plate: 'SVM903' },
];
/** Los tres en el mismo punto, a unos 300 m del centro de la zona. */
const PUNTO = { lat: 5.7806, lng: -73.1170 };
const RECOGIDA = { lat: 5.7803, lng: -73.1142 };
const TOKEN_OFICINA = 'token-prueba-oleadas-acumuladas';
const OFICINA_ID = '01a20000-0000-7000-8000-00000000c001';

interface Json {
  [k: string]: unknown;
}

function assert(cond: boolean, msg: string, ctx?: unknown): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    if (ctx !== undefined) console.error('    ', JSON.stringify(ctx));
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

async function call(
  path: string,
  o: { method?: string; body?: unknown; token?: string; apiKey?: boolean; oficina?: boolean } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.apiKey && API_KEY) headers['x-api-key'] = API_KEY;
  if (o.oficina) headers.cookie = `tax_session=${TOKEN_OFICINA}`;
  const r = await fetch(`${BASE}${path}`, {
    method: o.method ?? 'GET',
    headers,
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, body: t ? (JSON.parse(t) as Json) : {} };
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:16379');

  const [centro] = await db.select().from(schema.zones).where(eq(schema.zones.name, 'Centro')).limit(1);
  if (!centro) throw new Error('No está la zona Centro de la siembra');
  const olasOriginales = centro.waves;
  const creadas: string[] = [];
  const tokens: string[] = [];

  /** Las ofertas de la carrera, de la base: lo que de verdad decide quién puede aceptar. */
  const ofertas = async (rideId: string) =>
    db
      .select({
        driverId: schema.rideOffers.driverId,
        wave: schema.rideOffers.wave,
        response: schema.rideOffers.response,
        expiresAt: schema.rideOffers.expiresAt,
      })
      .from(schema.rideOffers)
      .where(eq(schema.rideOffers.rideId, rideId));

  const registro = async (rideId: string) =>
    (await call(`/v1/rides/${rideId}`, { apiKey: true })).body as {
      status: string;
      waveLog: { wave: number; candidates: number; arrastrados?: number; expiresAt: string | null }[];
    };

  const esperarOleada = async (rideId: string, wave: number, segundos = 25) => {
    for (let i = 0; i < segundos * 4; i++) {
      const r = await registro(rideId);
      if (r.waveLog.some((e) => e.wave === wave) || r.status === 'UNASSIGNED' || r.status === 'CANCELLED') return r;
      await dormir(250);
    }
    return registro(rideId);
  };

  try {
    /* Una sesión de oficina para cambiar las oleadas, y nadie más en turno. */
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, OFICINA_ID));
    await db.delete(schema.users).where(eq(schema.users.id, OFICINA_ID));
    await db.insert(schema.users).values({
      id: OFICINA_ID,
      email: 'prueba-oleadas-acumuladas@taxturistico.local',
      name: 'Prueba Oleadas',
      passwordHash: 'x',
      role: 'administrador',
      totpEnabled: true,
    });
    await db.insert(schema.sessions).values({
      id: uuidv7(),
      userId: OFICINA_ID,
      tokenHash: createHash('sha256').update(TOKEN_OFICINA).digest('hex'),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const activas = await call('/v1/rides?status=ASSIGNED,DRIVER_ARRIVED,IN_PROGRESS,NOTIFIED,PENDING', { apiKey: true });
    for (const v of Array.isArray(activas.body) ? (activas.body as unknown as { id: string }[]) : []) {
      await call(`/v1/rides/${v.id}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Limpieza' } });
    }
    await db.update(schema.driverShifts).set({ endedAt: new Date() }).where(isNull(schema.driverShifts.endedAt));

    for (const c of CONDUCTORES) {
      const r = await call('/v1/auth/driver', {
        method: 'POST',
        body: { code: c.code, plate: c.plate, pin: PIN, device: 'prueba', install: `acumuladas-${c.code}` },
      });
      assert(r.status < 400, `conductor ${c.code} entra`, r.body);
      const token = (r.body as { token: string }).token;
      tokens.push(token);
      await call('/v1/driver/shift/close', { method: 'POST', token });
      const turno = await call('/v1/driver/shift/open', { method: 'POST', token, body: { plate: c.plate } });
      assert(turno.status < 400, `  abre turno`, turno.body);
      await call('/v1/driver/position', { method: 'POST', token, body: { point: PUNTO } });
    }
    const ids = await Promise.all(
      CONDUCTORES.map(async (c) => (await db.select({ id: schema.drivers.id }).from(schema.drivers).where(eq(schema.drivers.code, c.code)))[0]!.id),
    );

    /* -------------------------------------------------------------- 1 */
    console.log('\n1. Con el GPS viejo también recibe la carrera');
    const cambio = await call(`/v1/admin/zones/${centro.id}`, {
      method: 'PATCH',
      oficina: true,
      body: {
        waves: [
          { wave: 1, radiusKm: 1, candidates: 5, timeoutSeconds: 15 },
          { wave: 2, radiusKm: 2, candidates: 5, timeoutSeconds: 15 },
          { wave: 3, radiusKm: 3, candidates: 5, timeoutSeconds: 15 },
        ],
      },
    });
    assert(cambio.status < 400, 'oleadas de 15 s en el Centro', cambio.body);

    // Dos con la última posición de hace cinco minutos: el teléfono bloqueado.
    const haceCinco = String(Date.now() - 5 * 60_000);
    await redis.hset(`driver:${ids[1]}:meta`, 'at', haceCinco);
    await redis.hset(`driver:${ids[2]}:meta`, 'at', haceCinco);

    const uno = await call('/v1/rides', {
      method: 'POST',
      apiKey: true,
      body: { customerPhone: telefono(), pickup: { text: 'Carrera 14 # 23-10', point: RECOGIDA }, passengers: 1 },
    });
    assert(uno.status < 400, 'carrera creada', uno.body);
    const r1 = uno.body.id as string;
    creadas.push(r1);
    await esperarOleada(r1, 1);
    const o1 = await ofertas(r1);
    assert(o1.length === 3, `la oleada 1 avisa a los tres, no solo al del GPS reciente (avisó a ${o1.length})`, o1);
    await call(`/v1/rides/${r1}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Fin del caso 1' } });

    /* -------------------------------------------------------------- 2 */
    console.log('\n2. Quien no contestó sigue con la oferta en las oleadas siguientes');
    // Uno nuevo por oleada, para ver cómo se suman.
    await call(`/v1/admin/zones/${centro.id}`, {
      method: 'PATCH',
      oficina: true,
      body: {
        waves: [
          { wave: 1, radiusKm: 1, candidates: 1, timeoutSeconds: 15 },
          { wave: 2, radiusKm: 2, candidates: 1, timeoutSeconds: 15 },
          { wave: 3, radiusKm: 3, candidates: 1, timeoutSeconds: 15 },
        ],
      },
    });
    const dos = await call('/v1/rides', {
      method: 'POST',
      apiKey: true,
      body: { customerPhone: telefono(), pickup: { text: 'Carrera 14 # 23-10', point: RECOGIDA }, passengers: 1 },
    });
    const r2 = dos.body.id as string;
    creadas.push(r2);
    await esperarOleada(r2, 1);
    const [primero] = await ofertas(r2);
    assert(Boolean(primero) && primero!.wave === 1, 'la oleada 1 avisa a uno', primero);
    const vencia = primero!.expiresAt.getTime();

    const tras2 = await esperarOleada(r2, 2);
    const ola2 = tras2.waveLog.find((e) => e.wave === 2);
    assert(ola2?.candidates === 1 && ola2.arrastrados === 1, 'la oleada 2: uno nuevo y sigue el de la 1', ola2);
    const o2 = await ofertas(r2);
    const delaUno = o2.find((o) => o.driverId === primero!.driverId)!;
    assert(delaUno.response === 'pending', '  el de la oleada 1 sigue pendiente, no «no contestó»', delaUno);
    assert(delaUno.expiresAt.getTime() > vencia + 10_000, '  con el plazo alargado hasta el fin de la oleada 2');

    const tras3 = await esperarOleada(r2, 3);
    const ola3 = tras3.waveLog.find((e) => e.wave === 3);
    assert(ola3?.candidates === 1 && ola3.arrastrados === 2, 'la oleada 3: el tercero y siguen los dos de antes', ola3);

    const quien = tokens[ids.indexOf(primero!.driverId)]!;
    const acepta = await call(`/v1/driver/rides/${r2}/accept`, { method: 'POST', token: quien });
    assert(acepta.status < 400, 'el de la oleada 1 la acepta en plena oleada 3', acepta.body);
    const o2fin = await ofertas(r2);
    assert(o2fin.filter((o) => o.response === 'revoked').length === 2, '  y a los otros dos se les retira', o2fin);
    await call(`/v1/rides/${r2}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Fin del caso 2' } });
    await call(`/v1/driver/position`, { method: 'POST', token: quien, body: { point: PUNTO } });

    /* -------------------------------------------------------------- 3 */
    console.log('\n3. Si todos los que la tienen dicen que no, se pasa ya, y una sola vez');
    // La carrera cancelada deja al conductor libre; se espera a que lo esté.
    await dormir(500);
    const tres = await call('/v1/rides', {
      method: 'POST',
      apiKey: true,
      body: { customerPhone: telefono(), pickup: { text: 'Carrera 14 # 23-10', point: RECOGIDA }, passengers: 1 },
    });
    const r3 = tres.body.id as string;
    creadas.push(r3);
    await esperarOleada(r3, 1);
    const [rechaza] = await ofertas(r3);
    const tokenRechaza = tokens[ids.indexOf(rechaza!.driverId)]!;
    const inicio = Date.now();
    const no = await call(`/v1/driver/rides/${r3}/reject`, { method: 'POST', token: tokenRechaza });
    assert(no.status < 400, 'el único que la tiene la rechaza', no.body);
    const tras = await esperarOleada(r3, 2, 3);
    assert(tras.waveLog.some((e) => e.wave === 2), 'la oleada 2 arranca sin esperar el reloj');
    assert(Date.now() - inicio < 5000, `  en ${Math.round((Date.now() - inicio) / 100) / 10} s`);

    // Pasado el reloj de la oleada 1, su temporizador no lanza otra oleada 2.
    await dormir(16_000);
    const unaVez = await registro(r3);
    assert(unaVez.waveLog.filter((e) => e.wave === 2).length === 1, 'la oleada 2 está una sola vez', unaVez.waveLog);

    /* -------------------------------------------------------------- 4 */
    if (A_TODOS) {
      console.log('\n4. La ronda final mantiene a todos, y al final vencen juntas');
      const final = await esperarOleada(r3, 4, 40);
      const ola4 = final.waveLog.find((e) => e.wave === 4);
      assert(Boolean(ola4), 'hubo ronda final', final.waveLog);
      assert(ola4!.candidates === 0 && ola4!.arrastrados === 2, '  sin nuevos y con los dos que seguían', ola4);
      assert(ola4!.expiresAt !== null, '  y con su reloj: esperar sirve, hay a quién');

      let fin = await registro(r3);
      for (let i = 0; i < 80 && fin.status === 'NOTIFIED'; i++) {
        await dormir(250);
        fin = await registro(r3);
      }
      assert(fin.status === 'UNASSIGNED', 'agotada la ronda final, queda sin asignar', fin.status);
      const o3 = await ofertas(r3);
      assert(o3.filter((o) => o.response === 'expired').length === 2, '  y las dos que seguían vencen juntas', o3);
      assert(o3.filter((o) => o.response === 'rejected').length === 1, '  la rechazada sigue rechazada');
      assert(!o3.some((o) => o.response === 'pending'), '  sin ninguna pendiente');
    }

    /* -------------------------------------------------------------- 5 */
    console.log('\n5. Lo que no se ubica sale del punto de partida que elige la oficina');
    const sinUbicar = async () => {
      const r = await call('/v1/rides', {
        method: 'POST',
        apiKey: true,
        body: { customerPhone: telefono(), pickup: { text: 'Donde la señora Rosa, subiendo por el camino de tierra' } },
      });
      creadas.push(r.body.id as string);
      await call(`/v1/rides/${r.body.id as string}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Caso 5' } });
      return r.body as { pickupSource: string; zoneId: string };
    };
    const enCentro = await sinUbicar();
    assert(enCentro.pickupSource === 'sin_ubicar', 'una dirección que no se ubica queda sin ubicar', enCentro);
    assert(enCentro.zoneId === centro.id, '  y sale del Centro, que es el punto de partida', enCentro.zoneId);

    const [lago] = await db.select().from(schema.zones).where(eq(schema.zones.name, 'Lago Sochagota')).limit(1);
    if (lago) {
      const elegir = await call(`/v1/admin/zones/${lago.id}`, { method: 'PATCH', oficina: true, body: { esReferencia: true } });
      assert(elegir.status < 400, 'la oficina elige otra zona', elegir.body);
      const marcadas = await db.select({ name: schema.zones.name }).from(schema.zones).where(eq(schema.zones.esReferencia, true));
      assert(marcadas.length === 1 && marcadas[0]!.name === 'Lago Sochagota', '  y queda una sola marcada', marcadas);
      assert((await sinUbicar()).zoneId === lago.id, '  y desde ese momento salen de ahí');
      await call(`/v1/admin/zones/${centro.id}`, { method: 'PATCH', oficina: true, body: { esReferencia: true } });
      assert((await sinUbicar()).zoneId === centro.id, 'de vuelta al Centro');
    }

    console.log('\n✓ Las oleadas suman y nadie en el radio se queda fuera\n');
  } finally {
    for (const id of creadas) {
      await call(`/v1/rides/${id}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Fin de la prueba' } });
    }
    await call(`/v1/admin/zones/${centro.id}`, {
      method: 'PATCH',
      oficina: true,
      body: { waves: olasOriginales, ...(centro.esReferencia ? { esReferencia: true } : {}) },
    });
    for (const token of tokens) await call('/v1/driver/shift/close', { method: 'POST', token });
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, OFICINA_ID));
    await db.delete(schema.users).where(and(eq(schema.users.id, OFICINA_ID)));
    redis.disconnect();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('\nLa prueba falló:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
