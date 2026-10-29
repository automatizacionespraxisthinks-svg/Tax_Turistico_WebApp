import ExcelJS from 'exceljs';

/**
 * El listado maestro de la empresa: una fila por móvil, con su vehículo, su
 * propietario, su conductor y sus relevadores.
 *
 * Aquí solo se lee y se limpia; lo que se hace con cada fila está en
 * `ImportacionService`. Las columnas se buscan por su nombre, no por su
 * posición: si el Excel del mes siguiente trae una columna de más, o un
 * segundo relevador, sigue funcionando.
 */

export interface PersonaDelListado {
  nombre: string;
  /** Solo dígitos. */
  cedula: string;
  /** E.164, o nulo si el Excel no lo trae o no es un celular colombiano. */
  celular: string | null;
  /** `AAAA-MM-DD`. */
  licenciaVence: string | null;
  /** Nula si es «Ninguna». */
  restriccion: string | null;
}

export interface MovilDelListado {
  /** La fila del Excel, para los avisos. */
  fila: number;
  /** Tres dígitos: «002». */
  interno: string;
  placa: string;
  activo: boolean;
  marca: string | null;
  modelo: number | null;
  combustible: string | null;
  motor: string | null;
  chasis: string | null;
  pesoKg: number | null;
  capacidad: number;
  matricula: string | null;
  propietario: { nombre: string; cedula: string } | null;
  conductor: PersonaDelListado | null;
  relevadores: PersonaDelListado[];
}

export interface ListadoLeido {
  hoja: string;
  moviles: MovilDelListado[];
  /** Se carga igual, pero conviene revisarlo en el Excel. */
  avisos: string[];
  /** Impiden la carga. */
  errores: string[];
}

/* --------------------------------------------------------------- limpieza --- */

