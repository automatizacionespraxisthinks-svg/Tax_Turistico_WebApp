import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { animate, useReducedMotion } from 'motion/react';
import type { StatusTone } from '@tax/shared';
import { duration, ease } from '../motion';
import { cn } from '../lib/cn';
import { TONE_CLASS } from './StatusPill';

/**
 * Número que transita al cambiar en vez de saltar.
 * En un panel en vivo el salto se lee como un parpadeo; la transición dice
 * "esto subió" sin que el operador tenga que recordar el valor anterior.
 */
export function AnimatedNumber({
  value,
  decimals = 0,
  suffix,
  className,
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  className?: string;
}) {
  const [shown, setShown] = useState(value);
  const previous = useRef(value);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      setShown(value);
      previous.current = value;
      return;
    }
    const controls = animate(previous.current, value, {
      duration: duration.deliberate,
      ease: ease.standard,
      onUpdate: (v) => setShown(v),
    });
    previous.current = value;
    return () => controls.stop();
  }, [value, reduced]);

  return (
    <span className={cn('tnum', className)}>
      {shown.toLocaleString('es-CO', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix ? <span className="text-ink-muted">{suffix}</span> : null}
    </span>
  );
}

export interface StatProps {
  label: string;
  value: number | string;
  /** Unidad pequeña junto al número: "min", "%", "s". */
  unit?: string;
  hint?: ReactNode;
  tone?: StatusTone;
  icon?: ReactNode;
  /** Serie para la mini-gráfica de contexto; sin ejes, solo la forma. */
  trend?: number[];
  className?: string;
}

/**
 * Ficha de indicador. Un número grande con su etiqueta; la mini-gráfica es
 * contexto, no un gráfico: sin ejes, sin marcas, sin leyenda.
 */
export function Stat({ label, value, unit, hint, tone = 'neutral', icon, trend, className }: StatProps) {
  return (
    <div
      className={cn(
        TONE_CLASS[tone],
        'group relative overflow-hidden rounded-lg border border-line bg-surface p-3.5',
        'transition-colors duration-150 ease-[var(--ease-standard)] hover:border-line-strong',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-micro font-semibold uppercase tracking-[0.06em] text-ink-muted">{label}</p>
        {icon ? <span className="text-ink-muted">{icon}</span> : null}
      </div>

      <div className="mt-2 flex items-baseline gap-1">
        <span
          className={cn(
            'text-display font-semibold tracking-[-0.02em]',
            tone === 'neutral' ? 'text-ink' : 'text-[var(--tone-ink)]',
          )}
        >
          {typeof value === 'number' ? (
            // Un indicador con decimal no se redondea: 99,7 % no es 100 %.
            <AnimatedNumber value={value} decimals={Number.isInteger(value) ? 0 : 1} />
          ) : (
            value
          )}
        </span>
        {unit ? <span className="text-sm font-medium text-ink-muted">{unit}</span> : null}
      </div>

      {hint ? <p className="mt-1 text-caption text-ink-muted">{hint}</p> : null}

      {trend && trend.length > 1 ? <Sparkline values={trend} /> : null}
    </div>
  );
}

/** Línea de 2 px sin ejes: forma de la última hora, no un gráfico consultable. */
function Sparkline({ values }: { values: number[] }) {
  const width = 100;
  const height = 22;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);

  const points = values.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / span) * (height - 3) - 1.5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg
      className="mt-2.5 h-5.5 w-full text-[var(--tone-solid)]"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        opacity="0.75"
      />
    </svg>
  );
}
