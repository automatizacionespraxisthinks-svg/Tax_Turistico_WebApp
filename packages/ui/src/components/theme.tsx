import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { transition } from '../motion';
import { cn } from '../lib/cn';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'tax.theme';

function systemPrefersDark() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(mode: ThemeMode) {
  const dark = mode === 'dark' || (mode === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

/**
 * Tema claro / oscuro / del sistema.
 * El modo oscuro tiene sus propios pasos de color en tokens.css; no es una
 * inversión del claro.
 */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'system';
    return (window.localStorage.getItem(STORAGE_KEY) as ThemeMode | null) ?? 'system';
  });

  useEffect(() => {
    apply(mode);
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [mode]);

  const cycle = useCallback(() => {
    setMode((current) => (current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light'));
  }, []);

  return { mode, setMode, cycle };
}

const ICON = { light: Sun, dark: Moon, system: Monitor } as const;
const LABEL = { light: 'Tema claro', dark: 'Tema oscuro', system: 'Según el sistema' } as const;

/** Un solo botón que rota entre los tres modos; el icono se cruza al cambiar. */
export function ThemeToggle({ className }: { className?: string }) {
  const { mode, cycle } = useTheme();
  const Icon = ICON[mode];

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={LABEL[mode]}
      title={LABEL[mode]}
      className={cn(
        'relative inline-flex size-8 items-center justify-center overflow-hidden rounded-md',
        'text-ink-muted transition-colors duration-150 ease-[var(--ease-standard)]',
        'hover:bg-surface-sunk hover:text-ink',
        className,
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={mode}
          initial={{ opacity: 0, rotate: -40, scale: 0.8 }}
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={{ opacity: 0, rotate: 40, scale: 0.8 }}
          transition={transition.fast}
          className="absolute inset-0 flex items-center justify-center"
        >
          <Icon className="size-4" />
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
