import { z } from 'zod';
import type { TransitionActor } from './ride';

/**
 * Cancelación de una carrera por el conductor, por causa mayor.
 *
 * Solo antes de recoger al cliente: asignada o con el conductor en el lugar.
 * Con el pasajero a bordo la carrera se termina, no se cancela. La máquina de
 * estados (§5.3) ya lo permitía con «motivo obligatorio»; faltaba que el
 * conductor pudiera hacerlo y que quedara contado.
 *
 * El motivo se elige de una lista corta para poder contarlo en Reportes —por
 * conductor y en general—, con «Otro» y su explicación para lo que no cabe.
 */

export const MOTIVOS_CANCELACION_CONDUCTOR = [
  { clave: 'falla_mecanica', texto: 'Falla mecánica o pinchazo' },
  { clave: 'accidente', texto: 'Accidente o problema en la vía' },
  { clave: 'emergencia', texto: 'Emergencia personal o de salud' },
  { clave: 'cliente_no_aparece', texto: 'El cliente no aparece o no contesta' },
  { clave: 'otro', texto: 'Otro motivo' },
] as const;

export type MotivoCancelacionConductor = (typeof MOTIVOS_CANCELACION_CONDUCTOR)[number]['clave'];

const CLAVES = MOTIVOS_CANCELACION_CONDUCTOR.map((m) => m.clave) as [
  MotivoCancelacionConductor,
  ...MotivoCancelacionConductor[],
];

export const cancelacionConductorSchema = z
  .object({
    motivo: z.enum(CLAVES),
    /** Obligatorio con «Otro»; con los demás, opcional. */
    detalle: z.string().trim().max(200, 'Hasta 200 caracteres').optional(),
  })
  .refine((v) => v.motivo !== 'otro' || (v.detalle?.length ?? 0) >= 5, {
    message: 'Cuenta en pocas palabras por qué cancelas',
    path: ['detalle'],
  });
export type CancelacionConductor = z.infer<typeof cancelacionConductorSchema>;

/** «Falla mecánica o pinchazo», o lo que escribió el conductor con «Otro». */
export function textoDelMotivo(motivo: string | null | undefined, detalle?: string | null): string {
  const definido = MOTIVOS_CANCELACION_CONDUCTOR.find((m) => m.clave === motivo);
  if (!definido) return detalle?.trim() || 'Sin motivo';
  if (definido.clave === 'otro') return detalle?.trim() || definido.texto;
  return detalle?.trim() ? `${definido.texto}: ${detalle.trim()}` : definido.texto;
}

/** Quién canceló, en palabras de la oficina. */
export const QUIEN_CANCELA: Record<TransitionActor, string> = {
  customer: 'Cliente',
  operator: 'Oficina',
  driver: 'Conductor',
  system: 'Sistema',
};

/** Los estados desde los que el conductor todavía puede cancelar. */
export const CANCELABLE_POR_EL_CONDUCTOR = ['ASSIGNED', 'DRIVER_ARRIVED'] as const;
