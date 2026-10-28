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
 * El lugar del catálogo que nombra el texto, si alguno.
 *
 * Coincide el nombre o una palabra clave como palabras enteras: «parque» no
 * se encuentra en «parqueadero». Si varias coinciden gana la más larga, que
 * es la más precisa —«terminal de Duitama» antes que «terminal»—, y a igual
 * largo, el lugar más usado.
 */
export function buscarLugar<T extends LugarBuscable>(
  texto: string,
  lugares: T[],
): { lugar: T; palabra: string } | null {
  const enTexto = ` ${normalizarParaBuscar(texto)} `;
  let mejor: { lugar: T; palabra: string; largo: number } | null = null;

  for (const lugar of lugares) {
    for (const palabra of [lugar.name, ...lugar.aliases]) {
      const buscada = normalizarParaBuscar(palabra);
      if (buscada.length < 3 || !enTexto.includes(` ${buscada} `)) continue;
      if (
        !mejor ||
        buscada.length > mejor.largo ||
        (buscada.length === mejor.largo && lugar.uses > mejor.lugar.uses)
      ) {
        mejor = { lugar, palabra, largo: buscada.length };
      }
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
  .refine((v) => v.tortuosity !== undefined || v.waves !== undefined, 'No hay nada que cambiar');
export type CambiosZona = z.infer<typeof cambiosZonaSchema>;
