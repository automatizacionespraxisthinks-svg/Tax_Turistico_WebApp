/**
 * Reconocimiento de errores de PostgreSQL.
 *
 * Drizzle envuelve los errores del driver en `DrizzleQueryError` y deja el
 * error original en `cause`, a veces con más de un nivel. Mirar solo
 * `error.code` falla en silencio: la violación de unicidad se escapa, el
 * `catch` no la traduce y el cliente recibe un 500 en vez del código estable
 * del contrato (§7.1).
 *
 * Esto importa especialmente en dos sitios donde la base ES la garantía:
 * `one_active_ride_per_customer` y `one_open_shift_per_driver`.
 */

/** Códigos SQLSTATE que la API traduce a errores de dominio. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

/** Recorre la cadena de causas buscando un SQLSTATE. */
export function pgErrorCode(error: unknown, depth = 5): string | undefined {
  let current: unknown = error;

  for (let i = 0; i <= depth && current; i++) {
    if (typeof current === 'object' && 'code' in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && /^\d{5}$/.test(code)) return code;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (pgErrorCode(error) !== PG_UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  // El nombre de la restricción distingue «ya tiene carrera» de «ya tiene
  // turno»: sin él, dos causas distintas darían el mismo mensaje.
  return constraintName(error) === constraint;
}

export function constraintName(error: unknown, depth = 5): string | undefined {
  let current: unknown = error;

  for (let i = 0; i <= depth && current; i++) {
    if (typeof current === 'object' && 'constraint' in current) {
      const name = (current as { constraint?: unknown }).constraint;
      if (typeof name === 'string') return name;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}