/** Para comparar encabezados: sin tildes, signos ni mayúsculas. «Cedúla [C]» → «cedula c». */
export function normalizarEncabezado(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** El valor de una celda de ExcelJS, sea fórmula, texto enriquecido o hipervínculo. */
function valor(celda: ExcelJS.CellValue): unknown {
  if (celda && typeof celda === 'object' && !(celda instanceof Date)) {
    if ('result' in celda) return (celda as { result: unknown }).result;
    if ('richText' in celda) return (celda as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
    if ('text' in celda) return (celda as { text: unknown }).text;
  }
  return celda;
}

const texto = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim();

const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e']);

/** «  triana PEDRAZA felix  de jesus» → «Triana Pedraza Felix de Jesus». El orden no se toca. */
export function limpiarNombre(v: unknown): string {
  return texto(v)
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((palabra, i) => (i > 0 && PARTICULAS.has(palabra) ? palabra : palabra.charAt(0).toUpperCase() + palabra.slice(1)))
    .join(' ');
}

export const soloDigitos = (v: unknown): string => texto(v).replace(/\D/g, '');

/** Un celular colombiano en E.164, o nulo: «314 8705926» → «+573148705926». */
export function limpiarCelular(v: unknown): string | null {
  const d = soloDigitos(v);
  if (/^3\d{9}$/.test(d)) return `+57${d}`;
  if (/^573\d{9}$/.test(d)) return `+${d}`;
  return null;
}

/**
 * Una fecha de Excel como `AAAA-MM-DD`. ExcelJS da las fechas a medianoche
 * UTC, así que se leen en UTC: en hora de Paipa caerían en el día anterior.
 */
export function limpiarFecha(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const t = texto(v);
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dma = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dma) return `${dma[3]}-${dma[2]!.padStart(2, '0')}-${dma[1]!.padStart(2, '0')}`;
  return null;
}

/** «NINGUNA» no es una restricción; el resto se guarda en minúsculas con mayúscula inicial. */
export function limpiarRestriccion(v: unknown): string | null {
  const t = texto(v);
  if (!t || /^ningun[ao]$/i.test(t)) return null;
  const minus = t.toLowerCase();
  return minus.charAt(0).toUpperCase() + minus.slice(1);
}

const entero = (v: unknown): number | null => {
  const m = texto(v).match(/\d+/);
  return m ? Number(m[0]) : null;
};

/* ---------------------------------------------------------------- columnas --- */

const COLUMNAS = {
  interno: ['n interno', 'no interno', 'numero interno', 'movil'],
  placa: ['placa'],
  estado: ['estado'],
  marca: ['marca'],
  modelo: ['modelo'],
  combustible: ['combustible'],
  motor: ['numero del motor', 'no motor', 'motor'],
  chasis: ['numero del chasis', 'no chasis', 'chasis'],
  peso: ['peso vehicular', 'peso'],
  capacidad: ['capacidad'],
  matricula: ['fecha de matricula', 'matricula'],
  propietarioNombre: ['nombre', 'nombre propietario'],
  propietarioCedula: ['cedula', 'cedula propietario'],
  conductorNombre: ['nombre2', 'nombre c', 'nombre conductor'],
  conductorCedula: ['cedula c', 'cedula conductor'],
  conductorLicencia: ['vencimiento licencia c', 'vencimiento licencia'],
  conductorRestriccion: ['restriccion', 'restriccion c'],
  conductorCelular: ['celular c', 'celular'],
} as const;

const OBLIGATORIAS: (keyof typeof COLUMNAS)[] = ['interno', 'placa', 'estado', 'conductorNombre', 'conductorCedula'];

/** Los encabezados de los relevadores: «Nombre [R1]», «Cedúla [R1]», «Restricciòn2»… */
const columnasDeRelevador = (n: number) => ({
  nombre: [`nombre r${n}`],
  cedula: [`cedula r${n}`],
  licencia: [`vencimiento licencia r${n}`],
  restriccion: [`restriccion r${n}`, `restriccion${n + 1}`],
  celular: [`celular r${n}`],
});

/* ------------------------------------------------------------------ lectura --- */

export async function leerListadoMaestro(contenido: Buffer): Promise<ListadoLeido> {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(contenido as unknown as ArrayBuffer);

  // La hoja «Taxis» si existe; si no, la primera que tenga una columna «Placa».
  const hojas = libro.worksheets;
  const hoja =
    hojas.find((h) => normalizarEncabezado(h.name) === 'taxis') ??
    hojas.find((h) => buscarEncabezado(h) !== null) ??
    hojas[0];
  if (!hoja) throw new Error('El archivo no tiene hojas');

  const filaEncabezado = buscarEncabezado(hoja);
  if (filaEncabezado === null) {
    throw new Error(`La hoja «${hoja.name}» no tiene una fila de encabezados con «N° Interno» y «Placa»`);
  }

  // Encabezado normalizado → número de columna; si se repite, gana el primero.
  const indice = new Map<string, number>();
  hoja.getRow(filaEncabezado).eachCell((celda, columna) => {
    const nombre = normalizarEncabezado(texto(valor(celda.value)));
    if (nombre && !indice.has(nombre)) indice.set(nombre, columna);
  });
  const columna = (opciones: readonly string[]) => opciones.map((o) => indice.get(o)).find((c) => c !== undefined);

  const faltan = OBLIGATORIAS.filter((clave) => columna(COLUMNAS[clave]) === undefined);
  if (faltan.length) {
    throw new Error(`Faltan columnas en «${hoja.name}»: ${faltan.join(', ')}`);
  }
  const col = Object.fromEntries(Object.entries(COLUMNAS).map(([clave, opciones]) => [clave, columna(opciones)])) as Record<
    keyof typeof COLUMNAS,
    number | undefined
  >;
  const relevadores: Record<keyof ReturnType<typeof columnasDeRelevador>, number | undefined>[] = [];
  for (let n = 1; n <= 5; n++) {
    const c = columnasDeRelevador(n);
    const cols = {
      nombre: columna(c.nombre),
      cedula: columna(c.cedula),
      licencia: columna(c.licencia),
      restriccion: columna(c.restriccion),
      celular: columna(c.celular),
    };
    if (cols.nombre === undefined && cols.cedula === undefined) break;
    relevadores.push(cols);
  }

  const avisos: string[] = [];
  const moviles: MovilDelListado[] = [];

  for (let numero = filaEncabezado + 1; numero <= hoja.rowCount; numero++) {
    const fila = hoja.getRow(numero);
    const leer = (c: number | undefined) => (c === undefined ? null : valor(fila.getCell(c).value));
    const interno = soloDigitos(leer(col.interno));
    const placa = texto(leer(col.placa)).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!interno && !placa) continue; // fila vacía

    if (!interno || !placa) {
      avisos.push(`Fila ${numero}: sin ${interno ? 'placa' : 'número interno'}; se salta.`);
      continue;
    }
    if (!/^[A-Z]{3}\d{3}$/.test(placa)) avisos.push(`Fila ${numero}: la placa «${placa}» no tiene la forma ABC123.`);

    const persona = (cols: { nombre?: number; cedula?: number; licencia?: number; restriccion?: number; celular?: number }, rol: string) => {
      const nombre = limpiarNombre(leer(cols.nombre));
      const cedula = soloDigitos(leer(cols.cedula));
      if (!nombre && !cedula) return null;
      // Una cédula colombiana tiene de 5 a 10 dígitos; con margen para la de extranjería.
      if (!/^\d{5,12}$/.test(cedula) || /^0+$/.test(cedula)) {
        avisos.push(`Fila ${numero} (móvil ${interno.padStart(3, '0')}): ${rol} «${nombre}» sin cédula válida; no se carga.`);
        return null;
      }
      const celularCrudo = texto(leer(cols.celular));
      const celular = limpiarCelular(celularCrudo);
      if (celularCrudo && !celular) {
        avisos.push(`Fila ${numero} (móvil ${interno.padStart(3, '0')}): el celular de ${nombre} no parece un celular colombiano; queda sin celular.`);
      }
      return {
        nombre: nombre || `Cédula ${cedula}`,
        cedula,
        celular,
        licenciaVence: limpiarFecha(leer(cols.licencia)),
        restriccion: limpiarRestriccion(leer(cols.restriccion)),
      };
    };

    const propietarioNombre = limpiarNombre(leer(col.propietarioNombre));
    const propietarioCedula = soloDigitos(leer(col.propietarioCedula));
    const capacidad = entero(leer(col.capacidad));

    moviles.push({
      fila: numero,
      interno: interno.padStart(3, '0'),
      placa,
      activo: /^activ/i.test(texto(leer(col.estado))),
      marca: limpiarNombre(leer(col.marca)).toUpperCase() || null,
      modelo: entero(leer(col.modelo)),
      combustible: limpiarNombre(leer(col.combustible)) || null,
      motor: texto(leer(col.motor)).toUpperCase() || null,
      chasis: texto(leer(col.chasis)).toUpperCase() || null,
      pesoKg: entero(leer(col.peso)),
      capacidad: capacidad && capacidad > 0 && capacidad <= 8 ? capacidad : 4,
      matricula: limpiarFecha(leer(col.matricula)),
      propietario: propietarioNombre || propietarioCedula ? { nombre: propietarioNombre, cedula: propietarioCedula } : null,
      conductor: persona(
        {
          nombre: col.conductorNombre,
          cedula: col.conductorCedula,
          licencia: col.conductorLicencia,
          restriccion: col.conductorRestriccion,
          celular: col.conductorCelular,
        },
        'el conductor',
      ),
      relevadores: relevadores
        .map((cols, i) => persona(cols, `el relevador ${i + 1}`))
        .filter((p): p is PersonaDelListado => p !== null),
    });
  }

  // Un móvil o una placa repetidos no se pueden adivinar: la carga no sigue.
  const errores: string[] = [];
  const repetidos = (claves: string[]) => [...new Set(claves.filter((c, i) => claves.indexOf(c) !== i))];
  for (const interno of repetidos(moviles.map((m) => m.interno))) errores.push(`El número interno ${interno} aparece más de una vez.`);
  for (const placa of repetidos(moviles.map((m) => m.placa))) errores.push(`La placa ${placa} aparece más de una vez.`);

  return { hoja: hoja.name, moviles, avisos, errores };
}

/** La fila que tiene «N° Interno» y «Placa», entre las diez primeras. */
function buscarEncabezado(hoja: ExcelJS.Worksheet): number | null {
  for (let numero = 1; numero <= Math.min(10, hoja.rowCount); numero++) {
    const nombres = new Set<string>();
    hoja.getRow(numero).eachCell((celda) => nombres.add(normalizarEncabezado(texto(valor(celda.value)))));
    if (nombres.has('placa') && COLUMNAS.interno.some((n) => nombres.has(n))) return numero;
  }
  return null;
}
