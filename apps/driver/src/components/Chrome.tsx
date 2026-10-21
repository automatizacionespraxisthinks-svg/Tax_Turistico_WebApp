import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CloudOff, Signal } from 'lucide-react';
import { LiveDot, ThemeToggle, cn, transition } from '@tax/ui';

/**
 * Elementos fijos de la PWA.
 *
 * La barra superior es informativa y nunca interactiva salvo el tema: el
 * conductor no tiene que buscar nada ahí mientras conduce.
 */

export function TopStatus({
  online,
  queued,
  right,
  notice,
  onDismissNotice,
}: {
  online: boolean;
  queued: number;
  right?: ReactNode;
  /** Aviso puntual: oferta perdida, GPS denegado, acción guardada. */
  notice?: string;
  onDismissNotice?: () => void;
}) {
  // El aviso se va solo: el conductor está conduciendo y no puede quedarse
  // buscando dónde cerrarlo.
  useEffect(() => {
    if (!notice || !onDismissNotice) return;
    const id = window.setTimeout(onDismissNotice, 5000);
    return () => window.clearTimeout(id);
  }, [notice, onDismissNotice]);

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
      <span className="flex items-center gap-2 text-caption text-ink-secondary">
        <LiveDot tone={online ? 'positive' : 'critical'} live={online} />
        {online ? 'Conectado' : 'Sin conexión'}
      </span>

      <div className="flex items-center gap-2">
        {right}
        <ThemeToggle />
      </div>

      <AnimatePresence>
        {notice ? (
          <motion.button
            key="notice"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={transition.base}
            onClick={onDismissNotice}
            className="tone-warning absolute inset-x-0 top-12 z-30 bg-[var(--tone-bg)] px-4 py-2 text-left text-caption font-medium text-[var(--tone-ink)]"
          >
            {notice}
          </motion.button>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {!online || queued > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={transition.base}
            className={cn(
              'absolute inset-x-0 top-12 z-20 flex items-center justify-center gap-2 px-4 py-2 text-caption font-medium',
              online
                ? 'tone-info bg-[var(--tone-bg)] text-[var(--tone-ink)]'
                : 'tone-warning bg-[var(--tone-bg)] text-[var(--tone-ink)]',
            )}
          >
            {online ? <Signal className="size-3.5" /> : <CloudOff className="size-3.5" />}
            {online
              ? `Enviando ${queued} ${queued === 1 ? 'acción guardada' : 'acciones guardadas'}…`
              : queued === 0
                ? 'Sin conexión · lo que marques se envía al reconectar'
                : `Sin conexión · ${queued} ${queued === 1 ? 'acción guardada' : 'acciones guardadas'}`}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}

/** Contenedor de pantalla: una sola columna, respiro inferior para el pulgar. */
export function Screen({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-6',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Zona de acciones fija al fondo: siempre en el mismo sitio, siempre a 64 px. */
export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="shrink-0 space-y-2.5 border-t border-line px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
      {children}
    </div>
  );
}

/** Dirección: el dato más grande de la pantalla, legible de un vistazo. */
export function AddressBlock({
  label,
  text,
  reference,
  tone = 'accent',
}: {
  label: string;
  text: string;
  reference?: string;
  tone?: 'accent' | 'neutral';
}) {
  return (
    <div>
      <p className="text-micro font-semibold uppercase tracking-[0.07em] text-ink-muted">{label}</p>
      <p
        className={cn(
          'mt-1 text-[1.5rem] font-semibold leading-tight tracking-[-0.015em]',
          tone === 'accent' ? 'text-ink' : 'text-ink-secondary',
        )}
      >
        {text}
      </p>
      {reference ? <p className="mt-1.5 text-lg leading-snug text-ink-secondary">{reference}</p> : null}
    </div>
  );
}

export function DataRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-2.5 last:border-0">
      <span className="text-base text-ink-muted">{label}</span>
      <span className="text-lg font-medium text-ink">{value}</span>
    </div>
  );
}
