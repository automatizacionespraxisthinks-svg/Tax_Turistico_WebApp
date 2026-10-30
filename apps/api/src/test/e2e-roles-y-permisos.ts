import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, inArray, like, or } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { CLAVES_DE_PERMISO, PERMISOS_DEL_OPERADOR } from '@tax/shared';
import * as schema from '../db/schema';
import { hashSecret } from '../common/crypto';
import { base32Decode, totp } from '../common/totp';

/**
 * Roles y permisos desde el panel (RBAC, §8.1), de extremo a extremo.
 *
 *  1. La migración deja los dos roles de siempre con lo que podían hacer.
 *  2. Cada endpoint pide su permiso, no un rol.
 *  3. Crear un rol pide el código del teléfono, y un código vale una vez.
 *  4. Cambiar el rol de alguien vale desde su siguiente petición.
 *  5. Nadie da lo que no tiene ni gestiona a quien tiene más que él.
 *  6. Lo que no se puede ni siendo administrador.
 *  7. Renombrar no pide código; cambiar permisos, sí.
 *  8. Cinco códigos mal seguidos cierran la sesión.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-roles-y-permisos.ts
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const CLAVE = 'clave-de-prueba-suficientemente-larga';
const ADMIN = 'prueba-roles-admin@taxturistico.local';
const OPERADOR = 'prueba-roles-oper@taxturistico.local';
const PREFIJO = 'prueba-roles';
const ROL = 'supervisor-prueba';

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

type Sesion = ReturnType<typeof crearSesion>;

const code = (p: unknown) => (p as { code?: string } | null)?.code;
const detalle = (p: unknown) => (p as { detail?: string } | null)?.detail ?? '';

interface Yo {
  user: { id: string; role: string; roleName: string; permissions: string[] };
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://tax:tax_dev_password@localhost:55432/tax',
    max: 2,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  const deLaPrueba = or(like(schema.users.email, `${PREFIJO}%`));

  const limpiar = async () => {
    const usuarios = await db.select({ id: schema.users.id }).from(schema.users).where(deLaPrueba);
    const ids = usuarios.map((u) => u.id);
    if (ids.length > 0) {
      await db.delete(schema.userRecoveryCodes).where(inArray(schema.userRecoveryCodes.userId, ids));
      await db.delete(schema.sessions).where(inArray(schema.sessions.userId, ids));
      await db.delete(schema.users).where(inArray(schema.users.id, ids));
    }
    await db.delete(schema.roles).where(like(schema.roles.key, '%-prueba'));
  };

  const entrarCon = async (email: string, rol: string): Promise<{ sesion: Sesion; secreto: string; id: string }> => {
    const id = uuidv7();
    await db.insert(schema.users).values({
      id,
      email,
      name: rol === 'administrador' ? 'Admin Roles' : 'Operador Roles',
      passwordHash: await hashSecret(CLAVE),
      role: rol,
    });
    const sesion = crearSesion();
    await sesion.call('/v1/auth/session', { method: 'POST', body: { email, password: CLAVE } });
    const setup = await sesion.call('/v1/auth/totp/setup', { method: 'POST' });
    const { secret } = setup.body as { secret: string };
    await sesion.call('/v1/auth/totp/activate', { method: 'POST', body: { code: totp(base32Decode(secret)) } });
    return { sesion, secreto: secret, id };
  };

  /*
   * Cada código vale una sola vez y el siguiente tarda 30 segundos en
   * existir. Para no esperar entre pasos, se olvida el último usado: la
   * protección contra reenvío se prueba aparte, en el paso 3.
   */
  const codigoDe = async (email: string, secreto: string) => {
    await db.update(schema.users).set({ totpLastCounter: null }).where(eq(schema.users.email, email));
    return totp(base32Decode(secreto));
  };

  try {
    await limpiar();
    const admin = await entrarCon(ADMIN, 'administrador');
    const oper = await entrarCon(OPERADOR, 'operador');

    /* ------------------------------------------------------------------ */
    console.log('1. Los roles de base, sembrados por la migración');
    const yoOper = (await oper.sesion.call('/v1/auth/me')).body as Yo;
    assert(yoOper.user.roleName === 'Operador', 'el operador ve el nombre de su rol', yoOper.user);
    assert(
      [...yoOper.user.permissions].sort().join() === [...PERMISOS_DEL_OPERADOR].sort().join(),
      'con lo mismo que podía hacer antes',
      yoOper.user.permissions,
    );
    const yoAdmin = (await admin.sesion.call('/v1/auth/me')).body as Yo;
    assert(yoAdmin.user.permissions.length === CLAVES_DE_PERMISO.length, 'el administrador los tiene todos');

    /* ------------------------------------------------------------------ */
    console.log('\n2. Cada endpoint pide su permiso');
    const auditoria = await oper.sesion.call('/v1/audit');
    assert(auditoria.status === 403, 'la bitácora le responde 403 al operador', auditoria.status);
    assert(detalle(auditoria.body).includes('Ver la auditoría'), 'y dice qué permiso falta', auditoria.body);
    assert((await oper.sesion.call('/v1/reports/filters')).status < 400, 'Reportes sí, porque lo tiene');
    assert((await oper.sesion.call('/v1/admin/zones', { method: 'POST', body: {} })).status === 403, 'crear zonas no');
    assert((await oper.sesion.call('/v1/admin/roles')).status === 403, 'ni ver los roles');

    /* ------------------------------------------------------------------ */
    console.log('\n3. Crear un rol pide el código, y un código vale una vez');
    const nuevoRol = {
      name: 'Supervisor prueba',
      description: 'Turno de noche',
      permissions: ['carreras.despachar', 'conductores.suspender', 'usuarios.gestionar', 'reportes.exportar'],
    };
    const sinCodigo = await admin.sesion.call('/v1/admin/roles', { method: 'POST', body: nuevoRol });
    assert(code(sinCodigo.body) === 'SECOND_FACTOR_REQUIRED', 'sin código no', sinCodigo.body);
    assert(sinCodigo.status === 403, 'y no es 401: la sesión sigue buena', sinCodigo.status);

    const bueno = await codigoDe(ADMIN, admin.secreto);
    const malo = bueno === '000000' ? '111111' : '000000';
    const conMalo = await admin.sesion.call('/v1/admin/roles', { method: 'POST', body: { ...nuevoRol, codigo: malo } });
    assert(code(conMalo.body) === 'SECOND_FACTOR_INVALID', 'con uno equivocado tampoco', conMalo.body);

    const creado = await admin.sesion.call('/v1/admin/roles', { method: 'POST', body: { ...nuevoRol, codigo: bueno } });
    assert(creado.status === 201 && (creado.body as { key: string }).key === ROL, `crea «${ROL}»`, creado.body);

    const reusado = await admin.sesion.call('/v1/admin/roles', {
      method: 'POST',
      body: { name: 'Otro prueba', permissions: [], codigo: bueno },
    });
    assert(code(reusado.body) === 'SECOND_FACTOR_INVALID', 'el mismo código otra vez ya no sirve', reusado.body);

    const desconocido = await admin.sesion.call('/v1/admin/roles', {
      method: 'POST',
      body: { name: 'Raro prueba', permissions: ['todo.poder'], codigo: await codigoDe(ADMIN, admin.secreto) },
    });
    assert(code(desconocido.body) === 'VALIDATION_FAILED', 'un permiso que no existe se rechaza', desconocido.body);

    const roles = (await admin.sesion.call('/v1/admin/roles')).body as {
      key: string;
      permissions: string[];
      editable: boolean;
    }[];
    const supervisor = roles.find((r) => r.key === ROL);
    assert(
      Boolean(supervisor?.permissions.includes('reportes.ver')),
      'exportar trae consigo ver reportes',
      supervisor?.permissions,
    );
    assert(roles.find((r) => r.key === 'administrador')?.editable === false, 'el administrador sale como no editable');

    /* ------------------------------------------------------------------ */
    console.log('\n4. Cambiar el rol vale desde la siguiente petición');
    const sinCodigoRol = await admin.sesion.call(`/v1/admin/users/${oper.id}/role`, {
      method: 'PATCH',
      body: { role: ROL },
    });
    assert(code(sinCodigoRol.body) === 'SECOND_FACTOR_REQUIRED', 'sin código no se cambia', sinCodigoRol.body);

    const cambio = await admin.sesion.call(`/v1/admin/users/${oper.id}/role`, {
      method: 'PATCH',
      body: { role: ROL, codigo: await codigoDe(ADMIN, admin.secreto) },
    });
    assert(cambio.status === 204, 'con código, sí', cambio.body);

    const ahora = ((await oper.sesion.call('/v1/auth/me')).body as Yo).user;
    assert(ahora.role === ROL, 'su misma sesión ya tiene el rol nuevo, sin volver a entrar', ahora);
    assert(ahora.permissions.includes('usuarios.gestionar'), 'con sus permisos');
    assert(!ahora.permissions.includes('carreras.cancelar'), 'y sin los que ya no tiene');
    const cancelar = await oper.sesion.call(`/v1/admin/rides/${uuidv7()}/cancel`, {
      method: 'POST',
      body: { reason: 'Prueba' },
    });
    assert(cancelar.status === 403, 'cancelar una carrera ya le responde 403', cancelar.status);

    /* ------------------------------------------------------------------ */
    console.log('\n5. Nadie da lo que no tiene');
    const vista = (await oper.sesion.call('/v1/admin/users')).body as {
      users: { id: string; gestionable: boolean }[];
      roles: { key: string; asignable: boolean }[];
    };
    assert(Array.isArray(vista.users), 'el supervisor ya ve los usuarios');
    assert(vista.users.find((u) => u.id === admin.id)?.gestionable === false, 'pero al administrador no lo puede tocar');
    assert(vista.roles.find((r) => r.key === 'administrador')?.asignable === false, 'ni dar el rol de administrador');
    assert(vista.roles.find((r) => r.key === 'operador')?.asignable === false, 'ni el de operador, que tiene más que él');
    assert(vista.roles.find((r) => r.key === ROL)?.asignable === true, 'el suyo sí');

    const resetAdmin = await oper.sesion.call(`/v1/admin/users/${admin.id}/password`, { method: 'POST' });
    assert(resetAdmin.status === 403, 'no le reinicia la contraseña al administrador', resetAdmin.body);
    const apagarAdmin = await oper.sesion.call(`/v1/admin/users/${admin.id}`, {
      method: 'PATCH',
      body: { active: false },
    });
    assert(apagarAdmin.status === 403, 'ni lo desactiva', apagarAdmin.body);

    const hacerseAdmin = await oper.sesion.call('/v1/admin/users', {
      method: 'POST',
      body: {
        name: 'Colado Prueba',
        login: `${PREFIJO}.colado`,
        role: 'administrador',
        codigo: await codigoDe(OPERADOR, oper.secreto),
      },
    });
    assert(hacerseAdmin.status === 403, 'no crea administradores', hacerseAdmin.body);
    assert((await oper.sesion.call('/v1/admin/roles')).status === 403, 'ni toca los roles: no tiene ese permiso');

    const igual = await oper.sesion.call('/v1/admin/users', {
      method: 'POST',
      body: {
        name: 'Ayudante Prueba',
        login: `${PREFIJO}.ayudante`,
        role: ROL,
        codigo: await codigoDe(OPERADOR, oper.secreto),
      },
    });
    assert(igual.status === 201, 'sí crea a alguien con su mismo rol', igual.body);

    /* ------------------------------------------------------------------ */
    console.log('\n6. Ni siendo administrador');
    const tocarAdmin = await admin.sesion.call('/v1/admin/roles/administrador', {
      method: 'PATCH',
      body: { permissions: [], codigo: await codigoDe(ADMIN, admin.secreto) },
    });
    assert(tocarAdmin.status === 403, 'el rol de administrador no se edita', tocarAdmin.body);
    const propio = await admin.sesion.call(`/v1/admin/users/${admin.id}/role`, {
      method: 'PATCH',
      body: { role: 'operador', codigo: await codigoDe(ADMIN, admin.secreto) },
    });
    assert(propio.status === 403, 'nadie se cambia su propio rol', propio.body);
    const renombrar = await admin.sesion.call('/v1/admin/roles/operador', {
      method: 'PATCH',
      body: { name: 'Despachador' },
    });
    assert(renombrar.status === 403, 'los de base no se renombran', renombrar.body);
    assert(
      (await admin.sesion.call('/v1/admin/roles/operador', { method: 'DELETE' })).status === 403,
      'ni se borran',
    );
    const enUso = await admin.sesion.call(`/v1/admin/roles/${ROL}`, { method: 'DELETE' });
    assert(code(enUso.body) === 'ROLE_IN_USE', 'uno con gente no se borra', enUso.body);

    /* ------------------------------------------------------------------ */
    console.log('\n7. Renombrar no pide código; cambiar permisos, sí');
    const describir = await admin.sesion.call(`/v1/admin/roles/${ROL}`, {
      method: 'PATCH',
      body: { description: 'Turno de noche, fines de semana' },
    });
    assert(describir.status === 204, 'cambiar la descripción pasa sin código', describir.body);
    const masPermisos = [...nuevoRol.permissions, 'carreras.cancelar'];
    const sinCodigoPermisos = await admin.sesion.call(`/v1/admin/roles/${ROL}`, {
      method: 'PATCH',
      body: { permissions: masPermisos },
    });
    assert(code(sinCodigoPermisos.body) === 'SECOND_FACTOR_REQUIRED', 'agregar un permiso sin código no', sinCodigoPermisos.body);
    const conCodigo = await admin.sesion.call(`/v1/admin/roles/${ROL}`, {
      method: 'PATCH',
      body: { permissions: masPermisos, codigo: await codigoDe(ADMIN, admin.secreto) },
    });
    assert(conCodigo.status === 204, 'con código, sí', conCodigo.body);
    const despues = ((await oper.sesion.call('/v1/auth/me')).body as Yo).user;
    assert(despues.permissions.includes('carreras.cancelar'), 'y quien tiene el rol ya puede cancelar');

    /* ------------------------------------------------------------------ */
    console.log('\n8. Cinco códigos mal seguidos cierran la sesión');
    await db.update(schema.users).set({ failedAttempts: 0 }).where(eq(schema.users.email, OPERADOR));
    const buenoOper = await codigoDe(OPERADOR, oper.secreto);
    const maloOper = buenoOper === '000000' ? '111111' : '000000';
    let ultimo = { status: 0, body: null as unknown };
    for (let i = 1; i <= 5; i++) {
      ultimo = await oper.sesion.call('/v1/admin/users', {
        method: 'POST',
        body: { name: 'Intento Prueba', login: `${PREFIJO}.intento${i}`, role: ROL, codigo: maloOper },
      });
      if (i < 5) assert(code(ultimo.body) === 'SECOND_FACTOR_INVALID', `intento ${i}: código incorrecto`);
    }
    assert(ultimo.status === 401, 'al quinto, 401', ultimo.body);
    assert((await oper.sesion.call('/v1/auth/me')).status === 401, 'y su sesión quedó cerrada');
    const [bloqueado] = await db
      .select({ hasta: schema.users.lockedUntil })
      .from(schema.users)
      .where(eq(schema.users.email, OPERADOR));
    assert(Boolean(bloqueado?.hasta && bloqueado.hasta > new Date()), 'y la cuenta, bloqueada 15 minutos');

    /* ------------------------------------------------------------------ */
    console.log('\n9. Todo queda en la bitácora');
    const entradas = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(or(eq(schema.auditLog.entityId, ROL), eq(schema.auditLog.entityId, OPERADOR)));
    const acciones = new Set(entradas.map((e) => e.action));
    for (const accion of ['Creó un rol', 'Cambió el rol de un usuario', 'Cambió los permisos de un rol', 'Editó un rol']) {
      assert(acciones.has(accion), `«${accion}»`);
    }

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
