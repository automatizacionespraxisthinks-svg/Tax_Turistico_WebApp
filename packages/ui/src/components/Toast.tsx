import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert, X } from 'lucide-react';
import type { StatusTone } from '@tax/shared';
import { spring, transition } from '../motion';
import { cn } from '../lib/cn';
import { TONE_CLASS } from './StatusPill';

export interface Toast {
  id: number;
  tone: Extract<StatusTone, 'info' | 'positive' | 'warning' | 'critical'>;
  title: string;
  description?: string;
  /** Acción opcional; cerrar el aviso no debe ser la única salida. */
  action?: { label: string; onClick: () => void };
}

type ToastInput = Omit<Toast, 'id'>;

const ToastContext = createContext<{ push: (toast: ToastInput) => void } | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast debe usarse dentro de <ToastProvider>');
  return ctx;
}

const ICON = {
  info: Info,
  positive: CheckCircle2,
  warning: AlertTriangle,
  critical: OctagonAlert,
} as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { ...toast, id }]);
      // Lo crítico permanece hasta que alguien lo cierre.
      if (toast.tone !== 'critical') {
        window.setTimeout(() => dismiss(id), 5200);
      }
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => {
            const Icon = ICON[toast.tone];
            return (
              <motion.div
                key={toast.id}
                layout
                initial={{ opacity: 0, y: 12, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 16, scale: 0.98, transition: transition.exit }}
                transition={spring.gentle}
                className={cn(
                  TONE_CLASS[toast.tone],
                  'pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line bg-surface-raised p-3 shadow-lg',
                )}
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-[var(--tone-ink)]" />
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium text-ink">{toast.title}</p>
                  {toast.description ? (
                    <p className="mt-0.5 text-caption text-ink-secondary">{toast.description}</p>
                  ) : null}
                  {toast.action ? (
                    <button
                      onClick={() => {
                        toast.action?.onClick();
                        dismiss(toast.id);
                      }}
                      className="mt-1.5 text-caption font-medium text-accent-ink underline-offset-2 hover:underline"
                    >
                      {toast.action.label}
                    </button>
                  ) : null}
                </div>
                <button
                  onClick={() => dismiss(toast.id)}
                  aria-label="Cerrar aviso"
                  className="-m-1 shrink-0 rounded-sm p-1 text-ink-muted transition-colors duration-150 hover:text-ink"
                >
                  <X className="size-3.5" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
