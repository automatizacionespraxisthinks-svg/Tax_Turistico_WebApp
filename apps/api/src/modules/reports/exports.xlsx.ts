import ExcelJS from 'exceljs';
import {
  formatoFechaHora,
  paraExcel,
  resumir,
  type FilaCarrera,
  type Periodo,
} from './exports.data';

const PESOS = '"$" #,##0';
const FECHA_HORA = 'dd/mm/yyyy hh:mm';

const VEHICULO: Record<string, string> = { sedan: 'Sedán', camioneta: 'Camioneta', van: 'Van' };

interface Columna {
  titulo: string;
  ancho: number;
  formato?: string;
}

/** Una hoja con cabecera fija, filtros y anchos pensados para leerse sin tocar nada. */
function hoja(libro: ExcelJS.Workbook, nombre: string, columnas: Columna[], filas: unknown[][]): ExcelJS.Worksheet {
  const ws = libro.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columnas.map((c) => ({ header: c.titulo, width: c.ancho, style: c.formato ? { numFmt: c.formato } : {} }));

  const cabecera = ws.getRow(1);
  cabecera.font = { bold: true, color: { argb: 'FF1F2328' } };
  cabecera.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF0F3' } };
  cabecera.alignment = { vertical: 'middle' };
  cabecera.height = 20;

  ws.addRows(filas);
  if (filas.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnas.length } };
  }
  return ws;
}

function hojaCarreras(libro: ExcelJS.Workbook, filas: FilaCarrera[]): void {
  hoja(
    libro,
    'Carreras',
    [
      { titulo: 'Código', ancho: 12 },
      { titulo: 'Creada', ancho: 17, formato: FECHA_HORA },
      { titulo: 'Estado', ancho: 16 },
      { titulo: 'Zona', ancho: 18 },
      { titulo: 'Recogida', ancho: 36 },
      { titulo: 'Referencia', ancho: 24 },
      { titulo: 'Destino', ancho: 30 },
      { titulo: 'Pasajeros', ancho: 10 },
      { titulo: 'Vehículo', ancho: 11 },
      { titulo: 'Cliente', ancho: 22 },
      { titulo: 'Teléfono', ancho: 16 },
      { titulo: 'Cód. conductor', ancho: 14 },
      { titulo: 'Conductor', ancho: 22 },
      { titulo: 'Placa', ancho: 10 },
      { titulo: 'Tarifa estimada', ancho: 15, formato: PESOS },
      { titulo: 'Tarifa final', ancho: 13, formato: PESOS },
      { titulo: 'Distancia (km)', ancho: 14, formato: '0.0' },
      { titulo: 'Asignación (s)', ancho: 14 },
      { titulo: 'Línea', ancho: 12 },
      { titulo: 'Lanzamientos', ancho: 13 },
      { titulo: 'Con operador', ancho: 13 },
      { titulo: 'Motivo de cancelación', ancho: 30 },
      { titulo: 'Finalizada', ancho: 17, formato: FECHA_HORA },
    ],
    filas.map((f) => [
      f.codigo,
      paraExcel(f.creada),
      f.estadoTexto,
      f.zona ?? '',
      f.recogida,
      f.referencia ?? '',
      f.destino ?? '',
      f.pasajeros,
      VEHICULO[f.vehiculo] ?? f.vehiculo,
      f.cliente ?? '',
      f.telefono,
      f.conductorCodigo ?? '',
      f.conductor ?? '',
      f.placa ?? '',
      f.tarifaEstimada,
      f.tarifaFinal,
      f.distanciaKm,
      f.asignacionSegundos,
      f.linea ?? '',
      f.intentos,
      f.intervenida ? 'Sí' : 'No',
      f.motivoCancelacion ?? '',
      f.finalizada ? paraExcel(f.finalizada) : null,
    ]),
  );
}

