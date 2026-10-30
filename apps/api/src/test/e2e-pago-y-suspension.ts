import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../db/schema';
import { hashSecret } from '../common/crypto';
import { base32Decode, totp } from '../common/totp';

/**
 * Pago electrónico, suspensión y relevo de turno, de extremo a extremo.
 *
 * Lo que se comprueba no es que los endpoints respondan, sino las reglas:
 *
 *  - una carrera con pago electrónico solo se le ofrece a quien lo recibe, y
 *    si no hay nadie queda sin asignar en vez de abrirse a los demás;
 *  - cambiada a efectivo y relanzada, sí le llega a cualquiera;
 *  - la asignación manual respeta la misma regla;
 *  - un suspendido no entra a la PWA ni abre turno, pero termina la carrera
 *    que llevaba, y al levantarle la suspensión vuelve a entrar;
 *  - un carro con varios conductores: el que llega abre turno aunque el
 *    anterior lo haya dejado abierto, salvo que el carro esté en carrera.
 *
 * Usa los conductores del seed (101, 102, 103) y crea su propio
 * administrador, que borra al terminar.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-pago-y-suspension.ts <clave-de-api>
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const API_KEY = process.argv[2] ?? process.env.TAX_API_KEY;
const ADMIN = { email: 'prueba-pago@taxturistico.local', pass: 'clave-de-prueba-suficientemente-larga' };
const PIN = '4821';
const CENTRO = { lat: 5.7803, lng: -73.1142 };

/** Solo efectivo. */
const EFECTIVO = { code: '101', plate: 'UBP472' };
/** Recibe pago electrónico. */
const ELECTRONICO = { code: '102', plate: 'TQR118' };
/** El relevador que toma el carro de 101. */
const RELEVO = { code: '103', plate: 'SVM903' };
const TODOS = [EFECTIVO, ELECTRONICO, RELEVO];

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

async function call(
  path: string,
  options: { method?: string; body?: unknown; token?: string; apiKey?: boolean; cookie?: string } = {},
): Promise<{ status: number; body: Json; setCookie: string | null }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.apiKey && API_KEY) headers['x-api-key'] = API_KEY;
  if (options.cookie) headers.cookie = options.cookie;

  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, setCookie: response.headers.get('set-cookie') };
}

const codigo = (body: Json) => body.code as string | undefined;

async function entrar(quien: { code: string; plate: string }) {
  return call('/v1/auth/driver', {
    method: 'POST',
    body: { code: quien.code, plate: quien.plate, pin: PIN, device: 'prueba', install: `pago-${quien.code}` },
  });
}

async function token(quien: { code: string; plate: string }): Promise<string> {
  const login = await entrar(quien);
  assert(login.status < 400, `conductor ${quien.code} entra`, login.body);
  return login.body.token as string;
}

/** Abre turno con esa placa y reporta posición en el centro. */
async function enTurno(t: string, plate: string, etiqueta: string): Promise<void> {
  const turno = await call('/v1/driver/shift/open', { method: 'POST', token: t, body: { plate } });
  assert(turno.status < 400, `${etiqueta} abre turno con ${plate}`, turno.body);
  const posicion = await call('/v1/driver/position', {
    method: 'POST',
    token: t,
    body: { point: { lat: CENTRO.lat + 0.001, lng: CENTRO.lng + 0.001 } },
  });
  assert(posicion.status < 400, `${etiqueta} reporta posición`, posicion.body);
}

