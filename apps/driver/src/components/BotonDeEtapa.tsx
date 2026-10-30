import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import type { StatusTone } from '@tax/shared';
import { BANDA_DE_ESTADO, TONE_CLASS, cn, spring } from '@tax/ui';

type EstadoConBanda = keyof typeof BANDA_DE_ESTADO;

/** El tono de cada estado, para el relleno claro del botón bloqueado. */
const TONO: Record<EstadoConBanda, StatusTone> = {
  NOTIFIED: 'warning',
  ASSIGNED: 'info',
  DRIVER_ARRIVED: 'critical',
  IN_PROGRESS: 'positive',
};

/**
 * El botón de cada etapa: grande, con letra de 24 px y el color del estado
 * en el tablero del panel. Ámbar para aceptar, azul para «Llegué», rojo para
 * «Pasajero a bordo» y verde para «Finalizar»: el conductor sabe en qué paso
 * está sin leer, y la oficina ve la carrera del mismo color.
 *
 * Bloqueado se queda gris, y por dentro se va llenando del color de la etapa
 * a medida que pasa el tiempo: se ve de lejos cuánto falta sin leer el número.
 */
export function BotonDeEtapa({
  estado,
  icon,
  children,
  onClick,
  disabled = false,
  progreso,
}: {
  estado: EstadoConBanda;
  icon: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  progreso?: number;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.985 }}
      transition={spring.snappy}
      className={cn(
        TONE_CLASS[TONO[estado]],
        'relative flex h-[4.5rem] w-full items-center justify-center overflow-hidden rounded-lg px-6',
        'text-2xl font-bold tracking-[-0.01em]',
        disabled
          ? 'cursor-not-allowed border border-line bg-surface-sunk text-ink-secondary'
          : cn('border border-transparent text-on-accent shadow-sm', BANDA_DE_ESTADO[estado]),
      )}
    >
      {progreso !== undefined ? (
        <motion.span
          aria-hidden="true"
          initial={false}
          animate={{ scaleX: Math.min(1, Math.max(0, progreso)) }}
          transition={{ duration: 0.9, ease: 'linear' }}
          style={{ originX: 0 }}
          className="absolute inset-0 bg-[var(--tone-bg)]"
        />
      ) : null}
      <span className="relative flex items-center gap-3">
        {icon}
        <span>{children}</span>
      </span>
    </motion.button>
  );
}

/** El tono de una etapa, para la píldora y la barra de progreso. */
export function tonoDeEtapa(estado: EstadoConBanda): StatusTone {
  return TONO[estado];
}
