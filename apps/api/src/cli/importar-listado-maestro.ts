import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DbModule } from '../db/db.module';
import { AuditService } from '../modules/audit/audit.service';
import { ImportacionService, type InformeDeImportacion } from '../modules/fleet/importacion.service';
import { leerListadoMaestro } from '../modules/fleet/listado-maestro';

/**
 * Carga masiva del listado maestro de la empresa (el Excel «Listado Maestro»):
 * crea o actualiza los móviles, sus conductores y relevadores.
 *
 * Por defecto SIMULA: lee el Excel, hace todo dentro de una transacción y la
 * deshace, e informa lo que haría. Con `--aplicar` lo guarda y muestra el PIN
 * de cada conductor nuevo, una sola vez. Se puede repetir con el Excel de cada
 * mes: lo que ya está se actualiza, y nadie pierde su código ni su PIN.
 *
 *   node dist/cli/importar-listado-maestro.js <archivo.xlsx>            # simula
 *   node dist/cli/importar-listado-maestro.js <archivo.xlsx> --aplicar  # carga
 *   cat listado.xlsx | node dist/cli/importar-listado-maestro.js - --aplicar
 *
 * Opciones:
 *   --aplicar              guarda los cambios (sin esto, solo simula)
 *   --pines=<ruta.csv>     además de mostrarlos, guarda los PIN nuevos en un CSV
 *   --desde=<número>       primer código para conductores nuevos (101)
 *   --desactivar-ausentes  desactiva conductores y móviles que no están en el Excel
 */

/* Igual que `crear-conductor`: la base y la bitácora, sin levantar la API entera. */
@Module({ imports: [DbModule], providers: [AuditService, ImportacionService] })
class CliModule {}

const USO =
  'Uso: importar-listado-maestro.js <archivo.xlsx | -> [--aplicar] [--pines=ruta.csv] [--desde=101] [--desactivar-ausentes]';

async function leerEntrada(ruta: string): Promise<Buffer> {
  if (ruta !== '-') return readFileSync(ruta);
  const partes: Buffer[] = [];
  for await (const parte of process.stdin) partes.push(parte as Buffer);
  return Buffer.concat(partes);
}

const lista = (cosas: string[], max = 12) =>
  cosas.length <= max ? cosas.join(', ') : `${cosas.slice(0, max).join(', ')} y ${cosas.length - max} más`;

function imprimir(informe: InformeDeImportacion): void {
  const { moviles, conductores, vinculos, ausentes } = informe;
  console.log('\nMóviles');
  console.log(`  nuevos        ${moviles.nuevos.length}${moviles.nuevos.length ? `  (${lista(moviles.nuevos)})` : ''}`);
  console.log(`  actualizados  ${moviles.actualizados.length}`);
  for (const m of moviles.actualizados.slice(0, 20)) console.log(`    ${m.interno}: ${m.campos.join(', ')}`);
  console.log(`  sin cambios   ${moviles.sinCambios}`);
  if (moviles.inactivos.length) console.log(`  inactivos     ${lista(moviles.inactivos)} (no se puede abrir turno con ellos)`);

  console.log('\nConductores y relevadores');
  console.log(`  nuevos        ${conductores.nuevos.length}`);
  console.log(`  actualizados  ${conductores.actualizados.length}`);
  for (const c of conductores.actualizados.slice(0, 20)) console.log(`    ${c.codigo} ${c.nombre}: ${c.campos.join(', ')}`);
  console.log(`  sin cambios   ${conductores.sinCambios}`);
  const sinCelular = conductores.nuevos.filter((c) => c.sinCelular);
  if (sinCelular.length) {
    console.log(`  sin celular   ${sinCelular.length}: ${lista(sinCelular.map((c) => `${c.codigo} ${c.nombre}`), 8)}`);
  }
  if (conductores.reconocidosPorCelular.length) {
    console.log(`  reconocidos por su celular (se les guardó la cédula): ${lista(conductores.reconocidosPorCelular.map((c) => c.codigo))}`);
  }
  if (conductores.desactivadosEnElPanel.length) {
    console.log(
      `  desactivados en el panel aunque están en el Excel (siguen desactivados): ${lista(conductores.desactivadosEnElPanel.map((c) => `${c.codigo} ${c.nombre}`), 8)}`,
    );
  }

  console.log(`\nVínculos móvil–conductor: ${vinculos.nuevos} nuevos, ${vinculos.cambiados} con otro rol, ${vinculos.quitados} quitados`);

  if (ausentes.conductores.length || ausentes.moviles.length) {
    console.log(`\nEn la base pero no en el Excel${ausentes.desactivados ? ' (desactivados)' : ' (no se tocaron; --desactivar-ausentes los desactiva)'}:`);
    if (ausentes.conductores.length) console.log(`  conductores: ${lista(ausentes.conductores.map((c) => `${c.codigo} ${c.nombre}`), 10)}`);
    if (ausentes.moviles.length) console.log(`  móviles: ${lista(ausentes.moviles, 10)}`);
  }
}

