import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { motion } from 'motion/react';
import { spring } from '../motion';
import { cn } from '../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'touch';

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-on-accent border border-transparent hover:bg-accent-hover active:bg-accent-active shadow-sm',
  secondary:
    'bg-surface text-ink border border-line hover:border-line-strong hover:bg-surface-sunk',
  ghost:
    'bg-transparent text-ink-secondary border border-transparent hover:bg-surface-sunk hover:text-ink',
  danger:
    'bg-transparent text-[var(--t-critical-ink)] border border-[var(--t-critical-line)] hover:bg-[var(--t-critical-bg)]',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-caption gap-1.5 rounded-sm',
  md: 'h-9 px-3.5 text-base gap-2 rounded-md',
  lg: 'h-11 px-5 text-lg gap-2 rounded-md',
  /** 64 px: objetivo táctil de la PWA del conductor (RNF Usabilidad). */
  touch: 'h-16 px-6 text-xl gap-3 rounded-lg font-semibold w-full',
};

/**
 * Los gestos de arrastre y animación los maneja el motor de movimiento, así
 * que se excluyen los manejadores nativos equivalentes del elemento.
 */
type NativeButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  | 'children'
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onAnimationIteration'
>;

export interface ButtonProps extends NativeButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconRight, loading, className, children, disabled, ...rest },
  ref,
) {
  const isTouch = size === 'touch';
  return (
    <motion.button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      whileTap={disabled || loading ? undefined : { scale: isTouch ? 0.985 : 0.97 }}
      transition={spring.snappy}
      className={cn(
        'inline-flex items-center justify-center font-medium select-none',
        'transition-[background-color,border-color,color,box-shadow] duration-150 ease-[var(--ease-standard)]',
        'disabled:opacity-45 disabled:pointer-events-none',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {iconRight}
    </motion.button>
  );
});

function Spinner() {
  return (
    <svg
      className="size-4 animate-spin"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Botón solo-icono con área táctil cuadrada. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(
  function IconButton({ label, className, size = 'md', ...rest }, ref) {
    return (
      <Button
        ref={ref}
        aria-label={label}
        title={label}
        size={size}
        className={cn('aspect-square px-0', size === 'sm' ? 'w-7' : size === 'lg' ? 'w-11' : 'w-9', className)}
        {...rest}
      />
    );
  },
);