/** Portada: de qué es el archivo, quién lo pidió y las cifras del periodo. */
function hojaResumen(libro: ExcelJS.Workbook, periodo: Periodo, pedidoPor: string, titulo: string): void {
  const r = resumir(periodo.filas);
  const ws = libro.addWorksheet('Resumen');
  ws.columns = [{ width: 34 }, { width: 22 }];

  ws.addRow([titulo]).font = { bold: true, size: 14 };
  ws.addRow([`Del ${formatoFechaHora(periodo.desde)} al ${formatoFechaHora(periodo.hasta)} (hora de Paipa)`]);
  ws.addRow([`Generado por ${pedidoPor}`]).font = { color: { argb: 'FF6B7280' } };
  if (periodo.recortado) {
    ws.addRow([`Recortado a las ${periodo.filas.length} carreras más recientes.`]).font = { color: { argb: 'FFB45309' } };
  }
  ws.addRow([]);

  const cifras: [string, number | string | null, string?][] = [
    ['Carreras creadas', r.creadas],
    ['Finalizadas', r.finalizadas],
    ['Canceladas', r.canceladas],
    ['Sin asignar', r.sinAsignar],
    ['En curso al generar', r.enCurso],
    ['Facturado (finalizadas)', r.facturado, PESOS],
    ['Tarifa media', r.tarifaMedia, PESOS],
    ['Kilómetros recorridos', r.kmRecorridos, '0.0'],
    ['Asignación, mediana (s)', r.asignacionP50],
    ['Asignación, p95 (s)', r.asignacionP95],
    ['Sin intervención humana', r.sinIntervencion, '0%'],
  ];
  for (const [nombre, valor, formato] of cifras) {
    const fila = ws.addRow([nombre, valor ?? '—']);
    fila.getCell(1).font = { color: { argb: 'FF4B5563' } };
    if (formato && typeof valor === 'number') fila.getCell(2).numFmt = formato;
    fila.getCell(2).alignment = { horizontal: 'right' };
  }
}

function hojasDeResumen(libro: ExcelJS.Workbook, periodo: Periodo): void {
  const r = resumir(periodo.filas);

  hoja(
    libro,
    'Por conductor',
    [
      { titulo: 'Código', ancho: 10 },
      { titulo: 'Conductor', ancho: 26 },
      { titulo: 'Finalizadas', ancho: 12 },
      { titulo: 'Facturado', ancho: 15, formato: PESOS },
      { titulo: 'Km recorridos', ancho: 14, formato: '0.0' },
    ],
    r.porConductor.map((c) => [c.codigo, c.nombre, c.finalizadas, c.facturado, Math.round(c.km * 10) / 10]),
  );

  hoja(
    libro,
    'Por zona',
    [
      { titulo: 'Zona', ancho: 22 },
      { titulo: 'Tipo', ancho: 10 },
      { titulo: 'Carreras', ancho: 10 },
      { titulo: 'Finalizadas', ancho: 12 },
      { titulo: 'Canceladas', ancho: 12 },
      { titulo: 'Facturado', ancho: 15, formato: PESOS },
    ],
    r.porZona.map((z) => [z.zona, z.tipo, z.carreras, z.finalizadas, z.canceladas, z.facturado]),
  );

  hoja(
    libro,
    'Por día',
    [
      { titulo: 'Día', ancho: 12 },
      { titulo: 'Carreras', ancho: 10 },
      { titulo: 'Finalizadas', ancho: 12 },
      { titulo: 'Asignación p50 (s)', ancho: 18 },
      { titulo: 'Asignación p95 (s)', ancho: 18 },
    ],
    r.porDia.map((d) => [d.dia, d.carreras, d.finalizadas, d.p50, d.p95]),
  );

  hoja(
    libro,
    'Por hora',
    [
      { titulo: 'Hora', ancho: 8 },
      { titulo: 'Carreras', ancho: 10 },
    ],
    r.porHora.map((h) => [`${h.hora}:00`, h.carreras]),
  );
}

/**
 * El Excel de una exportación.
 *
 * - `resumen`: portada con las cifras, todas las carreras del periodo y las
 *   tablas por conductor (la liquidación), por zona, por día y por hora.
 * - `carreras`: portada y las carreras con los filtros de la vista.
 */
export async function generarExcel(
  periodo: Periodo,
  opciones: { tipo: 'resumen' | 'carreras'; titulo: string; pedidoPor: string },
): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Tax Turístico';
  libro.created = new Date();

  hojaResumen(libro, periodo, opciones.pedidoPor, opciones.titulo);
  hojaCarreras(libro, periodo.filas);
  if (opciones.tipo === 'resumen') hojasDeResumen(libro, periodo);

  return Buffer.from(await libro.xlsx.writeBuffer());
}