/** CSV para Excel en español: punto y coma, y BOM para que abra con tildes. */
function csvDePines(informe: InformeDeImportacion): string {
  const campo = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const filas = informe.conductores.nuevos.map((c) =>
    [c.codigo, c.nombre, c.moviles.join(' / '), c.pin ?? ''].map(campo).join(';'),
  );
  return `﻿Código;Nombre;Móvil;PIN\n${filas.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ruta = args.find((a) => !a.startsWith('--'));
  const opcion = (nombre: string) => args.find((a) => a.startsWith(`--${nombre}=`))?.split('=').slice(1).join('=');
  const aplicar = args.includes('--aplicar');
  const desactivarAusentes = args.includes('--desactivar-ausentes');
  const desde = Number(opcion('desde') ?? 101);
  const rutaPines = opcion('pines');
  const conocidas = ['--aplicar', '--desactivar-ausentes', '--pines=', '--desde='];
  const desconocidas = args.filter((a) => a.startsWith('--') && !conocidas.some((c) => a === c || (c.endsWith('=') && a.startsWith(c))));

  if (!ruta || desconocidas.length || !Number.isInteger(desde) || desde < 1) {
    console.error(desconocidas.length ? `Opción desconocida: ${desconocidas.join(', ')}\n${USO}` : USO);
    process.exitCode = 1;
    return;
  }

  const listado = await leerListadoMaestro(await leerEntrada(ruta));
  const personas = new Set(listado.moviles.flatMap((m) => [m.conductor, ...m.relevadores].filter(Boolean).map((p) => p!.cedula)));
  console.log(`Hoja «${listado.hoja}»: ${listado.moviles.length} móviles y ${personas.size} conductores y relevadores.`);
  if (listado.avisos.length) {
    console.log(`\nAvisos del Excel (${listado.avisos.length}):`);
    for (const aviso of listado.avisos) console.log(`  · ${aviso}`);
  }
  if (listado.errores.length) {
    console.error(`\nNo se puede cargar:`);
    for (const error of listado.errores) console.error(`  ✗ ${error}`);
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error'] });
  try {
    const informe = await app.get(ImportacionService).importar(listado, {
      aplicar,
      desactivarAusentes,
      codigoInicial: desde,
      archivo: ruta === '-' ? 'entrada estándar' : basename(ruta),
    });

    imprimir(informe);

    if (!aplicar) {
      console.log('\nSIMULACIÓN: no se guardó nada. Para cargarlo de verdad, repite el comando con --aplicar.');
      return;
    }

    console.log('\nListo: los cambios quedaron guardados y en la bitácora de auditoría.');
    if (informe.conductores.nuevos.length) {
      console.log('\nPIN de los conductores nuevos. NO SE VUELVEN A MOSTRAR: guárdalos ahora.\n');
      const ancho = Math.max(...informe.conductores.nuevos.map((c) => c.nombre.length), 6);
      console.log(`  ${'Código'.padEnd(7)} ${'Nombre'.padEnd(ancho)}  ${'Móvil'.padEnd(18)} PIN`);
      for (const c of informe.conductores.nuevos) {
        console.log(`  ${c.codigo.padEnd(7)} ${c.nombre.padEnd(ancho)}  ${c.moviles.join(' / ').padEnd(18)} ${c.pin}`);
      }
      if (rutaPines) {
        writeFileSync(rutaPines, csvDePines(informe), { encoding: 'utf8', mode: 0o600 });
        console.log(`\nTambién quedaron en ${rutaPines}. Entrégalos y borra el archivo: con código, placa y PIN se entra a la PWA.`);
      }
      console.log('\nCada conductor entra con su código, la placa de su móvil y su PIN. Si alguno pierde el PIN, se le genera otro desde Flota.');
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('\nFalló la carga (no se guardó nada):');
  console.error(error instanceof Error && !error.stack?.includes('node_modules') ? error.message : error);
  process.exitCode = 1;
});
