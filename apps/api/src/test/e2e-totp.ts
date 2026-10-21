import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { base32Decode, counterAt, totp } from '../common/totp';

/**
 * Segundo factor de la oficina, de extremo a extremo (§8.1).
 *
 * Recorre el camino completo contra la API en marcha: una cuenta sin segundo
 * factor que no puede usar el panel, el alta con el QR, el acceso pidiendo el
 * código, el rechazo del mismo código dos veces, el código de respaldo, y el
 * bloqueo tras cinco intentos.
 *
 * La cuenta vuelve al estado inicial al terminar, así que se puede ejecutar
 * las veces que haga falta.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-totp.ts
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const EMAIL = 'operadora@taxturistico.local';
const PASSWORD = 'desarrollo-no-usar-en-produccion';

function assert(condition: boolean, message: string, context?: unknown): void {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    if (context !== undefined) console.error('    ', JSON.stringify(context));
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

/** La sesión va en cookie HttpOnly; `fetch` no las guarda, así que a mano. */
let cookie: string | undefined;

async function call(
  path: string,
  options: { method?: string; body?: unknown; withCookie?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (options.body) headers['content-type'] = 'application/json';
  if (options.withCookie !== false && cookie) headers.cookie = cookie;

  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];

  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

const code = (problem: unknown) => (problem as { code?: string } | null)?.code;

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://tax:tax_dev_password@localhost:55432/tax',
    max: 2,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  /** Deja la cuenta como recién creada: sin segundo factor y sin bloqueo. */
  const reiniciar = async () => {
    const [user] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, EMAIL))
      .limit(1);
    if (!user) throw new Error(`No existe ${EMAIL}: ¿falta sembrar la base?`);

    await db.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, user.id));
    await db
      .update(schema.users)
      .set({
        totpEnabled: false,
        totpSecretEncrypted: null,
        totpLastCounter: null,
        failedAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(schema.users.id, user.id));
    return user.id;
  };

  try {
    const userId = await reiniciar();
    cookie = undefined;

    console.log('0. Una cuenta sin segundo factor entra, pero no llega a nada');

    const sinFactor = await call('/v1/auth/session', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
    });
    assert(sinFactor.status < 400, 'entra solo con la contraseña', sinFactor.body);
    assert(
      (sinFactor.body as { user: { totpEnabled: boolean } }).user.totpEnabled === false,
      'y el panel sabe que le falta el segundo factor',
    );

    // Esto es lo que convierte el «obligatorio» de §8.1 en algo real: no es un
    // aviso en la interfaz, el servidor cierra la puerta.
    const panel = await call('/v1/admin/rides');
    assert(panel.status === 403, 'el panel le responde 403', panel.status);
    assert(code(panel.body) === 'TOTP_SETUP_REQUIRED', 'con TOTP_SETUP_REQUIRED', code(panel.body));

    console.log('\n1. Alta del segundo factor');

    const setup = await call('/v1/auth/totp/setup', { method: 'POST' });
    assert(setup.status < 400, 'genera el secreto', setup.body);
    const { secret, uri } = setup.body as { secret: string; uri: string };
    assert(/^[A-Z2-7]{32}$/.test(secret), 'el secreto son 20 bytes en base32');
    assert(uri.startsWith('otpauth://totp/'), 'y viene el URI para el QR');
    assert(uri.includes('issuer=Tax'), 'con el emisor, que es lo que muestra el teléfono');

    const malo = await call('/v1/auth/totp/activate', { method: 'POST', body: { code: '000000' } });
    assert(code(malo.body) === 'TOTP_INVALID', 'un código equivocado no activa nada');

    const bytes = base32Decode(secret);
    const activacion = await call('/v1/auth/totp/activate', {
      method: 'POST',
      body: { code: totp(bytes) },
    });
    assert(activacion.status < 400, 'el código del teléfono lo activa', activacion.body);

    const { recoveryCodes } = activacion.body as { recoveryCodes: string[] };
    assert(recoveryCodes.length === 10, `entrega ${recoveryCodes.length} códigos de respaldo`);
    assert(
      recoveryCodes.every((c) => /^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(c)),
      'con formato legible y sin caracteres confundibles',
    );
    assert(new Set(recoveryCodes).size === 10, 'y todos distintos');

    const panelAhora = await call('/v1/admin/rides');
    assert(panelAhora.status < 400, 'ahora sí entra al panel', panelAhora.status);

    console.log('\n2. El acceso pide el código');

    await call('/v1/auth/logout', { method: 'POST' });
    cookie = undefined;

    const sinCodigo = await call('/v1/auth/session', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
    });
    assert(sinCodigo.status === 401, 'la contraseña sola ya no basta', sinCodigo.status);
    assert(code(sinCodigo.body) === 'TOTP_REQUIRED', 'con TOTP_REQUIRED', code(sinCodigo.body));

    /*
     * El código de la activación ya se quemó: ese código viajó por la red y
     * admitirlo otra vez en el acceso sería justo el reenvío del que protege
     * el contador. En la vida real el operador ya está dentro con su sesión y
     * no vuelve a entrar hasta horas después; aquí se toma el código del
     * intervalo siguiente, que es lo mismo que esperar 30 segundos sin que la
     * prueba tarde 30 segundos.
     */
    const usado = totp(bytes, Date.now() + 30_000);
    const conCodigo = await call('/v1/auth/session', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD, totp: usado },
    });
    assert(conCodigo.status < 400, 'con el código entra', conCodigo.body);

    console.log('\n3. El mismo código no sirve dos veces');

    cookie = undefined;
    const repetido = await call('/v1/auth/session', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD, totp: usado },
    });
    // Sigue siendo correcto durante sus 30 s: lo que lo rechaza es que ya se
    // quemó. Sin esto, verlo por encima del hombro bastaría.
    assert(repetido.status === 401, 'el código ya quemado se rechaza', repetido.status);
    assert(code(repetido.body) === 'TOTP_INVALID', 'con TOTP_INVALID', code(repetido.body));

    const [fila] = await db
      .select({ counter: schema.users.totpLastCounter })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    assert(
      fila?.counter === counterAt() + 1,
      'la base guardó el intervalo quemado',
      fila?.counter,
    );

    console.log('\n4. El código de respaldo abre, una sola vez');

    // El acceso anterior quemó el intervalo actual, así que se usa un
    // repuesto: es justo el caso de «perdí el teléfono».
    const respaldo = recoveryCodes[0]!;
    cookie = undefined;
    const conRespaldo = await call('/v1/auth/session', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD, totp: respaldo },
    });
    assert(conRespaldo.status < 400, 'el código de respaldo entra', conRespaldo.body);

    const quedan = await call('/v1/auth/me');
    assert(
      (quedan.body as { recoveryCodesLeft: number }).recoveryCodesLeft === 9,
      'y queda uno menos: 9',
      (quedan.body as { recoveryCodesLeft: number }).recoveryCodesLeft,
    );

    cookie = undefined;
    const respaldoRepetido = await call('/v1/auth/session', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD, totp: respaldo },
    });
    assert(respaldoRepetido.status === 401, 'el mismo repuesto ya no vale', respaldoRepetido.status);

    console.log('\n5. Cinco códigos fallidos bloquean la cuenta');

    // Se parte de cero: un acceso correcto por el camino reinicia el contador
    // de fallos, así que contar los de antes sería contar mal.
    await db
      .update(schema.users)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(schema.users.id, userId));

    for (let intento = 1; intento <= 5; intento++) {
      const fallido = await call('/v1/auth/session', {
        method: 'POST',
        body: { email: EMAIL, password: PASSWORD, totp: '000000' },
      });
      assert(fallido.status === 401, `intento ${intento} rechazado`, fallido.status);
    }

    const [bloqueo] = await db
      .select({ lockedUntil: schema.users.lockedUntil })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    assert(Boolean(bloqueo?.lockedUntil), 'la cuenta queda bloqueada 15 minutos');

    // Se libera el contador para que el código de abajo sea legítimo: así lo
    // único que puede rechazarlo es el bloqueo, que es lo que se comprueba.
    await db
      .update(schema.users)
      .set({ totpLastCounter: null })
      .where(eq(schema.users.id, userId));

    const bloqueado = await call('/v1/auth/session', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD, totp: totp(bytes) },
    });
    assert(
      bloqueado.status === 401 && /bloquead/i.test(JSON.stringify(bloqueado.body)),
      'ni con el código correcto entra mientras está bloqueada',
      bloqueado.body,
    );

    console.log('\nTodo correcto.\n');
  } finally {
    // La cuenta vuelve a cero para que la prueba se pueda repetir y para no
    // dejar al panel de desarrollo pidiendo un código que nadie tiene.
    await reiniciar();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('\nLa prueba falló:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
