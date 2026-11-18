import 'dotenv/config';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { uuidv7 } from 'uuidv7';

/**
 * Los arreglos críticos de la auditoría del 17/11/2026, de extremo a extremo.
 *
 *  1. Asignación manual: solo carreras sin conductor, a un conductor en
 *     turno y libre.
 *  2. Idempotencia por URL real: la misma clave cancela dos carreras.
 *  3. Cerrar turno con carrera tomada: no; y al cerrar se retiran las ofertas.
 *  4. Aceptar sin turno abierto: no.
 *  5. Listar todas las carreras pide `rides:list`.
 *  6. La foto del lugar no se baja de una dirección interna.
 *  7. El acceso del conductor responde igual exista o no el código, bloquea
 *     por código y red, y el contador de la cuenta es atómico.
 *  8. Los accesos tienen su propio límite de peticiones, sin trampas con
 *     claves de API inventadas. (Va de último: deja la IP bloqueada un
 *     minuto en los accesos.)
 *
 * Usa los conductores del seed (101, 102, 103, PIN 4821).
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-criticos.ts <clave-con-rides:list> <clave-sin-rides:list>
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const KEY = process.argv[2];
const KEY_SIN_LISTA = process.argv[3];
const PIN = '4821';
const CENTRO = { lat: 5.7803, lng: -73.1142 };

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

type Json = Record<string, unknown>;
async function call(
  path: string,
  o: { method?: string; body?: unknown; token?: string; key?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.key) headers['x-api-key'] = o.key;
  const r = await fetch(`${BASE}${path}`, {
    method: o.method ?? 'GET',
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    body = { raw: text };
  }
  return { status: r.status, body };
}
const codigo = (r: { body: Json }) => r.body.code as string | undefined;
const telefono = () => `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
const entrar = (code: string, pin = PIN) =>
  call('/v1/auth/driver', { method: 'POST', body: { code, pin, device: 'prueba', install: `criticos-${code}` } });

async function main() {
  if (!KEY || !KEY_SIN_LISTA) {
    console.error('Uso: e2e-criticos.ts <clave-con-rides:list> <clave-sin-rides:list>');
    process.exit(1);
  }
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const redis = new Redis(process.env.REDIS_URL!, { keyPrefix: process.env.REDIS_PREFIX ?? 'tax:' });
  const idDe = async (code: string) => (await db.query('select id from drivers where code = $1', [code])).rows[0].id as string;
  const [d101, d102, d103] = [await idDe('101'), await idDe('102'), await idDe('103')];
  const todos = [d101, d102, d103];
  const rideIds: string[] = [];

  const limpiarAccesos = async () => {
    const claves = await redis.keys(`${process.env.REDIS_PREFIX ?? 'tax:'}acceso:conductor:*`);
    if (claves.length) await redis.del(...claves.map((k) => k.slice((process.env.REDIS_PREFIX ?? 'tax:').length)));
    await db.query('update drivers set failed_attempts = 0, locked_until = null where id = any($1)', [todos]);
  };

  await db.query(`update driver_shifts set ended_at = now() where ended_at is null and driver_id = any($1)`, [todos]);
  await db.query(`update drivers set status = 'OFF_SHIFT' where id = any($1)`, [todos]);
  await db.query(
    `update rides set status = 'CANCELLED' where driver_id = any($1) and status in ('ASSIGNED','DRIVER_ARRIVED','IN_PROGRESS')`,
    [todos],
  );
  await limpiarAccesos();

  const pedir = async (body: Json = {}) => {
    const r = await call('/v1/rides', {
      method: 'POST',
      key: KEY,
      headers: { 'idempotency-key': `criticos-${uuidv7()}` },
      body: { customerPhone: telefono(), pickup: { text: 'Carrera 21 # 24-18', point: CENTRO }, ...body },
    });
    if (typeof r.body.id === 'string') rideIds.push(r.body.id);
    return r;
  };
  const estado = async (id: string) => (await db.query('select status from rides where id = $1', [id])).rows[0]?.status as string;
  const esperar = async (id: string, estados: string[]) => {
    for (let i = 0; i < 40; i++) {
      if (estados.includes(await estado(id))) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };

  try {
    const t101 = (await entrar('101')).body.token as string;
    const t102 = (await entrar('102')).body.token as string;

    console.log('\n1. Asignación manual');
    {
      const sinTurno = await pedir();
      await esperar(sinTurno.body.id as string, ['UNASSIGNED']);
      const a = await call(`/v1/rides/${sinTurno.body.id}/assign`, { method: 'POST', key: KEY, body: { driverId: d102 } });
      assert(codigo(a) === 'DRIVER_BUSY', `a un conductor sin turno: DRIVER_BUSY (${codigo(a)})`, a.body);

      await call('/v1/driver/shift/open', { method: 'POST', token: t101, body: { plate: 'UBP472' } });
      const ok = await call(`/v1/rides/${sinTurno.body.id}/assign`, { method: 'POST', key: KEY, body: { driverId: d101 } });
      assert(ok.status < 400 && (await estado(sinTurno.body.id as string)) === 'ASSIGNED', `una carrera sin conductor se le asigna al 101 en turno (HTTP ${ok.status})`, ok.body);

      const otra = await call(`/v1/rides/${sinTurno.body.id}/assign`, { method: 'POST', key: KEY, body: { driverId: d102 } });
      assert(codigo(otra) === 'INVALID_TRANSITION', `asignada ya no se le quita a nadie: INVALID_TRANSITION (${codigo(otra)})`, otra.body);
      const conductor = (await db.query('select driver_id from rides where id = $1', [sinTurno.body.id])).rows[0].driver_id;
      assert(conductor === d101, 'y sigue siendo del 101');

      const ocupado = await pedir();
      await esperar(ocupado.body.id as string, ['UNASSIGNED', 'NOTIFIED']);
      const b = await call(`/v1/rides/${ocupado.body.id}/assign`, { method: 'POST', key: KEY, body: { driverId: d101 } });
      assert(codigo(b) === 'DRIVER_BUSY', `al 101, que ya va en carrera: DRIVER_BUSY (${codigo(b)})`, b.body);

      await call(`/v1/rides/${ocupado.body.id}/cancel`, { method: 'POST', key: KEY, body: { reason: 'Prueba' } });
      const muerta = await call(`/v1/rides/${ocupado.body.id}/assign`, { method: 'POST', key: KEY, body: { driverId: d101 } });
      assert(codigo(muerta) === 'INVALID_TRANSITION' && (await estado(ocupado.body.id as string)) === 'CANCELLED',
        `una cancelada no revive (${codigo(muerta)})`, muerta.body);

      console.log('\n3. Cerrar turno con una carrera tomada');
      const cierre = await call('/v1/driver/shift/close', { method: 'POST', token: t101 });
      assert(codigo(cierre) === 'DRIVER_BUSY', `DRIVER_BUSY (${codigo(cierre)})`, cierre.body);
      const turno = (await db.query('select count(*)::int n from driver_shifts where driver_id = $1 and ended_at is null', [d101])).rows[0].n;
      assert(turno === 1, 'y el turno sigue abierto');
      await call(`/v1/rides/${sinTurno.body.id}/cancel`, { method: 'POST', key: KEY, body: { reason: 'Prueba' } });
    }

    console.log('\n3b. Al cerrar turno se retiran sus ofertas; 4. sin turno no se acepta');
    {
      await db.query(`update drivers set status = 'AVAILABLE' where id = $1`, [d101]);
      await call('/v1/driver/position', { method: 'POST', token: t101, body: { point: { lat: CENTRO.lat + 0.001, lng: CENTRO.lng } } });
      const r = await pedir();
      const id = r.body.id as string;
      let oferta = 0;
      for (let i = 0; i < 40 && !oferta; i++) {
        oferta = (await db.query(`select count(*)::int n from ride_offers where ride_id = $1 and driver_id = $2 and response = 'pending'`, [id, d101])).rows[0].n;
        if (!oferta) await new Promise((res) => setTimeout(res, 250));
      }
      assert(oferta === 1, 'el 101 tiene la oferta');
      const cierre = await call('/v1/driver/shift/close', { method: 'POST', token: t101 });
      assert(cierre.status < 400, `cierra turno (HTTP ${cierre.status})`, cierre.body);
      const pendientes = (await db.query(`select count(*)::int n from ride_offers where driver_id = $1 and response = 'pending'`, [d101])).rows[0].n;
      assert(pendientes === 0, 'y se le retiraron las ofertas pendientes');

      // Una oferta viva a mano, para comprobar la regla en `accept`.
      await db.query(`update rides set status = 'NOTIFIED' where id = $1`, [id]);
      await db.query(
        `insert into ride_offers (id, ride_id, driver_id, wave, intento, distance_km, eta_minutes, expires_at, response)
         values ($1, $2, $3, 9, 1, 0, 0, now() + interval '2 minutes', 'pending')`,
        [uuidv7(), id, d101],
      );
      const acepta = await call(`/v1/driver/rides/${id}/accept`, { method: 'POST', token: t101 });
      assert(codigo(acepta) === 'DRIVER_BUSY' && (await estado(id)) === 'NOTIFIED', `sin turno no acepta: DRIVER_BUSY (${codigo(acepta)})`, acepta.body);
      await call(`/v1/rides/${id}/cancel`, { method: 'POST', key: KEY, body: { reason: 'Prueba' } });
    }

    console.log('\n2. La misma clave de idempotencia cancela dos carreras distintas');
    {
      const tel = telefono();
      const a = await pedir({ customerPhone: tel, cantidad: 2 });
      const [x, y] = ((a.body.rides as Json[]) ?? []).map((r) => r.id as string);
      const clave = `wa-criticos-${Date.now()}-msg-1`;
      const c1 = await call(`/v1/rides/${x}/cancel`, { method: 'POST', key: KEY, headers: { 'idempotency-key': clave }, body: { reason: 'El cliente ya no los necesita' } });
      const c2 = await call(`/v1/rides/${y}/cancel`, { method: 'POST', key: KEY, headers: { 'idempotency-key': clave }, body: { reason: 'El cliente ya no los necesita' } });
      assert(c1.status < 400 && c2.status < 400, `las dos responden bien (${c1.status}, ${c2.status})`, [c1.body, c2.body]);
      assert((await estado(x!)) === 'CANCELLED' && (await estado(y!)) === 'CANCELLED', 'y las DOS quedaron canceladas');
      const r = await call(`/v1/rides/${y}/cancel`, { method: 'POST', key: KEY, headers: { 'idempotency-key': clave }, body: { reason: 'El cliente ya no los necesita' } });
      assert(r.status < 400, 'repetir la segunda sigue siendo idempotente');
    }

    console.log('\n5. Listar todas las carreras pide rides:list');
    {
      const sin = await call('/v1/rides?limit=1', { key: KEY_SIN_LISTA });
      const con = await call('/v1/rides?limit=1', { key: KEY });
      assert(sin.status === 403, `sin el ámbito: 403 (HTTP ${sin.status})`, sin.body);
      assert(con.status === 200, `con el ámbito: 200 (HTTP ${con.status})`);
    }

    console.log('\n6. La foto no se baja de una dirección interna');
    {
      const r = await pedir();
      for (const url of ['http://127.0.0.1:3000/status', 'http://localhost:6379/', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd']) {
        const f = await call(`/v1/rides/${r.body.id}/photo`, { method: 'POST', key: KEY, body: { url } });
        assert(f.status === 400, `${url}: 400 (HTTP ${f.status}, ${String(r.body.detail ?? f.body.detail ?? '')})`, f.body);
      }
      const malo = await call(`/v1/rides/${r.body.id}/photo`, { method: 'POST', key: KEY, body: { foto: 'x' } });
      assert(malo.status === 400, `un cuerpo sin url es 400, no 500 (HTTP ${malo.status})`);
      await call(`/v1/rides/${r.body.id}/cancel`, { method: 'POST', key: KEY, body: { reason: 'Prueba' } });
    }

    console.log('\n7. Acceso del conductor');
    {
      await limpiarAccesos();
      const inexistente = await entrar('99999');
      const malo = await entrar('102', '0000');
      assert(inexistente.status === 401 && malo.status === 401 && inexistente.body.detail === malo.body.detail,
        'un código que no existe y un PIN malo responden exactamente lo mismo', [inexistente.body.detail, malo.body.detail]);

      for (let i = 0; i < 4; i++) await entrar('102', '0000');
      const bueno = await entrar('102');
      assert(bueno.status === 401 && bueno.body.detail === malo.body.detail, 'tras 5 PIN malos desde esta red, ni el PIN bueno entra, y no dice por qué');
      const otro = await entrar('103');
      assert(otro.status < 400, 'el 103 entra normal desde la misma red: el bloqueo es por código');
      await limpiarAccesos();
      assert((await entrar('102')).status < 400, 'y al vencer el bloqueo, el 102 entra');

      await limpiarAccesos();
      await Promise.all(Array.from({ length: 4 }, () => entrar('103', '1111')));
      const n = (await db.query('select failed_attempts n from drivers where id = $1', [d103])).rows[0].n as number;
      assert(n === 4, `4 intentos a la vez dejan el contador en 4 (${n}): es atómico`);
      await limpiarAccesos();
    }

    console.log('\n8. Límite propio de los accesos');
    {
      const respuestas = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          call('/v1/auth/driver', {
            method: 'POST',
            headers: { 'x-api-key': `inventada-${i}-${Math.random()}` },
            body: { code: '99999', pin: '0000', device: 'prueba' },
          }),
        ),
      );
      const frenadas = respuestas.filter((r) => r.status === 429).length;
      assert(frenadas >= 5, `25 accesos seguidos, cada uno con una clave inventada: ${frenadas} frenados con 429`);
    }
    void t102;
  } finally {
    await db.query(`update driver_shifts set ended_at = now() where ended_at is null and driver_id = any($1)`, [todos]);
    await db.query(`update drivers set status = 'OFF_SHIFT' where id = any($1)`, [todos]);
    if (rideIds.length) {
      await db.query(`update rides set status = 'CANCELLED' where id = any($1) and status not in ('COMPLETED','CANCELLED')`, [rideIds]);
    }
    await db.query(`update driver_devices set revoked_at = now(), push_subscription = null where install_id like 'criticos-%' and revoked_at is null`);
    await limpiarAccesos();
    await db.end();
    redis.disconnect();
  }

  console.log(fallos ? `\n${fallos} comprobaciones fallaron.` : '\nTodo en orden.');
  process.exit(fallos ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
