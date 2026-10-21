import { useId } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { spring } from '../motion';
import { cn } from '../lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

/**
 * Control segmentado. El fondo del segmento activo es un solo elemento que
 * se desliza entre opciones (layoutId): el cambio se lee como un movimiento,
 * no como dos parpadeos.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const layoutId = useId();

  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border border-line bg-surface-sunk p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative inline-flex items-center gap-1.5 rounded-sm font-medium',
              'transition-colors duration-150 ease-[var(--ease-standard)]',
              size === 'sm' ? 'h-6 px-2 text-caption' : 'h-7.5 px-3 text-base',
              active ? 'text-ink' : 'text-ink-muted hover:text-ink-secondary',
            )}
          >
            {active ? (
              <motion.span
                layoutId={layoutId}
                transition={spring.indicator}
                className="absolute inset-0 rounded-sm border border-line bg-surface shadow-sm"
              />
            ) : null}
            <span className="relative">{option.label}</span>
            {option.count !== undefined ? (
              <span
                className={cn(
                  'relative tnum rounded-full px-1.5 text-micro font-semibold',
                  active ? 'bg-accent-soft text-accent-ink' : 'bg-surface text-ink-muted',
                )}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Pestañas de página: subrayado que viaja. Misma idea que el segmentado, pero
 * para navegación dentro de una pantalla.
 */
export function Tabs<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
}) {
  const layoutId = useId();

  return (
    <div role="tablist" className={cn('flex items-center gap-5 border-b border-line', className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative -mb-px flex items-center gap-1.5 pb-2.5 text-base font-medium',
              'transition-colors duration-150 ease-[var(--ease-standard)]',
              active ? 'text-ink' : 'text-ink-muted hover:text-ink-secondary',
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className="tnum text-caption text-ink-muted">{option.count}</span>
            ) : null}
            {active ? (
              <motion.span
                layoutId={layoutId}
                transition={spring.indicator}
                className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-accent"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