async function pedir(etiqueta: string, pagoElectronico?: boolean): Promise<string> {
  const creada = await call('/v1/rides', {
    method: 'POST',
    apiKey: true,
    body: {
      customerPhone: `+5731${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      customerName: etiqueta,
      pickup: { text: 'Carrera 21 # 24-18', point: CENTRO },
      vehicleType: 'sedan',
      passengers: 1,
      ...(pagoElectronico === undefined ? {} : { pagoElectronico }),
    },
  });
  assert(creada.status < 400, `carrera creada: ${etiqueta}`, creada.body);
  return creada.body.id as string;
}

/** Espera a que la carrera tenga ofertas o quede sin asignar. */
async function esperar(rideId: string): Promise<{ status: string; offers: { driverId: string }[]; history: { note: string | null }[] }> {
  for (let i = 0; i < 40; i++) {
    const detalle = await call(`/v1/rides/${rideId}`, { apiKey: true });
    const cuerpo = detalle.body as unknown as { status: string; offers: { driverId: string }[]; history: { note: string | null }[] };
    if (cuerpo.offers?.length > 0 || cuerpo.status === 'UNASSIGNED') return cuerpo;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`La carrera ${rideId} no salió de Pendiente`);
}

async function cancelar(rideId: string): Promise<void> {
  await call(`/v1/rides/${rideId}/cancel`, { method: 'POST', apiKey: true, body: { reason: 'Fin del tramo de prueba' } });
}

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

  const conductores = await db
    .select({ id: schema.drivers.id, code: schema.drivers.code })
    .from(schema.drivers)
    .where(inArray(schema.drivers.code, TODOS.map((c) => c.code)));
  const idDe = (c: { code: string }) => conductores.find((d) => d.code === c.code)!.id;

  /** Deja a los tres como los dejó el seed: sin pago electrónico ni suspensión. */
  const restaurar = async () => {
    await db
      .update(schema.drivers)
      .set({ aceptaPagoElectronico: false, suspendidoHasta: null, motivoSuspension: null })
      .where(inArray(schema.drivers.code, TODOS.map((c) => c.code)));
  };

  const limpiarAdmin = async () => {
    const usuarios = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, ADMIN.email));
    for (const u of usuarios) {
      await db.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, u.id));
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id));
    }
    await db.delete(schema.users).where(eq(schema.users.email, ADMIN.email));
  };

  try {
    console.log('\n0. Limpieza');
    const activas = await call('/v1/rides?status=ASSIGNED,DRIVER_ARRIVED,IN_PROGRESS,NOTIFIED,PENDING,UNASSIGNED', { apiKey: true });
    for (const vieja of Array.isArray(activas.body) ? (activas.body as unknown as { id: string }[]) : []) {
      await cancelar(vieja.id);
    }
    await restaurar();
    await limpiarAdmin();
    const tokens = new Map<string, string>();
    for (const c of TODOS) {
      const t = await token(c);
      await call('/v1/driver/shift/close', { method: 'POST', token: t });
      tokens.set(c.code, t);
    }

    // El administrador, con su segundo factor, como en e2e-flota.
    await db.insert(schema.users).values({
      id: uuidv7(),
      email: ADMIN.email,
      name: 'Admin de prueba de pagos',
      passwordHash: await hashSecret(ADMIN.pass),
      role: 'administrador',
    });
    let cookie = '';
    const acceso = await call('/v1/auth/session', { method: 'POST', body: { email: ADMIN.email, password: ADMIN.pass } });
    cookie = acceso.setCookie!.split(';')[0]!;
    const setup = await call('/v1/auth/totp/setup', { method: 'POST', cookie });
    const activar = await call('/v1/auth/totp/activate', {
      method: 'POST',
      cookie,
      body: { code: totp(base32Decode((setup.body as { secret: string }).secret)) },
    });
    cookie = activar.setCookie?.split(';')[0] ?? cookie;
    assert(activar.status < 400, 'el administrador de prueba entra', activar.body);
    const admin = (path: string, options: { method?: string; body?: unknown } = {}) => call(path, { ...options, cookie });

    console.log('\n1. Pago electrónico sin nadie que lo reciba');
    await enTurno(tokens.get(EFECTIVO.code)!, EFECTIVO.plate, '101 (solo efectivo)');
    const sinNadie = await pedir('Paga con Nequi', true);
    const r1 = await esperar(sinNadie);
    assert(r1.offers.length === 0, 'no se le ofrece a quien solo recibe efectivo', r1.offers);
    assert(r1.status === 'UNASSIGNED', 'y queda sin asignar en vez de abrirse a los demás', r1.status);
    assert(
      r1.history.some((h) => h.note?.includes('pago electrónico')),
      'la bitácora dice que faltaron conductores con pago electrónico',
      r1.history,
    );

    const manual = await admin(`/v1/admin/rides/${sinNadie}/assign`, { method: 'POST', body: { driverId: idDe(EFECTIVO) } });
    assert(manual.status === 409 && codigo(manual.body) === 'DRIVER_NO_ELECTRONIC_PAYMENT', 'la asignación manual tampoco se lo da', manual.body);

    console.log('\n2. El cliente acepta pagar en efectivo');
    const cambio = await call(`/v1/rides/${sinNadie}/payment`, { method: 'PATCH', apiKey: true, body: { pagoElectronico: false } });
    assert(cambio.status < 400 && cambio.body.pagoElectronico === false, 'n8n la cambia a efectivo', cambio.body);
    const relanzar = await call(`/v1/rides/${sinNadie}/redispatch`, { method: 'POST', apiKey: true });
    assert(relanzar.status < 400, 'y la relanza', relanzar.body);
    const r2 = await esperar(sinNadie);
    assert(r2.offers.some((o) => o.driverId === idDe(EFECTIVO)), 'ahora sí le llega a 101', r2.offers);
    await cancelar(sinNadie);

    const tarde = await call(`/v1/rides/${sinNadie}/payment`, { method: 'PATCH', apiKey: true, body: { pagoElectronico: true } });
    assert(tarde.status === 409 && codigo(tarde.body) === 'INVALID_TRANSITION', 'fuera de «sin asignar» no se cambia', tarde.body);

    console.log('\n3. Con alguien que sí lo recibe');
    const habilitar = await admin(`/v1/admin/drivers/${idDe(ELECTRONICO)}`, { method: 'PATCH', body: { aceptaPagoElectronico: true } });
    assert(habilitar.status < 400, 'la oficina habilita el pago electrónico a 102', habilitar.body);
    await enTurno(tokens.get(ELECTRONICO.code)!, ELECTRONICO.plate, '102 (recibe electrónico)');

    const conAlguien = await pedir('Paga con transferencia', true);
    const r3 = await esperar(conAlguien);
    const a = r3.offers.map((o) => o.driverId);
    assert(a.includes(idDe(ELECTRONICO)), 'se le ofrece a 102', a);
    assert(!a.includes(idDe(EFECTIVO)), 'y no a 101, que está igual de cerca', a);
    await cancelar(conAlguien);

    const efectivo = await pedir('Paga en efectivo');
    const r4 = await esperar(efectivo);
    const b = r4.offers.map((o) => o.driverId);
    assert(b.includes(idDe(EFECTIVO)) && b.includes(idDe(ELECTRONICO)), 'una en efectivo les llega a los dos', b);
    await cancelar(efectivo);

    const flota = await admin('/v1/admin/drivers');
    const fila102 = (flota.body as unknown as { id: string; aceptaPagoElectronico: boolean }[]).find((d) => d.id === idDe(ELECTRONICO));
    assert(fila102?.aceptaPagoElectronico === true, 'Flota muestra que 102 recibe pago electrónico');

    console.log('\n4. Suspensión');
    const suspender = await admin(`/v1/admin/drivers/${idDe(EFECTIVO)}/suspension`, {
      method: 'POST',
      body: { dias: 3, motivo: 'Prueba: falta al reglamento interno' },
    });
    assert(suspender.status < 400 && typeof suspender.body.suspendidoHasta === 'string', 'la oficina suspende a 101 por 3 días', suspender.body);
    const dias = (new Date(suspender.body.suspendidoHasta as string).getTime() - Date.now()) / 86_400_000;
    assert(dias > 2.99 && dias <= 3, 'hasta dentro de tres días', dias);

    const fuera = await call('/v1/driver/rides/me', { token: tokens.get(EFECTIVO.code) });
    assert(fuera.status === 401, 'su sesión deja de valer de inmediato', fuera.status);
    const [estado101] = await db.select({ status: schema.drivers.status }).from(schema.drivers).where(eq(schema.drivers.id, idDe(EFECTIVO)));
    assert(estado101?.status === 'OFF_SHIFT', 'y su turno quedó cerrado', estado101);

    const reingreso = await entrar(EFECTIVO);
    assert(reingreso.status === 403 && codigo(reingreso.body) === 'DRIVER_SUSPENDED', 'al entrar le dicen que está suspendido', reingreso.body);
    assert(String(reingreso.body.detail).includes('suspendido hasta el'), 'y hasta cuándo', reingreso.body.detail);

    const malPin = await call('/v1/auth/driver', {
      method: 'POST',
      body: { code: EFECTIVO.code, plate: EFECTIVO.plate, pin: '0000', device: 'prueba', install: 'pago-101' },
    });
    assert(malPin.status === 401, 'con el PIN equivocado no se revela la suspensión', malPin.body);
    await db.update(schema.drivers).set({ failedAttempts: 0 }).where(eq(schema.drivers.id, idDe(EFECTIVO)));

    const flota2 = await admin('/v1/admin/drivers');
    const fila101 = (flota2.body as unknown as { id: string; suspendidoHasta?: string; motivoSuspension?: string }[]).find(
      (d) => d.id === idDe(EFECTIVO),
    );
    assert(Boolean(fila101?.suspendidoHasta) && fila101?.motivoSuspension?.startsWith('Prueba') === true, 'Flota la muestra con su motivo', fila101);

    const levantar = await admin(`/v1/admin/drivers/${idDe(EFECTIVO)}/suspension`, { method: 'DELETE' });
    assert(levantar.status === 204, 'la oficina la levanta antes de tiempo', levantar.status);
    tokens.set(EFECTIVO.code, await token(EFECTIVO));

    console.log('\n5. Relevo: otro conductor toma el mismo carro');
    await enTurno(tokens.get(EFECTIVO.code)!, EFECTIVO.plate, '101');
    const relevo = await call('/v1/driver/shift/open', { method: 'POST', token: tokens.get(RELEVO.code), body: { plate: EFECTIVO.plate } });
    assert(relevo.status < 400, '103 abre turno con la placa de 101, que lo dejó abierto', relevo.body);
    const de101 = await call('/v1/driver/rides/me', { token: tokens.get(EFECTIVO.code) });
    assert((de101.body as { shift: unknown }).shift === null, 'a 101 se le cerró el turno', de101.body);

    // 103 toma una carrera con el carro: ahí ya no se le puede quitar.
    await call('/v1/driver/position', {
      method: 'POST',
      token: tokens.get(RELEVO.code),
      body: { point: { lat: CENTRO.lat + 0.001, lng: CENTRO.lng + 0.001 } },
    });
    await call('/v1/driver/shift/close', { method: 'POST', token: tokens.get(ELECTRONICO.code) });
    const enCarrera = await pedir('Carrera del relevo');
    const r5 = await esperar(enCarrera);
    assert(r5.offers.some((o) => o.driverId === idDe(RELEVO)), 'se le ofrece a 103', r5.offers);
    const acepta = await call(`/v1/driver/rides/${enCarrera}/accept`, { method: 'POST', token: tokens.get(RELEVO.code) });
    assert(acepta.status < 400, '103 la acepta', acepta.body);

    const quitar = await call('/v1/driver/shift/open', { method: 'POST', token: tokens.get(EFECTIVO.code), body: { plate: EFECTIVO.plate } });
    assert(quitar.status === 409 && String(quitar.body.detail).includes('está en una carrera'), 'con el carro en carrera no hay relevo', quitar.body);

    console.log('\n6. Suspendido en plena carrera');
    await admin(`/v1/admin/drivers/${idDe(RELEVO)}/suspension`, { method: 'POST', body: { dias: 1, motivo: 'Prueba en plena carrera' } });
    const sigue = await call('/v1/driver/rides/me', { token: tokens.get(RELEVO.code) });
    assert(sigue.status === 200 && (sigue.body as { activeRide: unknown }).activeRide !== null, 'la carrera que lleva la puede seguir', sigue.status);
    await cancelar(enCarrera);
    const despues = await call('/v1/driver/rides/me', { token: tokens.get(RELEVO.code) });
    assert(despues.status === 401, 'al terminarla queda fuera', despues.status);
    const [estado103] = await db.select({ status: schema.drivers.status }).from(schema.drivers).where(eq(schema.drivers.id, idDe(RELEVO)));
    assert(estado103?.status === 'OFF_SHIFT', 'y con el turno cerrado', estado103);

    console.log('\n✓ Pago electrónico, suspensión y relevo se cumplen de extremo a extremo\n');
  } finally {
    await restaurar();
    for (const c of TODOS) {
      const login = await entrar(c);
      if (login.status < 400) await call('/v1/driver/shift/close', { method: 'POST', token: login.body.token as string });
    }
    await limpiarAdmin();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\nLa prueba falló:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
