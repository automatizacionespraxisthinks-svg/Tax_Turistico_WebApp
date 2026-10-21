import type { ReactNode } from 'react';
import type { StatusTone } from '@tax/shared';
import { cn } from '../lib/cn';

export const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'tone-neutral',
  info: 'tone-info',
  accent: 'tone-accent',
  progress: 'tone-progress',
  positive: 'tone-positive',
  warning: 'tone-warning',
  critical: 'tone-critical',
};

export interface StatusPillProps {
  tone: StatusTone;
  children: ReactNode;
  /** Punto sólido a la izquierda: identidad sin depender solo del color de fondo. */
  dot?: boolean;
  /** Halo latiendo: reservado para lo que está ocurriendo ahora mismo. */
  live?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function StatusPill({ tone, children, dot = true, live, size = 'sm', className }: StatusPillProps) {
  return (
    <span
      className={cn(
        TONE_CLASS[tone],
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-medium',
        'border-[var(--tone-line)] bg-[var(--tone-bg)] text-[var(--tone-ink)]',
        size === 'sm' ? 'h-5.5 px-2 text-micro' : 'h-7 px-2.5 text-caption',
        className,
      )}
    >
      {dot ? <LiveDot tone={tone} live={live} /> : null}
      {children}
    </span>
  );
}

/** Punto de estado. Con `live`, emite un halo que se expande y se apaga. */
export function LiveDot({
  tone,
  live,
  className,
}: {
  tone?: StatusTone;
  live?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('relative inline-flex size-1.5 shrink-0', tone ? TONE_CLASS[tone] : '', className)}>
      {live ? (
        <span
          className="absolute inset-0 rounded-full bg-[var(--tone-solid)]"
          style={{ animation: 'tax-beacon 2s var(--ease-soft) infinite' }}
          aria-hidden="true"
        />
      ) : null}
      <span className="relative size-1.5 rounded-full bg-[var(--tone-solid)]" />
    </span>
  );
}

/** Etiqueta de dato: clave corta en mayúsculas + valor. */
export function Meta({
  label,
  children,
  className,
  mono,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-micro font-medium uppercase tracking-[0.06em] text-ink-muted">{label}</p>
      <p className={cn('mt-0.5 truncate text-base text-ink', mono && 'font-mono text-sm')}>{children}</p>
    </div>
  );
}
