import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Hundida: para zonas de contenido secundario dentro de otra tarjeta. */
  sunk?: boolean;
  /** Sin relleno: la usa quien pone una tabla o un mapa a sangre. */
  flush?: boolean;
}

/**
 * La tarjeta se separa del fondo con sombra, no con borde. El borde se queda
 * transparente para que la tarjeta mida lo mismo que cuando lo tenía.
 */
export function Card({ sunk, flush, className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border',
        sunk ? 'border-line bg-surface-sunk' : 'border-transparent bg-surface shadow-sm',
        !flush && 'p-4',
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-caption text-ink-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

/** Título de sección dentro de una página; más discreto que el de tarjeta. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'text-micro font-semibold uppercase tracking-[0.07em] text-ink-muted',
        className,
      )}
    >
      {children}
    </p>
  );
}
