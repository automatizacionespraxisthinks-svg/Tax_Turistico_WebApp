import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import ExcelJS from 'exceljs';
import * as schema from '../db/schema';
import { hashSecret } from '../common/crypto';
import { base32Decode, totp } from '../common/totp';

/**
 * Exportaciones a Excel y PDF (§4.1).
 *
 * Antes los botones solo enseñaban «en cola» y no se generaba nada. Aquí se
 * pide cada exportación como lo hace el panel, se espera a que la cola la
 * genere, se descarga y se abre el archivo para comprobar que cuenta lo
 * mismo que la base:
 *
 *  1. el resumen en Excel tiene sus hojas y una fila por carrera del periodo;
 *  2. el resumen en PDF es un PDF de verdad;
 *  3. la exportación de Carreras respeta el filtro (solo canceladas);
 *  4. la lista la enseña lista para descargar, y un PDF de carreras sueltas
 *     se rechaza en vez de generar algo que nadie pidió.
 *
 *   pnpm --filter @tax/api exec tsx src/test/e2e-exportaciones.ts [carpeta-para-guardar]
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const CLAVE = 'clave-de-prueba-suficientemente-larga';
const USUARIO = 'prueba-export@taxturistico.local';
const GUARDAR_EN = process.argv[2];

function assert(condition: boolean, message: string, context?: unknown): void {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    if (context !== undefined) console.error('    ', JSON.stringify(context));
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

let cookie: string | undefined;
async function call(path: string, options: { method?: string; body?: unknown } = {}) {
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
  return response;
}
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

interface Exportacion {
  id: string;
  status: string;
  title: string;
  fileName: string;
  sizeBytes: number | null;
  error: string | null;
}

/** Pide la exportación y espera a que la cola la termine. */
async function exportar(body: Record<string, unknown>): Promise<{ fila: Exportacion; archivo: Buffer }> {
  const pedida = await call('/v1/reports/exports', { method: 'POST', body });
  const fila = (await json(pedida)) as unknown as Exportacion;
  assert(pedida.status === 201 && fila.status === 'pending', `pedida, queda en cola (${fila.title})`, fila);

  let actual = fila;
  for (let i = 0; i < 60 && (actual.status === 'pending' || actual.status === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 500));
    actual = (await json(await call(`/v1/reports/exports/${fila.id}`))) as unknown as Exportacion;
  }
  assert(actual.status === 'ready', `la cola la generó (${actual.sizeBytes} bytes)`, actual);

  const descarga = await call(`/v1/reports/exports/${fila.id}/file`);
  assert(descarga.status === 200, 'se descarga');
  assert(
    (descarga.headers.get('content-disposition') ?? '').includes(actual.fileName),
    `con su nombre: ${actual.fileName}`,
  );
  const archivo = Buffer.from(await descarga.arrayBuffer());
  assert(archivo.length === actual.sizeBytes, 'y pesa lo que dice la lista');
  if (GUARDAR_EN) writeFileSync(join(GUARDAR_EN, actual.fileName), archivo);
  return { fila: actual, archivo };
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  const limpiar = async () => {
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, USUARIO));
    if (!u) return;
    await db.delete(schema.reportExports).where(eq(schema.reportExports.requestedById, u.id));
    await db.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, u.id));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id));
    await db.delete(schema.users).where(eq(schema.users.id, u.id));
  };

  try {
    await limpiar();
    await db.insert(schema.users).values({
      id: uuidv7(),
      email: USUARIO,
      name: 'Prueba Exportaciones',
      passwordHash: await hashSecret(CLAVE),
      role: 'operador',
    });
    await call('/v1/auth/session', { method: 'POST', body: { email: USUARIO, password: CLAVE } });
    const setup = await json(await call('/v1/auth/totp/setup', { method: 'POST' }));
    await call('/v1/auth/totp/activate', {
      method: 'POST',
      body: { code: totp(base32Decode(setup.secret as string)) },
    });

    const [{ total, canceladas }] = (
      await db.execute<{ total: number; canceladas: number }>(sql`
        select count(*)::int as total,
               count(*) filter (where status = 'CANCELLED')::int as canceladas
          from rides where created_at >= now() - interval '30 days'
      `)
    ).rows as [{ total: number; canceladas: number }];
    console.log(`(en la base: ${total} carreras de los últimos 30 días, ${canceladas} canceladas)\n`);

    console.log('1. Resumen en Excel, 30 días');
    const excel = await exportar({ kind: 'resumen', format: 'xlsx', days: 30 });
    assert(excel.archivo.subarray(0, 2).toString() === 'PK', 'es un .xlsx (un zip)');
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(excel.archivo as unknown as ArrayBuffer);
    const hojas = libro.worksheets.map((h) => h.name);
    assert(
      ['Resumen', 'Carreras', 'Por conductor', 'Por zona', 'Por día', 'Por hora'].every((h) => hojas.includes(h)),
      `con sus hojas: ${hojas.join(', ')}`,
    );
    const filas = libro.getWorksheet('Carreras')!.actualRowCount - 1;
    assert(filas === total, `una fila por carrera del periodo (${filas} de ${total})`);
    const porHora = libro.getWorksheet('Por hora')!;
    let sumaHoras = 0;
    porHora.eachRow((fila, n) => {
      if (n > 1) sumaHoras += Number(fila.getCell(2).value);
    });
    assert(sumaHoras === total, `y las horas suman lo mismo (${sumaHoras})`);

    console.log('\n2. Resumen en PDF, 7 días');
    const pdf = await exportar({ kind: 'resumen', format: 'pdf', days: 7 });
    assert(pdf.archivo.subarray(0, 5).toString() === '%PDF-', 'es un PDF');
    assert(pdf.archivo.subarray(-6).toString().includes('%%EOF'), 'y está completo');

    console.log('\n3. Carreras canceladas, desde la vista de Carreras');
    const solo = await exportar({
      kind: 'carreras',
      format: 'xlsx',
      days: 30,
      statuses: ['CANCELLED'],
      filterLabel: 'Canceladas',
    });
    assert(solo.fila.title.startsWith('Carreras canceladas'), `el título lo dice: «${solo.fila.title}»`);
    const libroSolo = new ExcelJS.Workbook();
    await libroSolo.xlsx.load(solo.archivo as unknown as ArrayBuffer);
    const hoja = libroSolo.getWorksheet('Carreras')!;
    const estados = new Set<string>();
    hoja.eachRow((fila, n) => {
      if (n > 1) estados.add(String(fila.getCell(3).value));
    });
    assert(hoja.actualRowCount - 1 === canceladas, `trae las ${canceladas} canceladas`);
    assert(canceladas === 0 || (estados.size === 1 && estados.has('Cancelada')), 'y ninguna otra', [...estados]);

    console.log('\n4. La lista y lo que no se puede pedir');
    const lista = (await (await call('/v1/reports/exports')).json()) as Exportacion[];
    const mias = lista.filter((e) => [excel.fila.id, pdf.fila.id, solo.fila.id].includes(e.id));
    assert(mias.length === 3 && mias.every((e) => e.status === 'ready'), 'las tres salen listas en la lista');
    assert(!JSON.stringify(lista).includes('"content"'), 'sin el contenido: la lista no descarga nada');

    const pdfSuelto = await call('/v1/reports/exports', {
      method: 'POST',
      body: { kind: 'carreras', format: 'pdf', days: 7 },
    });
    assert(pdfSuelto.status === 400, 'un PDF de carreras sueltas se rechaza');

    cookie = undefined;
    const sinSesion = await call(`/v1/reports/exports/${excel.fila.id}/file`);
    assert(sinSesion.status === 401, 'y sin sesión no se descarga nada');

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
