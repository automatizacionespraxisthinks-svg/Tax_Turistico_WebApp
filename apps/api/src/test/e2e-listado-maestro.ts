import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { listadoDePrueba, type MovilDePrueba } from './listado-de-prueba';

/**
 * Prueba de extremo a extremo de la carga del listado maestro.
 *
 * Corre el script compilado tal como se correría en el servidor, con un Excel
 * de mentira: simula, aplica, entra a la PWA con un PIN recién repartido,
 * repite la carga sin duplicar nada y vuelve a cargar con cambios. Necesita
 * la API en marcha (para el acceso) y la base local. Borra lo suyo al final.
 *
 *   node -r dotenv/config dist/test/e2e-listado-maestro.js
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000';
const SCRIPT = join(__dirname, '..', 'cli', 'importar-listado-maestro.js');
const INTERNOS = ['901', '902', '903', '904'];

let fallos = 0;
function assert(condicion: boolean, mensaje: string, contexto?: unknown): void {
  if (condicion) {
    console.log(`  ✓ ${mensaje}`);
    return;
  }
  fallos += 1;
  console.error(`  ✗ ${mensaje}`);
  if (contexto !== undefined) console.error('   ', JSON.stringify(contexto).slice(0, 500));
}

function correr(archivo: string, ...opciones: string[]): string {
  return execFileSync(process.execPath, ['-r', 'dotenv/config', SCRIPT, archivo, ...opciones], {
    encoding: 'utf8',
    env: process.env,
  });
}

const base: MovilDePrueba[] = [
  {
    interno: 901,
    placa: 'ZZA901',
    propietario: ['Propietaria De Prueba', 9100000001],
    conductor: ['PRUEBA listado uno', 9100000011, 3009990001],
    relevador: ['Prueba Listado Relevo', 9100000099, '300 9990099'],
  },
  {
    interno: '902',
    placa: 'ZZA902',
    conductor: ['Prueba Listado Dos', 9100000012],
    relevador: ['Prueba Listado Relevo', 9100000099, 3009990099],
  },
  { interno: '903', placa: 'ZZA903', estado: 'INACTIVO', conductor: ['Prueba Listado Tres', 9100000013, 3009990003, 'CONDUCIR CON LENTES'] },
  { interno: '904', placa: 'ZZA904', capacidad: '4+C' },
];

async function main() {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const carpeta = mkdtempSync(join(tmpdir(), 'listado-'));
  const archivo = join(carpeta, 'listado.xlsx');
  const pines = join(carpeta, 'pines.csv');
  const conductoresDePrueba = () =>
    db.query(
      `select d.id, d.code, d.name, d.phone, d.document_encrypted, d.document_hash, d.license_expires_on::text as licencia,
              d.license_restriction as restriccion
         from drivers d where d.name like 'Prueba Listado%' order by d.name`,
    );
  const movilesDePrueba = () =>
    db.query(
      `select internal_number, plate, active, capacity, owner_name, owner_document_encrypted, registered_on::text as matricula
         from vehicles where internal_number = any($1) order by internal_number`,
      [INTERNOS],
    );

  try {
    writeFileSync(archivo, await listadoDePrueba(base));

    console.log('\n1. La simulación no guarda nada');
    const simulada = correr(archivo);
    assert(simulada.includes('SIMULACIÓN'), 'avisa que es una simulación');
    assert(simulada.includes('nuevos        4') && simulada.includes('Vínculos móvil–conductor: 5 nuevos'), 'y cuenta 4 móviles, 4 personas y 5 vínculos', simulada);
    assert((await movilesDePrueba()).rows.length === 0 && (await conductoresDePrueba()).rows.length === 0, 'la base sigue igual');

    console.log('\n2. Con --aplicar');
    const aplicada = correr(archivo, '--aplicar', `--pines=${pines}`);
    assert(aplicada.includes('NO SE VUELVEN A MOSTRAR'), 'muestra los PIN de los nuevos');
    const csv = readFileSync(pines, 'utf8').replace(/^﻿/, '').trim().split('\n');
    assert(csv.length === 5 && csv[0] === 'Código;Nombre;Móvil;PIN', `el CSV trae los 4 conductores nuevos (${csv.length - 1})`, csv[0]);
    const filas = csv.slice(1).map((l) => l.split(';'));
    assert(filas.every((f) => /^\d+$/.test(f[0]!) && /^\d{4}$/.test(f[3]!)), 'cada uno con código numérico y PIN de 4 dígitos');
    const relevo = filas.find((f) => f[1] === 'Prueba Listado Relevo');
    assert(relevo?.[2] === '901 (relevador) / 902 (relevador)', `el relevador compartido sale en sus dos móviles (${relevo?.[2]})`);

    const moviles = (await movilesDePrueba()).rows;
    assert(moviles.length === 4, `quedan los 4 móviles (${moviles.length})`);
    assert(moviles.find((m) => m.internal_number === '903')?.active === false, 'el INACTIVO queda inactivo');
    assert(moviles.find((m) => m.internal_number === '904')?.capacity === 4, 'la capacidad «4+C» queda en 4');
    const propio = moviles.find((m) => m.internal_number === '901');
    assert(propio?.owner_name === 'Propietaria de Prueba' && !String(propio.owner_document_encrypted).includes('9100000001'), 'el propietario con su cédula cifrada');

    const personas = (await conductoresDePrueba()).rows;
    assert(personas.length === 4, `quedan 4 personas, no 5: el relevador es uno solo (${personas.length})`);
    assert(personas.every((p) => p.document_hash && !String(p.document_encrypted).includes('91000000')), 'con la cédula cifrada y su huella');
    assert(personas.find((p) => p.name === 'Prueba Listado Dos')?.phone === null, 'el que no tiene celular queda sin celular');
    assert(personas.find((p) => p.name === 'Prueba Listado Uno')?.phone === '+573009990001', 'los demás en E.164');
    const tres = personas.find((p) => p.name === 'Prueba Listado Tres');
    assert(tres?.licencia === '2028-06-01' && tres?.restriccion === 'Conducir con lentes', 'con licencia y restricción');
    const { rows: vinculos } = await db.query(
      `select v.internal_number, d.name, vd.role from vehicle_drivers vd join vehicles v on v.id = vd.vehicle_id
         join drivers d on d.id = vd.driver_id where v.internal_number = any($1) order by 1, 3`,
      [INTERNOS],
    );
    assert(vinculos.length === 5, `y 5 vínculos (${vinculos.length})`, vinculos);

    console.log('\n3. Un conductor nuevo entra a la PWA con su código, la placa y el PIN');
    const uno = filas.find((f) => f[1] === 'Prueba Listado Uno')!;
    const acceso = await fetch(`${BASE}/v1/auth/driver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: uno[0], plate: 'ZZA901', pin: uno[3], device: 'prueba del listado', install: 'e2e-listado-maestro' }),
    });
    assert(acceso.ok, `entra (HTTP ${acceso.status})`);

    console.log('\n4. Repetir la carga no duplica nada');
    const repetida = correr(archivo, '--aplicar');
    assert(repetida.includes('nuevos        0') && !repetida.includes('NO SE VUELVEN A MOSTRAR'), 'ningún móvil ni conductor nuevo, ningún PIN', repetida);
    assert(repetida.includes('sin cambios   4'), 'todos sin cambios');
    const despues = (await conductoresDePrueba()).rows;
    assert(despues.length === 4 && despues.find((p) => p.name === 'Prueba Listado Uno')?.code === uno[0], 'y cada uno conserva su código');

    console.log('\n5. El Excel del mes siguiente, con cambios');
    const cambiado = structuredClone(base);
    cambiado[1]!.conductor = ['Prueba Listado Dos', 9100000012, 3009990002];
    delete cambiado[1]!.relevador;
    cambiado[2]!.estado = 'ACTIVO';
    writeFileSync(archivo, await listadoDePrueba(cambiado));
    const mes = correr(archivo, '--aplicar');
    assert(/Prueba Listado Dos: celular/.test(mes), 'el que no tenía celular ahora lo tiene', mes);
    assert(mes.includes('1 quitados'), 'el relevador que salió del 902 pierde ese vínculo');
    assert((await movilesDePrueba()).rows.find((m) => m.internal_number === '903')?.active === true, 'el 903 vuelve a estar activo');
  } finally {
    const ids = (await conductoresDePrueba()).rows.map((p) => p.id);
    if (ids.length) {
      await db.query('delete from driver_devices where driver_id = any($1::uuid[])', [ids]);
      await db.query('delete from drivers where id = any($1::uuid[])', [ids]);
    }
    await db.query('delete from vehicles where internal_number = any($1)', [INTERNOS]);
    await db.end();
    rmSync(carpeta, { recursive: true, force: true });
  }

  console.log(fallos ? `\n${fallos} comprobaciones fallaron.` : '\nTodo correcto.');
  process.exit(fallos ? 1 : 0);
}

void main();
