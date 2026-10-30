import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { and, eq, inArray, like, ne, or } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../db/schema';
import { hashSecret } from '../common/crypto';
import { base32Decode, totp } from '../common/totp';

/**
 * Alta de operadores desde el panel (§8.1).
 *
 * El recorrido completo de alguien nuevo en la oficina:
 *
 *  1. un administrador lo crea con un usuario (correo o nombre corto) y recibe
 *     una contraseña temporal, una sola vez;
 *  2. con ella, la sesión solo sirve para cambiarla: ni el panel ni el alta
 *     del segundo factor, porque quien la generó también la conoce;
 *  3. después de cambiarla, el alta del segundo factor; y solo después, el
 *     panel;
 *  4. la temporal caduca, y no se puede usar dos veces;
 *  5. el límite de operadores activos se respeta, y desactivar a alguien
 *     libera su cupo y le cierra la puerta.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-alta-operadores.ts
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const CLAVE = 'clave-de-prueba-suficientemente-larga';
const ADMIN = 'prueba-alta-admin@taxturistico.local';
const PREFIJO = 'prueba-alta';
const MAXIMO = Number(process.env.MAX_OPERADORES ?? 5);

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

interface Creado {
  id: string;
  login: string;
  password: string;
  expiresAt: string;
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://tax:tax_dev_password@localhost:55432/tax',
    max: 2,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  const deLaPrueba = or(eq(schema.users.email, ADMIN), like(schema.users.email, `${PREFIJO}%`));

  const limpiar = async () => {
    const usuarios = await db.select({ id: schema.users.id }).from(schema.users).where(deLaPrueba);
    const ids = usuarios.map((u) => u.id);
    if (ids.length > 0) {
      await db.delete(schema.userRecoveryCodes).where(inArray(schema.userRecoveryCodes.userId, ids));
      await db.delete(schema.sessions).where(inArray(schema.sessions.userId, ids));
      await db.delete(schema.users).where(inArray(schema.users.id, ids));
    }
  };

  /** Desactiva a quien ya ocupara cupo (todos menos administradores), para medir el límite desde cero. */
  let apartados: string[] = [];

  try {
    await limpiar();

    const previos = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(ne(schema.users.role, 'administrador'), eq(schema.users.active, true)));
    apartados = previos.map((u) => u.id);
    if (apartados.length > 0) {
      await db.update(schema.users).set({ active: false }).where(inArray(schema.users.id, apartados));
    }

    // Un administrador ya dado de alta, con su segundo factor.
    await db.insert(schema.users).values({
      id: uuidv7(),
      email: ADMIN,
      name: 'Admin Alta',
      passwordHash: await hashSecret(CLAVE),
      role: 'administrador',
    });
    const admin = crearSesion();
    await admin.call('/v1/auth/session', { method: 'POST', body: { email: ADMIN, password: CLAVE } });
    const setupAdmin = await admin.call('/v1/auth/totp/setup', { method: 'POST' });
    await admin.call('/v1/auth/totp/activate', {
      method: 'POST',
      body: { code: totp(base32Decode((setupAdmin.body as { secret: string }).secret)) },
    });

    /* ------------------------------------------------------------------ */
    console.log('1. El administrador crea un operador con nombre de usuario');
    const r = await admin.call('/v1/admin/users', {
      method: 'POST',
      body: { name: 'Ana Prueba', login: `  ${PREFIJO}.Ana ` },
    });
    assert(r.status === 201, `creado (HTTP ${r.status})`, r.body);
    const ana = r.body as Creado;
    assert(ana.login === `${PREFIJO}.ana`, `el usuario queda en minúsculas y sin espacios: ${ana.login}`);
    assert(ana.password.length >= 20, 'con una contraseña temporal larga y aleatoria');
    const horas = (new Date(ana.expiresAt).getTime() - Date.now()) / 3600_000;
    assert(horas > 71 && horas <= 72, `que caduca en 72 horas (${horas.toFixed(1)} h)`);

    const [fila] = await db
      .select({ role: schema.users.role, hash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.email, ana.login));
    assert(fila?.role === 'operador', 'con rol de operador');
    assert(!fila!.hash.includes(ana.password), 'y en la base solo queda su hash');

    const repetido = await admin.call('/v1/admin/users', {
      method: 'POST',
      body: { name: 'Otra Ana', login: `${PREFIJO}.ANA` },
    });
    assert(code(repetido.body) === 'LOGIN_TAKEN', 'el mismo usuario en mayúsculas no se repite', repetido.body);

    const invalido = await admin.call('/v1/admin/users', {
      method: 'POST',
      body: { name: 'Mal Escrito', login: 'con espacios y tildes ñ' },
    });
    assert(invalido.status === 400, 'un usuario con espacios se rechaza', invalido.status);

    /* ------------------------------------------------------------------ */
    console.log('\n2. Con la temporal, la sesión solo sirve para cambiarla');
    const sesionAna = crearSesion();
    const entrada = await sesionAna.call('/v1/auth/session', {
      method: 'POST',
      body: { email: `${PREFIJO}.ANA`, password: ana.password },
    });
    assert(entrada.status < 400, 'entra con el usuario, sin importar mayúsculas', entrada.body);
    const yo = (entrada.body as { user: { mustChangePassword: boolean; totpEnabled: boolean } }).user;
    assert(yo.mustChangePassword === true, 'el servidor le dice que tiene que cambiarla');

    const me = await sesionAna.call('/v1/auth/me');
    assert(me.status === 200, 'puede ver quién es');

    const panel = await sesionAna.call('/v1/admin/waha');
    assert(code(panel.body) === 'PASSWORD_CHANGE_REQUIRED', 'pero no el panel', panel.body);

    const altaAntes = await sesionAna.call('/v1/auth/totp/setup', { method: 'POST' });
    assert(
      code(altaAntes.body) === 'PASSWORD_CHANGE_REQUIRED',
      'ni dar de alta el segundo factor antes de cambiarla',
      altaAntes.body,
    );

    const PROPIA = 'la cometa roja sobre el lago';
    const cambio = await sesionAna.call('/v1/auth/password', {
      method: 'POST',
      body: { currentPassword: ana.password, newPassword: PROPIA },
    });
    assert(cambio.status === 204, 'la cambia por una suya', cambio.body);

    /* ------------------------------------------------------------------ */
    console.log('\n3. Después, el segundo factor; y solo después, el panel');
    const meTras = (await sesionAna.call('/v1/auth/me')).body as { user: { mustChangePassword: boolean } };
    assert(meTras.user.mustChangePassword === false, 'ya no le pide cambiarla');

    const panelSin2fa = await sesionAna.call('/v1/admin/waha');
    assert(code(panelSin2fa.body) === 'TOTP_SETUP_REQUIRED', 'ahora le pide el segundo factor', panelSin2fa.body);

    const setup = await sesionAna.call('/v1/auth/totp/setup', { method: 'POST' });
    assert(setup.status < 400, 'puede darlo de alta');
    const activar = await sesionAna.call('/v1/auth/totp/activate', {
      method: 'POST',
      body: { code: totp(base32Decode((setup.body as { secret: string }).secret)) },
    });
    assert(activar.status < 400, 'y activarlo', activar.body);

    const panelCon2fa = await sesionAna.call('/v1/admin/waha');
    assert(panelCon2fa.status === 200, 'y ya entra al panel', panelCon2fa.body);

    /* ------------------------------------------------------------------ */
    console.log('\n4. La temporal no sirve dos veces, y caduca');
    const otraVez = await crearSesion().call('/v1/auth/session', {
      method: 'POST',
      body: { email: ana.login, password: ana.password },
    });
    assert(otraVez.status === 401 && code(otraVez.body) === 'UNAUTHORIZED', 'la temporal ya no abre');

    const conPropia = await crearSesion().call('/v1/auth/session', {
      method: 'POST',
      body: { email: ana.login, password: PROPIA },
    });
    assert(code(conPropia.body) === 'TOTP_REQUIRED', 'la suya sí, y pide el código');

    const b = (await admin.call('/v1/admin/users', {
      method: 'POST',
      body: { name: 'Beto Prueba', login: `${PREFIJO}-beto@taxturistico.local` },
    })).body as Creado;
    assert(Boolean(b.password), 'también se puede crear con un correo');
    await db
      .update(schema.users)
      .set({ tempPasswordExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.users.email, b.login));

    const caducada = await crearSesion().call('/v1/auth/session', {
      method: 'POST',
      body: { email: b.login, password: b.password },
    });
    assert(code(caducada.body) === 'TEMP_PASSWORD_EXPIRED', 'pasadas las 72 h, dice que caducó', caducada.body);

    const mala = await crearSesion().call('/v1/auth/session', {
      method: 'POST',
      body: { email: b.login, password: 'no-es-la-contraseña' },
    });
    // A quien no sabe la contraseña no se le dice que hay una temporal.
    assert(code(mala.body) === 'UNAUTHORIZED', 'pero solo a quien sabe la contraseña');

    const lista = (await admin.call('/v1/admin/users')).body as {
      users: { email: string; temporaryPassword: { expired: boolean } | null }[];
      cupo: { active: number; max: number };
    };
    const beto = lista.users.find((u) => u.email === b.login);
    assert(beto?.temporaryPassword?.expired === true, 'y el panel lo ve como caducada');

    const reinicio = await admin.call(`/v1/admin/users/${b.id}/password`, { method: 'POST' });
    const nueva = (reinicio.body as { password: string }).password;
    const conNueva = await crearSesion().call('/v1/auth/session', {
      method: 'POST',
      body: { email: b.login, password: nueva },
    });
    assert(
      (conNueva.body as { user?: { mustChangePassword: boolean } }).user?.mustChangePassword === true,
      'reiniciarla da otra temporal, que también hay que cambiar',
      conNueva.body,
    );

    /* ------------------------------------------------------------------ */
    console.log(`\n5. No caben más de ${MAXIMO} operadores activos`);
    const creados: Creado[] = [ana, b];
    for (let i = creados.length; i < MAXIMO; i++) {
      const extra = await admin.call('/v1/admin/users', {
        method: 'POST',
        body: { name: `Operador ${i}`, login: `${PREFIJO}.op${i}` },
      });
      assert(extra.status === 201, `operador ${i + 1} de ${MAXIMO}`, extra.body);
      creados.push(extra.body as Creado);
    }

    const sobra = await admin.call('/v1/admin/users', {
      method: 'POST',
      body: { name: 'Uno De Más', login: `${PREFIJO}.sobra` },
    });
    assert(code(sobra.body) === 'OPERATOR_LIMIT_REACHED', 'el siguiente se rechaza', sobra.body);

    const cuenta = ((await admin.call('/v1/admin/users')).body as typeof lista).cupo;
    assert(cuenta.active === MAXIMO && cuenta.max === MAXIMO, `la lista dice ${cuenta.active} de ${cuenta.max}`);

    /* ------------------------------------------------------------------ */
    console.log('\n6. Desactivar libera el cupo y cierra la puerta');
    const desactivar = await admin.call(`/v1/admin/users/${ana.id}`, {
      method: 'PATCH',
      body: { active: false },
    });
    assert(desactivar.status === 204, 'desactiva a Ana', desactivar.body);
    assert((await sesionAna.call('/v1/auth/me')).status === 401, 'su sesión abierta muere al momento');

    const fuera = await crearSesion().call('/v1/auth/session', {
      method: 'POST',
      body: { email: ana.login, password: PROPIA },
    });
    assert(fuera.status === 401 && code(fuera.body) === 'UNAUTHORIZED', 'y ya no puede entrar');

    const cabe = await admin.call('/v1/admin/users', {
      method: 'POST',
      body: { name: 'Ahora Sí', login: `${PREFIJO}.sobra` },
    });
    assert(cabe.status === 201, 'ahora sí cabe otro', cabe.body);

    const volver = await admin.call(`/v1/admin/users/${ana.id}`, {
      method: 'PATCH',
      body: { active: true },
    });
    assert(code(volver.body) === 'OPERATOR_LIMIT_REACHED', 'y reactivarla con el cupo lleno no se puede');

    const admins = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, ADMIN));
    const aSiMismo = await admin.call(`/v1/admin/users/${admins[0]!.id}`, {
      method: 'PATCH',
      body: { active: false },
    });
    assert(aSiMismo.status === 403, 'un administrador no se desactiva a sí mismo');

    /* ------------------------------------------------------------------ */
    console.log('\n7. Un operador no puede crear a nadie');
    const sesionB = crearSesion();
    await sesionB.call('/v1/auth/session', { method: 'POST', body: { email: b.login, password: nueva } });
    await sesionB.call('/v1/auth/password', {
      method: 'POST',
      body: { currentPassword: nueva, newPassword: 'el tren de las seis y media' },
    });
    const setupB = await sesionB.call('/v1/auth/totp/setup', { method: 'POST' });
    await sesionB.call('/v1/auth/totp/activate', {
      method: 'POST',
      body: { code: totp(base32Decode((setupB.body as { secret: string }).secret)) },
    });
    const intento = await sesionB.call('/v1/admin/users', {
      method: 'POST',
      body: { name: 'Colado Prueba', login: `${PREFIJO}.colado` },
    });
    assert(intento.status === 403, 'responde 403', intento.body);

    /* ------------------------------------------------------------------ */
    console.log('\n8. Todo queda en la bitácora');
    const entradas = await db
      .select({ action: schema.auditLog.action, actorName: schema.auditLog.actorName })
      .from(schema.auditLog)
      .where(like(schema.auditLog.entityId, `${PREFIJO}%`));
    const acciones = new Set(entradas.map((e) => e.action));
    for (const accion of [
      'Creó un usuario',
      'Desactivó un usuario',
      'Cambió su contraseña temporal por una propia',
    ]) {
      assert(acciones.has(accion), `«${accion}»`);
    }
    assert(entradas.some((e) => e.actorName === 'Admin Alta'), 'con el nombre de quien lo hizo');

    console.log('\nTodo correcto.\n');
  } finally {
    await limpiar();
    if (apartados.length > 0) {
      await db.update(schema.users).set({ active: true }).where(inArray(schema.users.id, apartados));
    }
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('\nLa prueba falló:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
