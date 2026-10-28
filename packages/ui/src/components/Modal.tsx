import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { scrim, transition } from '../motion';
import { cn } from '../lib/cn';
import { IconButton } from './Button';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  footer?: ReactNode;
  /** `lg` deja sitio a un mapa al lado del formulario. */
  width?: 'md' | 'lg';
  children: ReactNode;
}

/**
 * Ventana sobre la vista, con la vista de fondo desenfocada.
 *
 * Para formularios cortos que no merecen otra página: crear una zona, un
 * lugar. El desenfoque dice «esto está encima, lo de atrás sigue ahí», y
 * Escape o un clic fuera lo cierran sin perder nada de la vista.
 */
export function Modal({ open, onClose, title, subtitle, footer, width = 'md', children }: ModalProps) {
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <motion.div
            variants={scrim}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={onClose}
            className="absolute inset-0 bg-overlay backdrop-blur-[6px]"
          />
          <motion.section
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: transition.enter }}
            exit={{ opacity: 0, y: 8, scale: 0.98, transition: transition.exit }}
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === 'string' ? title : 'Formulario'}
            className={cn(
              'relative flex max-h-full w-full flex-col overflow-hidden rounded-xl bg-surface shadow-lg',
              width === 'lg' ? 'max-w-4xl' : 'max-w-lg',
            )}
          >
            <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <h2 className="truncate text-title font-semibold text-ink">{title}</h2>
                {subtitle ? <div className="mt-1 text-caption text-ink-muted">{subtitle}</div> : null}
              </div>
              <IconButton label="Cerrar" variant="ghost" onClick={onClose} icon={<X className="size-4" />} />
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

            {footer ? (
              <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-sunk px-5 py-3">
                {footer}
              </footer>
            ) : null}
          </motion.section>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
