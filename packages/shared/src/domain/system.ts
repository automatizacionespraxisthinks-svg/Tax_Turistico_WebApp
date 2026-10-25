import type { StatusTone } from './labels';

/**
 * Comprobaciones de la página de estado (§10.4).
 *
 * Cada servicio se comprueba de verdad en cada consulta: una sentencia a
 * Postgres, un PING a Redis, la cola del outbox, las claves de API. Antes la
 * tarjeta pintaba todo en verde con textos fijos, y un panel que siempre dice
 * «operativo» no sirve para saber si algo va mal.
 */

/**
 * - `ok`: funciona.
 * - `aviso`: funciona, pero algo pide atención (reintentos, una clave vieja).
 * - `fallo`: no funciona, o lo que depende de él no está llegando.
 * - `apagado`: no está configurado; no es un fallo, pero tampoco vigila nada.
 */
export type CheckState = 'ok' | 'aviso' | 'fallo' | 'apagado';

export type ServiceId = 'postgres' | 'redis' | 'n8n' | 'whatsapp' | 'api_key';

export interface ServiceCheck {
  id: ServiceId;
  /** Con la versión real cuando se sabe: «PostgreSQL 18.6». */
  name: string;
  state: CheckState;
  /** Una línea para la oficina: qué se comprobó y qué salió. */
  detail: string;
  /** Lo que tardó en contestar, para Postgres y Redis. */
  latencyMs?: number;
}

export interface SystemChecks {
  checkedAt: string;
  services: ServiceCheck[];
  memory: {
    rssMb: number;
    heapMb: number;
    /** El límite del contenedor; nulo si no tiene uno fijado. */
    limitMb: number | null;
  };
}

export const CHECK_STATE_LABEL: Record<CheckState, string> = {
  ok: 'Operativo',
  aviso: 'Atención',
  fallo: 'Con fallo',
  apagado: 'Sin configurar',
};

export const CHECK_STATE_TONE: Record<CheckState, StatusTone> = {
  ok: 'positive',
  aviso: 'warning',
  fallo: 'critical',
  apagado: 'neutral',
};
