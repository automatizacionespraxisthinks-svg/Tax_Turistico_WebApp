import ExcelJS from 'exceljs';

/**
 * Un listado maestro de mentira con la misma forma que el de la empresa: dos
 * filas de encabezado, la primera con los grupos (Propietario, Conductor,
 * Relevador 1) y la segunda con las columnas, escritas igual que en el
 * original, tildes raras incluidas. Ninguna persona es real.
 */

export interface MovilDePrueba {
  interno: string | number;
  placa: string;
  estado?: string;
  capacidad?: number | string;
  propietario?: [string, number];
  conductor?: [nombre: string, cedula: number, celular?: number | string, restriccion?: string];
  relevador?: [nombre: string, cedula: number, celular?: number | string];
}

const ENCABEZADO = [
  'N°', 'N° Interno', 'Placa', 'Estado', 'Marca ', 'Modelo', 'Combustible', 'Número del Motor',
  'Número del Chasis', 'Peso Vehicular', 'Capacidad', 'Fecha de Matricula', 'Nombre', 'Cedúla',
  'Nombre2', 'Cedúla [C]', 'Vencimiento Licencia [C]', 'Restricciòn', '# Celular [C]',
  'Nombre [R1]', 'Cedúla [R1]', 'Vencimiento Licencia [R1]', 'Restricciòn2', '# Celular [R1]',
];

export async function listadoDePrueba(moviles: MovilDePrueba[]): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Taxis');
  const grupos = new Array<string>(24).fill('');
  grupos[12] = 'Propietario';
  grupos[14] = 'Conductor';
  grupos[19] = 'Relevador 1';
  hoja.addRow(grupos);
  hoja.addRow(ENCABEZADO);

  moviles.forEach((m, i) => {
    hoja.addRow([
      i + 1,
      m.interno,
      m.placa,
      m.estado ?? 'ACTIVO',
      'KIA',
      2018,
      'Gasolina',
      `MOT${i}`,
      `CHS${i}`,
      i % 2 ? 1450 : null,
      m.capacidad ?? 4,
      new Date(Date.UTC(2018, 0, 15 + i)),
      m.propietario?.[0] ?? null,
      m.propietario?.[1] ?? null,
      m.conductor?.[0] ?? null,
      m.conductor?.[1] ?? null,
      m.conductor ? new Date(Date.UTC(2028, 5, 1)) : null,
      m.conductor ? (m.conductor[3] ?? 'NINGUNA') : null,
      m.conductor?.[2] ?? null,
      m.relevador?.[0] ?? null,
      m.relevador?.[1] ?? null,
      m.relevador ? new Date(Date.UTC(2029, 0, 31)) : null,
      m.relevador ? 'CONDUCIR CON LENTES' : null,
      m.relevador?.[2] ?? null,
    ]);
  });
  // Filas vacías al final, como las que deja el Excel original.
  hoja.addRow([]);
  hoja.addRow([null, null, null]);

  return Buffer.from(await libro.xlsx.writeBuffer());
}
