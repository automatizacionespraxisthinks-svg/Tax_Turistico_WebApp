import 'dotenv/config';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

/**
 * Cambiar de carro y cambiar de conductor, de extremo a extremo (17/11/2026).
 *
 * Un carro lo manejan varios conductores y un conductor maneja varios carros,
 * muchas veces con el mismo celular. Se comprueba:
 *
 *  - el acceso es código + PIN; la placa ya no hace falta (y una PWA vieja
 *    que la sigue mandando entra igual);
 *  - «Cambiar de carro» cierra el turno del carro de antes y abre el del
 *    nuevo con la misma sesión, y si algo falla no deja al conductor fuera;
 *  - un móvil que el listado maestro no le asigna se abre igual, marcado;
 *  - con una carrera tomada no se cambia ni de carro ni de conductor;
 *  - «Cambiar de conductor» cierra el turno, revoca la sesión del celular y
 *    le borra el push; el compañero entra en el mismo celular con su PIN;
 *  - si el compañero entra sin que el primero haya salido, la sesión y el
 *    push del primero en ese celular se revocan igual.
 *
 * Usa los conductores del seed (101 y 103, PIN 4821) y sus carros.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-cambio-de-mano.ts <clave-de-api>
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;
const PIN = '4821';
const CENTRO = { lat: 5.7803, lng: -73.1142 };
const UNO = '101';
const OTRO = '103';
const CELULAR = `mano-${Date.now()}`;

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
  options: { method?: string; body?: unknown; token?: string; apiKey?: boolean } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.apiKey && API_KEY) headers['x-api-key'] = API_KEY;
  const r = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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
const codigo = (r: { body: Json }) => (r.body.code as string | undefined) ?? ((r.body.error as Json | undefined)?.code as string | undefined);

const entrar = (code: string, extra: Json = {}) =>
  call('/v1/auth/driver', { method: 'POST', body: { code, pin: PIN, device: 'prueba', install: CELULAR, ...extra } });

async function main() {
  if (!API_KEY) {
    console.error('Falta la clave de API. Pásala como argumento o en TAX_API_KEY.');
    process.exit(1);
  }
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const fila = async <T>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T;
  const idDe = async (code: string) => (await fila<{ id: string }>('select id from drivers where code = $1', [code])).id;
  const uno = await idDe(UNO);
  const otro = await idDe(OTRO);
  const vinculoDePrueba = uuidv7();

  // Punto de partida limpio: nadie de los dos en turno ni bloqueado.
  await db.query(`update driver_shifts set ended_at = now() where ended_at is null and driver_id = any($1)`, [[uno, otro]]);
  await db.query(`update drivers set failed_attempts = 0, locked_until = null, status = 'OFF_SHIFT' where id = any($1)`, [[uno, otro]]);
  const rideIds: string[] = [];

  try {
    console.log('\n1. El acceso es código + PIN');
    {
      const r = await entrar(UNO);
      assert(r.status < 400 && typeof r.body.token === 'string', `entra sin placa (HTTP ${r.status})`, r.body);
      const mal = await entrar(UNO, { pin: '0000' });
      assert(mal.status === 401 && /Código o PIN incorrectos/.test(JSON.stringify(mal.body)), 'con PIN malo: «Código o PIN incorrectos»', mal.body);
      const vieja = await entrar(UNO, { plate: 'UBP472' });
      assert(vieja.status < 400, `una PWA vieja que manda la placa entra igual (HTTP ${vieja.status})`, vieja.body);
    }

    let token = (await entrar(UNO)).body.token as string;

    console.log('\n2. Cambiar de carro: mismo conductor, misma sesión');
    {
      const abre = await call('/v1/driver/shift/open', { method: 'POST', token, body: { plate: 'UBP472' } });
      assert(abre.status < 400 && abre.body.fueraDeListado === false, `abre turno en UBP472 (HTTP ${abre.status})`, abre.body);

      const cambia = await call('/v1/driver/shift/switch', { method: 'POST', token, body: { plate: 'TQR118' } });
      assert(cambia.status < 400 && cambia.body.plate === 'TQR118', `pasa al TQR118 (HTTP ${cambia.status})`, cambia.body);

      const me = await call('/v1/driver/rides/me', { token });
      assert((me.body.shift as Json | null)?.plate === 'TQR118', 'con la misma sesión, el turno abierto es el del TQR118', me.body.shift);
      const turnos = await db.query(
        `select v.plate, s.ended_at from driver_shifts s join vehicles v on v.id = s.vehicle_id
          where s.driver_id = $1 order by s.started_at desc limit 2`,
        [uno],
      );
      assert(turnos.rows[0]?.plate === 'TQR118' && turnos.rows[0]?.ended_at === null && turnos.rows[1]?.plate === 'UBP472' && turnos.rows[1]?.ended_at !== null,
        'el turno del UBP472 quedó cerrado y el del TQR118 abierto', turnos.rows);

      const mismo = await call('/v1/driver/shift/switch', { method: 'POST', token, body: { plate: 'TQR118' } });
      assert(mismo.status === 400, `al mismo carro: 400 (HTTP ${mismo.status})`);
      const noExiste = await call('/v1/driver/shift/switch', { method: 'POST', token, body: { plate: 'ZZZ999' } });
      const sigue = await call('/v1/driver/rides/me', { token });
      assert(noExiste.status === 404 && (sigue.body.shift as Json | null)?.plate === 'TQR118',
        'con una placa que no existe: 404, y sigue en turno en el TQR118');

      const audit = await fila<{ n: number }>(`select count(*)::int n from audit_log where action = 'Cambió de carro: del móvil UBP472 al TQR118' and entity_id = $1 and at > now() - interval '1 minute'`, [UNO]);
      assert(audit.n >= 1, 'la bitácora dice «Cambió de carro: del móvil UBP472 al TQR118»');
      const abrio = await fila<{ n: number }>(`select count(*)::int n from audit_log where action = 'Abrió turno en el móvil UBP472' and entity_id = $1 and at > now() - interval '1 minute'`, [UNO]);
      assert(abrio.n >= 1, 'y antes «Abrió turno en el móvil UBP472»');
    }

    console.log('\n3. Un móvil que el listado no le asigna: se abre, marcado');
    {
      // El SVM903 queda en el listado solo con el otro conductor.
      await db.query(
        `insert into vehicle_drivers (id, vehicle_id, driver_id, role)
         select $1, v.id, $2, 'conductor' from vehicles v where v.plate = 'SVM903'`,
        [vinculoDePrueba, otro],
      );
      const r = await call('/v1/driver/shift/switch', { method: 'POST', token, body: { plate: 'SVM903' } });
      assert(r.status < 400 && r.body.fueraDeListado === true, `pasa al SVM903 y viene marcado (HTTP ${r.status})`, r.body);
      const turno = await fila<{ fuera: boolean }>(`select fuera_de_listado fuera from driver_shifts where driver_id = $1 and ended_at is null`, [uno]);
      assert(turno?.fuera === true, 'el turno queda con fuera_de_listado');
      const audit = await fila<{ n: number }>(`select count(*)::int n from audit_log where action = 'Tomó el móvil SVM903, que el listado no le asigna' and entity_id = $1 and at > now() - interval '1 minute'`, [UNO]);
      assert(audit.n >= 1, 'y la bitácora lo anota');

      const vuelta = await call('/v1/driver/shift/switch', { method: 'POST', token, body: { plate: 'UBP472' } });
      assert(vuelta.status < 400 && vuelta.body.fueraDeListado === false, 'un móvil sin nadie en el listado no se marca');
    }

    console.log('\n4. Con una carrera tomada no se cambia de carro ni de conductor');
    {
      await call('/v1/driver/position', { method: 'POST', token, body: { point: { lat: CENTRO.lat + 0.001, lng: CENTRO.lng + 0.001 } } });
      const creada = await call('/v1/rides', {
        method: 'POST',
        apiKey: true,
        body: { customerPhone: `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, pickup: { text: 'Carrera 21 # 24-18', point: CENTRO } },
      });
      const rideId = creada.body.id as string;
      rideIds.push(rideId);
      let aceptada = { status: 0, body: {} as Json };
      for (let i = 0; i < 40 && aceptada.status !== 200 && aceptada.status !== 201; i++) {
        await new Promise((r) => setTimeout(r, 250));
        aceptada = await call(`/v1/driver/rides/${rideId}/accept`, { method: 'POST', token });
      }
      assert(aceptada.status < 400, `toma una carrera (HTTP ${aceptada.status})`, aceptada.body);

      const carro = await call('/v1/driver/shift/switch', { method: 'POST', token, body: { plate: 'TQR118' } });
      assert(codigo(carro) === 'DRIVER_BUSY', `cambiar de carro: DRIVER_BUSY (${codigo(carro)})`, carro.body);
      const salir = await call('/v1/driver/logout', { method: 'POST', token });
      assert(codigo(salir) === 'DRIVER_BUSY', `cambiar de conductor: DRIVER_BUSY (${codigo(salir)})`, salir.body);
      const me = await call('/v1/driver/rides/me', { token });
      assert(me.status === 200 && (me.body.shift as Json | null)?.plate === 'UBP472', 'y sigue en su turno y su sesión');

      await call(`/v1/rides/${rideId}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Fin del tramo de prueba' } });
    }

    console.log('\n5. Cambiar de conductor: sale el uno, entra el otro en el mismo celular');
    {
      const sub = await call('/v1/driver/push/subscribe', {
        method: 'POST',
        token,
        body: { endpoint: 'https://push.example.com/prueba-mano', keys: { p256dh: 'clave', auth: 'auth' } },
      });
      assert(sub.status < 400, 'el celular tiene push a nombre del uno');

      const salir = await call('/v1/driver/logout', { method: 'POST', token });
      assert(salir.status < 400, `sale (HTTP ${salir.status})`, salir.body);
      const despues = await call('/v1/driver/rides/me', { token });
      assert(despues.status === 401, `su sesión ya no vale (HTTP ${despues.status})`);
      const turno = await fila<{ n: number }>(`select count(*)::int n from driver_shifts where driver_id = $1 and ended_at is null`, [uno]);
      assert(turno.n === 0, 'su turno quedó cerrado');
      const dispositivo = await fila<{ revoked: boolean; push: string | null }>(
        `select revoked_at is not null revoked, push_subscription push from driver_devices where driver_id = $1 and install_id = $2 order by last_seen_at desc limit 1`,
        [uno, CELULAR],
      );
      assert(dispositivo.revoked && dispositivo.push === null, 'el celular quedó revocado y sin push a su nombre', dispositivo);

      const entra = await entrar(OTRO);
      assert(entra.status < 400, `el otro conductor entra con su código y PIN (HTTP ${entra.status})`, entra.body);
      const t2 = entra.body.token as string;
      const abre = await call('/v1/driver/shift/open', { method: 'POST', token: t2, body: { plate: 'UBP472' } });
      assert(abre.status < 400, 'y abre turno en el mismo carro', abre.body);
      await call('/v1/driver/shift/close', { method: 'POST', token: t2 });
      const salida = await fila<{ n: number }>(`select count(*)::int n from audit_log where action like 'Cerró turno en el móvil %y salió del celular (cambio de conductor)' and entity_id = $1 and at > now() - interval '1 minute'`, [UNO]);
      const cierre = await fila<{ n: number }>(`select count(*)::int n from audit_log where action = 'Cerró turno en el móvil UBP472' and entity_id = $1 and at > now() - interval '1 minute'`, [OTRO]);
      assert(salida.n >= 1 && cierre.n >= 1, 'la bitácora tiene la salida del uno y el cierre de turno del otro');
    }

    console.log('\n6. Si el otro entra sin que el primero haya salido, el primero pierde ese celular');
    {
      token = (await entrar(UNO)).body.token as string;
      await call('/v1/driver/push/subscribe', {
        method: 'POST',
        token,
        body: { endpoint: 'https://push.example.com/prueba-mano-2', keys: { p256dh: 'clave', auth: 'auth' } },
      });
      const entra = await entrar(OTRO);
      assert(entra.status < 400, 'entra el otro en el mismo celular');
      const viejo = await call('/v1/driver/rides/me', { token });
      assert(viejo.status === 401, `la sesión del primero en ese celular ya no vale (HTTP ${viejo.status})`);
      const vivos = await fila<{ n: number }>(
        `select count(*)::int n from driver_devices where install_id = $1 and revoked_at is null and push_subscription is not null and driver_id = $2`,
        [CELULAR, uno],
      );
      assert(vivos.n === 0, 'y no le quedan avisos push en ese teléfono');
    }

    console.log('\n7. Un conductor, un celular activo: entrar en otro cierra el anterior');
    {
      const telefonoA = await call('/v1/auth/driver', { method: 'POST', body: { code: UNO, pin: PIN, device: 'Celular A', install: `${CELULAR}-a` } });
      const tA = telefonoA.body.token as string;
      await call('/v1/driver/push/subscribe', {
        method: 'POST',
        token: tA,
        body: { endpoint: 'https://push.example.com/prueba-mano-a', keys: { p256dh: 'clave', auth: 'auth' } },
      });
      const telefonoB = await call('/v1/auth/driver', { method: 'POST', body: { code: UNO, pin: PIN, device: 'Celular B', install: `${CELULAR}-b` } });
      const tB = telefonoB.body.token as string;
      assert(telefonoB.status < 400, 'entra en el celular B');
      assert((await call('/v1/driver/rides/me', { token: tA })).status === 401, 'la sesión del celular A ya no vale');
      assert((await call('/v1/driver/rides/me', { token: tB })).status === 200, 'la del B sí');
      const activos = await fila<{ n: number; push: number }>(
        `select count(*)::int n, count(push_subscription)::int push from driver_devices where driver_id = $1 and revoked_at is null`,
        [uno],
      );
      assert(activos.n === 1 && activos.push === 0, `un solo celular activo, y el push del A se borró (${activos.n} activos)`, activos);
      const anota = await fila<{ n: number }>(`select count(*)::int n from audit_log where action = 'Entró en otro celular (el anterior quedó cerrado)' and entity_id = $1 and at > now() - interval '1 minute'`, [UNO]);
      assert(anota.n >= 1, 'la bitácora dice que entró en otro celular y el anterior quedó cerrado');
      await db.query(`update driver_devices set revoked_at = now() where install_id = $1 and revoked_at is null`, [`${CELULAR}-b`]);
    }
  } finally {
    await db.query('delete from vehicle_drivers where id = $1', [vinculoDePrueba]);
    await db.query(`update driver_shifts set ended_at = now() where ended_at is null and driver_id = any($1)`, [[uno, otro]]);
    await db.query(`update drivers set status = 'OFF_SHIFT' where id = any($1)`, [[uno, otro]]);
    await db.query(`update driver_devices set revoked_at = now(), push_subscription = null where install_id = $1 and revoked_at is null`, [CELULAR]);
    if (rideIds.length) {
      await db.query(`update rides set status = 'CANCELLED' where id = any($1) and status not in ('COMPLETED','CANCELLED')`, [rideIds]);
    }
    await db.end();
  }

  console.log(fallos ? `\n${fallos} comprobaciones fallaron.` : '\nTodo en orden.');
  process.exit(fallos ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
