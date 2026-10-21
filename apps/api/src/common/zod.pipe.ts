import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from './problem';

/**
 * Validación de entrada con los MISMOS esquemas Zod que usan el panel y la
 * PWA (ADR, §3.1): un solo esquema valida la API, valida el formulario y
 * documenta el contrato con n8n.
 *
 * Un fallo sale como RFC 9457 con la lista de campos, para que el agente
 * pueda volver a preguntar en vez de adivinar.
 */
@Injectable()
export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    /*
     * Un POST sin cuerpo llega como `undefined`, y `z.object` lo rechaza
     * aunque todos sus campos sean opcionales. Varios comandos del conductor
     * no llevan cuerpo —aceptar, rechazar, cerrar turno—, así que se trata
     * como un objeto vacío y es el esquema, no el transporte, quien decide
     * si falta algo.
     */
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;

    throw new AppError(
      'VALIDATION_FAILED',
      undefined,
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(raíz)',
        message: issue.message,
      })),
    );
  }
}

/** Azúcar para los controladores: `@Body(zodBody(createRideSchema))`. */
export function zodBody<T extends z.ZodType>(schema: T): ZodPipe<T> {
  return new ZodPipe(schema);
}
