import { z } from 'zod';
import { pointSchema } from './geo';

/**
 * Zonas y lugares que se crean desde el panel.
 *
 * Los esquemas los comparten la API, que valida, y el panel, que arma el
 * formulario con los mismos límites. Aquí vive también cómo se reconoce un
 * lugar del catálogo en lo que escribió el cliente: «frente a la terminal» no
 * es una dirección, pero si «la terminal» es palabra clave de un lugar, el
 * taxi sabe a dónde ir.
 */

export const MAX_PALABRAS_CLAVE = 20;

/** Para comparar: minúsculas, sin tildes ni signos, y un solo espacio entre palabras. */
export function normalizarParaBuscar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Si el texto trae una dirección en nomenclatura: «Calle 25 #18-40»,
 * «Cra 10 No. 5-20», «Diagonal 3». Con nomenclatura manda el geocodificador,
 * que llega a la puerta; sin ella, el catálogo de lugares.
 */
export function tieneNomenclatura(texto: string): boolean {
  const normal = normalizarParaBuscar(texto);
  const via = /\b(calle|cll?|carrera|carera|cra|kra|kr|cr|diagonal|dg|transversal|tv|tr|avenida|av)\s*\d+/;
  const placa = /\d+\s*(#|no\.?|n°|nº)\s*\d+/i;
  return via.test(normal) || placa.test(texto);
}

export interface LugarBuscable {
  id: string;
  name: string;
  aliases: string[];
  uses: number;
}

/**
 * Palabras que no distinguen un lugar de otro: artículos, contracciones y
 * preposiciones. «el terminal», «la terminal», «al terminal» y «terminal» son
 * el mismo sitio, y «terminal de buses» es «terminal buses».
 */
export const PALABRAS_VACIAS = new Set([
  'el', 'la', 'los', 'las', 'lo', 'al', 'del', 'de', 'a', 'en', 'y', 'un', 'una', 'unos', 'unas',
]);

/** Las palabras que cuentan de un texto, normalizadas y sin las vacías. */
function palabrasQueCuentan(texto: string): string[] {
  return normalizarParaBuscar(texto)
    .split(' ')
    .filter((p) => p && !PALABRAS_VACIAS.has(p));
}

/**
 * Lo que identifica a una palabra clave: normalizada y sin artículos ni
 * preposiciones. Dos palabras clave con el mismo núcleo son la misma para el
 * buscador —«la terminal» y «terminal»—, así que no pueden ser de dos lugares.
 */
export function nucleoDe(palabra: string): string {
  return palabrasQueCuentan(palabra).join(' ') || normalizarParaBuscar(palabra);
}

/**
 * Cuántas letras de diferencia se le perdonan a una palabra del cliente,
 * según lo larga que sea la palabra clave. Las cortas tienen que ser exactas:
 * «lago» y «largo» están a una letra y no son lo mismo. Las que llevan
 * números, también: «D1» no es «D2». Dos letras solo desde diez: con ocho,
 * «hospital» ya sería «hostal».
 */
function erroresPermitidos(palabra: string): number {
  if (/\d/.test(palabra) || palabra.length <= 4) return 0;
  return palabra.length >= 10 ? 2 : 1;
}

/**
 * Si dos palabras pueden ser la misma con un error de escritura: dentro de
 * las letras permitidas, y con la primera y la última iguales. Lo segundo
 * deja fuera las palabras de la misma raíz, que no son errores: «termina» no
 * es «terminal», ni «colonia» es «colonial».
 */
function parecidas(buscada: string, escrita: string): number | null {
  if (buscada === escrita) return 0;
  const max = erroresPermitidos(buscada);
  if (max === 0 || buscada[0] !== escrita[0] || buscada.at(-1) !== escrita.at(-1)) return null;
  const d = distancia(buscada, escrita, max);
  return d <= max ? d : null;
}

/** Letras de diferencia (Levenshtein), o `max + 1` en cuanto se pasa. */
function distancia(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previa = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const actual = [i];
    let menor = i;
    for (let j = 1; j <= b.length; j++) {
      actual[j] = Math.min(previa[j]! + 1, actual[j - 1]! + 1, previa[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      menor = Math.min(menor, actual[j]!);
    }
    if (menor > max) return max + 1;
    previa = actual;
  }
  return previa[b.length]!;
}

/**
 * Dónde aparece `buscadas` seguidas dentro de `texto`, palabra por palabra,
 * con las letras de diferencia que se perdonan a cada una. Devuelve cuántas
 * letras hubo que perdonar en total, o `null` si no aparece.
 */
function aparece(buscadas: string[], texto: string[]): number | null {
  let mejor: number | null = null;
  for (let inicio = 0; inicio + buscadas.length <= texto.length; inicio++) {
    let errores = 0;
    let vale = true;
    for (let k = 0; k < buscadas.length && vale; k++) {
      const d = parecidas(buscadas[k]!, texto[inicio + k]!);
      if (d === null) vale = false;
      else errores += d;
    }
    if (vale && (mejor === null || errores < mejor)) mejor = errores;
  }
  return mejor;
}

/**
 * El lugar del catálogo que nombra el texto, si alguno.
 *
 * No es estricto, a propósito. El agente de n8n resume lo que dijo el cliente
 * y el cliente escribe como habla, así que se compara palabra por palabra:
 *
 *  - Sin artículos ni preposiciones: «el terminal», «la terminal», «al
 *    terminal», «del terminal» y «terminal» a secas son lo mismo. Antes
 *    «terminal» solo no encontraba la palabra clave «el terminal».
 *  - Con errores de escritura en las palabras largas: «terminl», «hopital»,
 *    «alcadia». Una letra en las de 5 a 9, dos en las de 10 o más, siempre
 *    con la primera y la última iguales. Las de cuatro letras o menos, y las
 *    que llevan números, tienen que ser exactas.
 *  - Un nombre con paréntesis vale también sin ellos: «Lago Sochagota
 *    (malecón)» es «lago sochagota».
 *  - Siempre palabras enteras: «parque» no está en «parqueadero».
 *
 * Si varias coinciden, gana la que nombra más palabras —«terminal de
 * Duitama» antes que «terminal»—, luego la que necesitó menos correcciones,
 * luego la más larga y, al final, el lugar más usado.
 */
export function buscarLugar<T extends LugarBuscable>(
  texto: string,
  lugares: T[],
): { lugar: T; palabra: string } | null {
  const enTexto = palabrasQueCuentan(texto);
  type Candidato = { lugar: T; palabra: string; palabras: number; errores: number; letras: number };
  let mejor: Candidato | null = null;
  const esMejor = (a: Candidato, b: Candidato | null) =>
    !b ||
    a.palabras > b.palabras ||
    (a.palabras === b.palabras && a.errores < b.errores) ||
    (a.palabras === b.palabras && a.errores === b.errores && a.letras > b.letras) ||
    (a.palabras === b.palabras && a.errores === b.errores && a.letras === b.letras && a.lugar.uses > b.lugar.uses);

  for (const lugar of lugares) {
    const formas = [lugar.name, lugar.name.replace(/\s*\([^)]*\)\s*/g, ' '), ...lugar.aliases];
    for (const palabra of formas) {
      const buscadas = palabrasQueCuentan(palabra);
      if (buscadas.join('').length < 3) continue;
      const errores = aparece(buscadas, enTexto);
      if (errores === null) continue;
      const candidato: Candidato = {
        lugar,
        // Para decir con qué se reconoció: la palabra clave o el nombre tal cual.
        palabra: palabra === formas[1] ? lugar.name : palabra,
        palabras: buscadas.length,
        errores,
        letras: buscadas.join(' ').length,
      };
      if (esMejor(candidato, mejor)) mejor = candidato;
    }
  }
  return mejor ? { lugar: mejor.lugar, palabra: mejor.palabra } : null;
}

/* --------------------------------------------------------------- esquemas --- */

const palabraClave = z
  .string()
  .trim()
  .max(60, 'Cada palabra clave puede tener hasta 60 caracteres')
  .refine((p) => normalizarParaBuscar(p).length >= 3, 'Cada palabra clave necesita al menos 3 letras');

export const nuevoLugarSchema = z.object({
  name: z.string().trim().min(3, 'Escribe al menos 3 letras').max(80),
  /** Cómo lo nombran los clientes: «el parque», «la terminal», «donde Don Pacho». */
  aliases: z.array(palabraClave).max(MAX_PALABRAS_CLAVE, `Hasta ${MAX_PALABRAS_CLAVE} palabras clave`).default([]),
  point: pointSchema,
});
export type NuevoLugar = z.infer<typeof nuevoLugarSchema>;

export const cambiosLugarSchema = z
  .object({
    name: nuevoLugarSchema.shape.name.optional(),
    aliases: nuevoLugarSchema.shape.aliases.optional(),
    point: pointSchema.optional(),
    /** Falso lo saca del catálogo: el agente deja de reconocerlo. */
    active: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'No hay nada que cambiar');
export type CambiosLugar = z.infer<typeof cambiosLugarSchema>;

/** Lo que se propone al crear una zona de cada tipo; se puede cambiar. */
export const ZONA_POR_DEFECTO = {
  urbano: { radiusKm: 1.2, tortuosity: 1.3 },
  rural: { radiusKm: 2.6, tortuosity: 1.8 },
} as const;

export const nuevaZonaSchema = z.object({
  name: z.string().trim().min(3, 'Escribe al menos 3 letras').max(60),
  kind: z.enum(['urbano', 'rural']),
  center: pointSchema,
  radiusKm: z.number().min(0.3, 'El radio mínimo es 0,3 km').max(15, 'El radio máximo es 15 km'),
  tortuosity: z.number().min(1).max(3).optional(),
});
export type NuevaZona = z.infer<typeof nuevaZonaSchema>;

const oleadaSchema = z.object({
  wave: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  radiusKm: z.number().min(0.5).max(40),
  candidates: z.number().int().min(1).max(30),
  timeoutSeconds: z.number().int().min(15).max(300),
});

export const cambiosZonaSchema = z
  .object({
    tortuosity: z.number().min(1).max(3).optional(),
    /** Hacerla el punto de partida de las carreras sin ubicar. Solo se pone: quitarla es elegir otra. */
    esReferencia: z.literal(true).optional(),
    waves: z
      .array(oleadaSchema)
      .length(3)
      .refine((w) => [1, 2, 3].every((n) => w.some((o) => o.wave === n)), 'Faltan oleadas')
      .refine(
        (w) => {
          const orden = [...w].sort((a, b) => a.wave - b.wave);
          return orden[0]!.radiusKm <= orden[1]!.radiusKm && orden[1]!.radiusKm <= orden[2]!.radiusKm;
        },
        'Cada oleada busca más lejos que la anterior',
      )
      .optional(),
  })
  .refine(
    (v) => v.tortuosity !== undefined || v.waves !== undefined || v.esReferencia !== undefined,
    'No hay nada que cambiar',
  );
export type CambiosZona = z.infer<typeof cambiosZonaSchema>;
