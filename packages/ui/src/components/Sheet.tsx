import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { scrim, sheetRight } from '../motion';
import { cn } from '../lib/cn';
import { IconButton } from './Button';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  width?: 'md' | 'lg';
  children: ReactNode;
}

/**
 * Panel lateral. Se usa para el detalle de una carrera: el operador no pierde
 * de vista el tablero, y volver cuesta un clic o Escape.
 */
export function Sheet({ open, onClose, title, subtitle, actions, footer, width = 'md', children }: SheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          <motion.div
            variants={scrim}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={onClose}
            className="absolute inset-0 bg-overlay backdrop-blur-[1px]"
          />
          <motion.aside
            variants={sheetRight}
            initial="hidden"
            animate="visible"
            exit="exit"
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === 'string' ? title : 'Detalle'}
            className={cn(
              'relative flex h-full flex-col border-l border-line bg-surface shadow-lg',
              width === 'lg' ? 'w-full max-w-2xl' : 'w-full max-w-lg',
            )}
          >
            <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <h2 className="truncate text-title font-semibold text-ink">{title}</h2>
                {subtitle ? <div className="mt-1 text-caption text-ink-muted">{subtitle}</div> : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {actions}
                <IconButton label="Cerrar" variant="ghost" onClick={onClose} icon={<X className="size-4" />} />
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

            {footer ? (
              <footer className="border-t border-line bg-surface-sunk px-5 py-3">{footer}</footer>
            ) : null}
          </motion.aside>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
