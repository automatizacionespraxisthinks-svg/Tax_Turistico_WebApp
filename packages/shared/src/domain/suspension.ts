import { z } from 'zod';
import { ZONA_HORARIA_PAIPA } from './informes';

/**
 * Suspensión de un conductor por el reglamento interno.
 *
 * Es la desactivación con fecha de vuelta: mientras dura no recibe carreras,
 * no entra a la PWA ni abre turno, y al cumplirse vuelve solo. La oficina la
 * pone en días contados desde el momento en que la aplica: «3 días» puesta un
 * martes a las 3 p. m. termina el viernes a las 3 p. m.
 */

/** Los atajos que ofrece el panel; también se puede escribir otra cantidad. */
export const DIAS_DE_SUSPENSION = [1, 3, 7, 15, 30] as const;
export const MAX_DIAS_SUSPENSION = 90;

export const suspensionSchema = z.object({
  dias: z.number().int().min(1).max(MAX_DIAS_SUSPENSION),
  /** Obligatorio: es una sanción y tiene que quedar dicho por qué. */
  motivo: z.string().trim().min(5, 'Escribe el motivo de la suspensión').max(280),
});
export type Suspension = z.infer<typeof suspensionSchema>;

/** Si una suspensión que termina en `hasta` sigue en pie en `ahora`. */
export function sigueSuspendido(hasta: Date | string | null | undefined, ahora = new Date()): boolean {
  if (!hasta) return false;
  return new Date(hasta).getTime() > ahora.getTime();
}

/** «viernes 31 de octubre, 3:00 p. m.», en hora de Paipa. */
export function finDeSuspension(hasta: Date | string): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: ZONA_HORARIA_PAIPA,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(hasta));
}
