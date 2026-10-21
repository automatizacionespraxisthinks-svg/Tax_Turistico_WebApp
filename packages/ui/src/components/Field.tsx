import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { duration, ease } from '../motion';
import { cn } from '../lib/cn';

const CONTROL = [
  'w-full rounded-md border border-line bg-surface px-3 text-base text-ink',
  'placeholder:text-ink-muted',
  'transition-[border-color,box-shadow,background-color] duration-150 ease-[var(--ease-standard)]',
  'hover:border-line-strong',
  'focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-soft',
  'disabled:cursor-not-allowed disabled:bg-surface-sunk disabled:text-ink-muted',
].join(' ');

export function Field({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="flex items-center gap-1 text-caption font-medium text-ink-secondary">
        {label}
        {required ? <span className="text-[var(--t-critical-ink)]">*</span> : null}
      </label>
      {children}
      <AnimatePresence initial={false} mode="wait">
        {error ? (
          <motion.p
            key="error"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: duration.fast, ease: ease.standard }}
            className="overflow-hidden text-caption text-[var(--t-critical-ink)]"
          >
            {error}
          </motion.p>
        ) : hint ? (
          <p className="text-caption text-ink-muted">{hint}</p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(CONTROL, 'h-9', className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(CONTROL, 'min-h-20 resize-y py-2', className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(CONTROL, 'h-9 cursor-pointer appearance-none pr-8', className)} {...rest}>
        {children}
      </select>
    );
  },
);

/** Interruptor. El pulgar viaja con resorte; el riel cambia de color. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-150 ease-[var(--ease-standard)]',
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-surface-sunk',
          disabled && 'pointer-events-none opacity-45',
        )}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 520, damping: 32 }}
          className={cn(
            'absolute top-0.5 size-3.5 rounded-full shadow-sm',
            checked ? 'left-[18px] bg-on-accent' : 'left-0.5 bg-ink-muted',
          )}
        />
      </button>
      <label htmlFor={id} className="cursor-pointer text-base text-ink">
        {label}
      </label>
    </div>
  );
}
