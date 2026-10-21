import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import type { StatusTone } from '@tax/shared';
import { duration, ease } from '../motion';
import { cn } from '../lib/cn';
import { TONE_CLASS } from './StatusPill';

/** Bloque de carga. El barrido va de izquierda a derecha, siempre igual. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4 w-full', className)} aria-hidden="true" />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.base, ease: ease.entrance }}
      className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}
    >
      {icon ? (
        <div className="mb-3 flex size-10 items-center justify-center rounded-full border border-line bg-surface-sunk text-ink-muted">
          {icon}
        </div>
      ) : null}
      <p className="text-base font-medium text-ink">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-caption text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </motion.div>
  );
}

/**
 * Aro de cuenta regresiva. El trazo se vacía en tiempo real y el color salta
 * a crítico en los últimos segundos: el conductor lo entiende de reojo.
 */
export function ProgressRing({
  /** 0 a 1; 1 es tiempo completo restante. */
  progress,
  size = 56,
  stroke = 4,
  tone = 'info',
  children,
  className,
}: {
  progress: number;
  size?: number;
  stroke?: number;
  tone?: StatusTone;
  children?: ReactNode;
  className?: string;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, progress));

  return (
    <div
      className={cn(TONE_CLASS[tone], 'relative inline-flex items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true" focusable="false">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--c-line)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--tone-solid)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          style={{ transition: 'stroke-dashoffset 1s linear, stroke 240ms var(--ease-standard)' }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center">{children}</span>
    </div>
  );
}

/**
 * Banda de aviso persistente. A diferencia del toast, no se va sola: se usa
 * para condiciones que siguen siendo verdad (sin conexión, línea caída).
 */
export function Banner({
  tone,
  icon,
  children,
  action,
  className,
}: {
  tone: StatusTone;
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: duration.base, ease: ease.entrance }}
      className={cn(
        TONE_CLASS[tone],
        'flex items-center gap-2.5 rounded-md border border-[var(--tone-line)] bg-[var(--tone-bg)] px-3 py-2',
        className,
      )}
    >
      {icon ? <span className="shrink-0 text-[var(--tone-ink)]">{icon}</span> : null}
      <div className="min-w-0 flex-1 text-base text-[var(--tone-ink)]">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </motion.div>
  );
}
