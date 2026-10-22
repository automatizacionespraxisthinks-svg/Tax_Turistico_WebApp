import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../db/schema';
import { hashSecret } from '../common/crypto';
import { base32Decode, totp } from '../common/totp';

/**
 * Reinicio de contraseñas desde el panel (§8.1).
 *
 * Comprueba las tres decisiones de diseño que justifican esta funcionalidad:
 * que solo un administrador puede hacerlo, que la contraseña nueva funciona y
 * la vieja deja de servir, y —la importante— que el segundo factor del otro
 * NO se toca. Si se tocara, cualquier administrador podría entrar en la
 * cuenta de un compañero.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-usuarios.ts
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const CLAVE = 'clave-de-prueba-suficientemente-larga';
const ADMIN = 'prueba-admin-u@taxturistico.local';
const OPERADOR = 'prueba-oper-u@taxturistico.local';

function assert(condition: boolean, message: string, context?: unknown): void {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    if (context !== undefined) console.error('    ', JSON.stringify(context));
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

function crearSesion() {
  let cookie: string | undefined;
  return {
    get tieneCookie() {
      return Boolean(cookie);
    },
    async call(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
      if (options.body) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;

      const response = await fetch(`${BASE}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      const set = response.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];

      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
    },
  };
}

const code = (p: unknown) => (p as { code?: string } | null)?.code;

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://tax:tax_dev_password@localhost:55432/tax',
    max: 2,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  const limpiar = async () => {
    const usuarios = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(inArray(schema.users.email, [ADMIN, OPERADOR]));
    for (const u of usuarios) {
      await db.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, u.id));
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id));
    }
    await db.delete(schema.users).where(inArray(schema.users.email, [ADMIN, OPERADOR]));
  };

  const entrarCon = async (email: string, rol: 'administrador' | 'operador') => {
    await db.insert(schema.users).values({
      id: uuidv7(),
      email,
      name: rol === 'administrador' ? 'Admin U' : 'Operador U',
      passwordHash: await hashSecret(CLAVE),
      role: rol,
    });

    const s = crearSesion();
    await s.call('/v1/auth/session', { method: 'POST', body: { email, password: CLAVE } });
    const setup = await s.call('/v1/auth/totp/setup', { method: 'POST' });
    const { secret } = setup.body as { secret: string };
    await s.call('/v1/auth/totp/activate', {
      method: 'POST',
      body: { code: totp(base32Decode(secret)) },
    });
    return { sesion: s, secret };
  };

  try {
    await limpiar();

    console.log('1. Un operador no puede ver ni tocar los usuarios');
    const { sesion: operador, secret: secretoOperador } = await entrarCon(OPERADOR, 'operador');
    const prohibido = await operador.call('/v1/admin/users');
    assert(prohibido.status === 403, 'el servidor responde 403', prohibido.status);
    assert(code(prohibido.body) === 'FORBIDDEN', 'con FORBIDDEN', code(prohibido.body));

    console.log('\n2. Un administrador sí');
    const { sesion: admin } = await entrarCon(ADMIN, 'administrador');
    const lista = await admin.call('/v1/admin/users');
    assert(lista.status < 400, 'lista los usuarios');

    const usuarios = lista.body as { id: string; email: string; totpEnabled: boolean }[];
    const objetivo = usuarios.find((u) => u.email === OPERADOR);
    assert(Boolean(objetivo), 'el operador aparece en la lista');
    assert(objetivo!.totpEnabled === true, 'y se ve que tiene segundo factor activo');
    assert(
      !JSON.stringify(usuarios).includes('passwordHash') && !JSON.stringify(usuarios).includes('$argon'),
      'la lista no expone hashes de contraseña',
    );

    console.log('\n3. Reinicia la contraseña del operador');
    const reinicio = await admin.call(`/v1/admin/users/${objetivo!.id}/password`, {
      method: 'POST',
    });
    assert(reinicio.status === 201, `generada (HTTP ${reinicio.status})`, reinicio.body);
    const { password: nueva } = reinicio.body as { password: string };
    assert(nueva.length >= 20, 'es larga y aleatoria');

    console.log('\n4. La nueva sirve y la vieja no');
    const conNueva = crearSesion();
    const intentoNueva = await conNueva.call('/v1/auth/session', {
      method: 'POST',
      body: { email: OPERADOR, password: nueva },
    });
    // Pide el segundo factor: eso ya demuestra que la contraseña pasó.
    assert(
      code(intentoNueva.body) === 'TOTP_REQUIRED',
      'la nueva pasa y pide el segundo factor',
      code(intentoNueva.body),
    );

    const conVieja = crearSesion();
    const intentoVieja = await conVieja.call('/v1/auth/session', {
      method: 'POST',
      body: { email: OPERADOR, password: CLAVE },
    });
    assert(intentoVieja.status === 401, 'la anterior deja de servir', intentoVieja.status);
    assert(code(intentoVieja.body) !== 'TOTP_REQUIRED', 'y ni siquiera llega al segundo factor');

    console.log('\n5. El segundo factor del operador quedó intacto');
    const [fila] = await db
      .select({
        totpEnabled: schema.users.totpEnabled,
        secreto: schema.users.totpSecretEncrypted,
      })
      .from(schema.users)
      .where(eq(schema.users.email, OPERADOR));
    // Esto es lo que impide que un administrador suplante a otro: puede
    // devolverle el acceso, no entrar en su cuenta.
    assert(fila?.totpEnabled === true, 'sigue activo');
    assert(Boolean(fila?.secreto), 'y su secreto no se tocó');

    const respaldos = await db
      .select({ id: schema.userRecoveryCodes.id })
      .from(schema.userRecoveryCodes)
      .innerJoin(schema.users, eq(schema.users.id, schema.userRecoveryCodes.userId))
      .where(eq(schema.users.email, OPERADOR));
    assert(respaldos.length === 10, `sus ${respaldos.length} códigos de respaldo siguen ahí`);

    console.log('\n6. Sus sesiones abiertas se cerraron');
    const viva = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(eq(schema.users.email, OPERADOR), isNull(schema.sessions.revokedAt)));
    assert(viva.length === 0, 'ninguna sesión viva', viva.length);

    const conSesionVieja = await operador.call('/v1/auth/me');
    assert(conSesionVieja.status === 401, 'su cookie anterior ya no vale');

    console.log('\n7. Quedó en la bitácora, con quién lo hizo');
    const entradas = await db
      .select({ action: schema.auditLog.action, actorName: schema.auditLog.actorName })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, OPERADOR));

    assert(
      entradas.some((e) => e.action === 'Reinició la contraseña de un usuario'),
      'registrado el reinicio',
    );
    assert(
      entradas.some((e) => e.actorName === 'Admin U'),
      'con el nombre del administrador, no «sistema»',
    );

    console.log('\n8. El propio usuario cambia su contrasena');

    // Entra con la contrasena que le acaban de generar: el estado real de
    // alguien a quien le reiniciaron el acceso.
    const suya = crearSesion();
    await suya.call('/v1/auth/session', {
      method: 'POST',
      body: {
        email: OPERADOR,
        password: nueva,
        // La activacion quemo el intervalo actual: se usa el siguiente, que
        // el servidor acepta por la ventana de +/-1.
        totp: totp(base32Decode(secretoOperador), Date.now() + 30000),
      },
    });
    assert((await suya.call('/v1/auth/me')).status < 400, 'el operador entra con la nueva');

    const PROPIA = 'el jardin de mi abuela en marzo';

    const sinActual = await suya.call('/v1/auth/password', {
      method: 'POST',
      body: { currentPassword: 'la-que-no-es', newPassword: PROPIA },
    });
    // Esto es lo que impide que quien se siente ante una sesion abierta deje
    // fuera a su dueno cambiandole la contrasena.
    assert(sinActual.status === 401, 'sin la actual no se puede cambiar', sinActual.status);

    const conEmpresa = await suya.call('/v1/auth/password', {
      method: 'POST',
      body: { currentPassword: nueva, newPassword: 'taxituristico1' },
    });
    assert(code(conEmpresa.body) === 'VALIDATION_FAILED', 'rechaza el nombre de la empresa');

    const corta = await suya.call('/v1/auth/password', {
      method: 'POST',
      body: { currentPassword: nueva, newPassword: 'Ab3-xY9z' },
    });
    assert(code(corta.body) === 'VALIDATION_FAILED', 'y una corta aunque lleve simbolos');

    const otraVez = await suya.call('/v1/auth/password', {
      method: 'POST',
      body: { currentPassword: nueva, newPassword: nueva },
    });
    assert(code(otraVez.body) === 'VALIDATION_FAILED', 'y repetir la misma');

    // Simula que pasaron los 30 segundos: sin esto, el segundo acceso
    // reutilizaria el intervalo que acaba de quemar el primero.
    await db
      .update(schema.users)
      .set({ totpLastCounter: null })
      .where(eq(schema.users.email, OPERADOR));

    const otraSesion = crearSesion();
    await otraSesion.call('/v1/auth/session', {
      method: 'POST',
      body: {
        email: OPERADOR,
        password: nueva,
        totp: totp(base32Decode(secretoOperador), Date.now() + 30000),
      },
    });
    assert((await otraSesion.call('/v1/auth/me')).status < 400, 'abre una segunda sesion');

    const cambio = await suya.call('/v1/auth/password', {
      method: 'POST',
      body: { currentPassword: nueva, newPassword: PROPIA },
    });
    assert(cambio.status === 204, 'acepta una frase larga sin un solo simbolo', cambio.status);

    assert((await suya.call('/v1/auth/me')).status < 400, 'su sesion actual sigue viva');
    assert((await otraSesion.call('/v1/auth/me')).status === 401, 'pero la otra quedo cerrada');

    const conPropia = crearSesion();
    const entrarPropia = await conPropia.call('/v1/auth/session', {
      method: 'POST',
      body: { email: OPERADOR, password: PROPIA },
    });
    assert(code(entrarPropia.body) === 'TOTP_REQUIRED', 'la suya nueva sirve para entrar');

    const trasCambio = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, OPERADOR));
    assert(
      trasCambio.some((e) => e.action.startsWith('Cambi')),
      'y queda en la bitacora a su nombre',
    );

    console.log('\nTodo correcto.\n');
  } finally {
    await limpiar();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('\nLa prueba falló:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
