import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Table2 } from 'lucide-react';
import { cn } from '@tax/ui';

/**
 * Gráficas del panel.
 *
 * Reglas que cumplen todas:
 *  - Un solo eje de valor. Dos medidas de escala distinta van en dos gráficas.
 *  - Los colores de serie salen del orden fijo --c-series-*, nunca ciclado:
 *    azul de marca, verde y ámbar. El rojo no entra en el orden; lo pide a
 *    mano la serie que mide algo fuera de objetivo, como el p95.
 *  - Con dos o más series siempre hay leyenda, y además etiqueta directa
 *    cuando caben: la identidad nunca depende solo del color.
 *  - Toda gráfica trae capa de interacción y una vista de tabla equivalente.
 *  - Marcas finas, rejilla en --grid, línea base en tinta, etiquetas de eje
 *    en --muted (nunca el color de la serie) y 2 px de separación entre
 *    segmentos apilados.
 */

const SERIES = ['var(--c-series-1)', 'var(--c-series-2)', 'var(--c-series-3)'];

/** Rejilla discreta y línea base en tinta (HU-UI-01). */
const gridStroke = (ratio: number) => (ratio === 0 ? 'var(--ink)' : 'var(--grid)');

/* ------------------------------------------------------------------- marco */

export function ChartFrame({
  title,
  subtitle,
  legend,
  table,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  legend?: { label: string; color: string }[];
  table: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [showTable, setShowTable] = useState(false);

  return (
    <section className={cn('rounded-lg border border-transparent bg-surface p-4 shadow-sm', className)}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-caption text-ink-muted">{subtitle}</p> : null}
        </div>
        <button
          onClick={() => setShowTable((v) => !v)}
          aria-pressed={showTable}
          title={showTable ? 'Ver gráfica' : 'Ver los datos en tabla'}
          className={cn(
            'inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-line',
            'transition-colors duration-150 ease-[var(--ease-standard)]',
            showTable ? 'bg-accent-soft text-accent-ink' : 'text-ink-muted hover:bg-surface-sunk hover:text-ink',
          )}
        >
          <Table2 className="size-3.5" />
        </button>
      </header>

      {legend && legend.length > 1 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          {legend.map((item) => (
            <span key={item.label} className="flex items-center gap-1.5 text-caption text-ink-secondary">
              <span className="size-2.5 rounded-xs" style={{ backgroundColor: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      ) : null}

      <div className="relative mt-3">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={showTable ? 'table' : 'chart'}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {showTable ? <div className="max-h-64 overflow-y-auto">{table}</div> : children}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

export function DataTable({
  head,
  rows,
}: {
  head: string[];
  rows: (string | number)[][];
}) {
  return (
    <table className="w-full text-left text-caption">
      <thead className="sticky top-0 bg-surface">
        <tr className="border-b border-line text-micro uppercase tracking-[0.06em] text-ink-muted">
          {head.map((cell, i) => (
            <th key={cell} className={cn('py-1.5 font-medium', i > 0 && 'text-right')}>
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={String(row[0])} className="border-b border-line last:border-0">
            {row.map((cell, i) => (
              <td key={i} className={cn('py-1.5 text-ink', i > 0 && 'text-right tnum')}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------- barras apiladas --- */

/** Extremo del dato redondeado 4 px; la base queda anclada al eje. */
function barPath(x: number, y: number, width: number, height: number, round: boolean): string {
  const r = round ? Math.min(4, width / 2, height) : 0;
  if (height <= 0) return '';
  return `M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`;
}

export interface StackedBarDatum {
  label: string;
  values: number[];
}

export function StackedBars({
  data,
  series,
  colors = SERIES,
  height = 200,
  formatValue = (v: number) => String(v),
}: {
  data: StackedBarDatum[];
  series: string[];
  /**
   * Colores propios en vez del orden de serie, cuando cada serie es un
   * estado: terminadas en verde, sin taxi en rojo. El color sigue al estado,
   * nunca a la posición.
   */
  colors?: string[];
  height?: number;
  formatValue?: (value: number) => string;
}) {
  const cadaCuanto = cadaCuantasEtiquetas(data.length);
  const [hover, setHover] = useState<number | null>(null);
  const width = 640;
  const padding = { top: 12, right: 8, bottom: 22, left: 30 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const totals = data.map((d) => d.values.reduce((sum, v) => sum + v, 0));
  const max = niceMax(Math.max(...totals));
  const step = plotWidth / data.length;
  const barWidth = Math.min(26, step * 0.62);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img">
        {/* Rejilla discreta: tres referencias con números redondos. */}
        {[0, 0.5, 1].map((ratio) => {
          const y = padding.top + plotHeight * (1 - ratio);
          return (
            <g key={ratio}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={y}
                y2={y}
                stroke={gridStroke(ratio)}
                strokeWidth="1"
              />
              <text
                x={padding.left - 6}
                y={y + 3.5}
                textAnchor="end"
                className="fill-[var(--c-ink-muted)] text-[10px]"
              >
                {Math.round(max * ratio)}
              </text>
            </g>
          );
        })}

        {data.map((datum, index) => {
          const x = padding.left + index * step + (step - barWidth) / 2;
          let cursor = padding.top + plotHeight;

          return (
            <g
              key={datum.label}
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(null)}
            >
              {/* Zona sensible más ancha que la barra. */}
              <rect
                x={padding.left + index * step}
                y={padding.top}
                width={step}
                height={plotHeight}
                fill={hover === index ? 'var(--c-surface-sunk)' : 'transparent'}
              />

              {datum.values.map((value, seriesIndex) => {
                const raw = (value / max) * plotHeight;
                // 2 px de separación entre segmentos para que no se fundan.
                const segmentHeight = Math.max(0, raw - (seriesIndex > 0 ? 2 : 0));
                cursor -= raw;
                const isTop = seriesIndex === datum.values.length - 1;

                return (
                  <motion.path
                    key={seriesIndex}
                    initial={{ opacity: 0, scaleY: 0 }}
                    animate={{ opacity: 1, scaleY: 1 }}
                    transition={{ duration: 0.38, delay: index * 0.012, ease: [0.05, 0.7, 0.1, 1] }}
                    style={{ transformOrigin: `center ${padding.top + plotHeight}px` }}
                    d={barPath(x, cursor + (seriesIndex > 0 ? 2 : 0), barWidth, segmentHeight, isTop)}
                    fill={colors[seriesIndex]}
                    opacity={hover === null || hover === index ? 1 : 0.45}
                  />
                );
              })}

              {index % cadaCuanto === 0 ? (
                <text
                  x={padding.left + index * step + step / 2}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-[var(--c-ink-muted)] text-[10px]"
                >
                  {datum.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      <Tooltip
        visible={hover !== null}
        x={hover !== null ? ((padding.left + hover * step + step / 2) / width) * 100 : 0}
      >
        {hover !== null ? (
          <>
            <p className="text-caption font-medium text-ink">{data[hover]?.label}</p>
            {series.map((name, i) => (
              <p key={name} className="flex items-center gap-1.5 text-micro text-ink-secondary">
                <span className="size-2 rounded-xs" style={{ backgroundColor: colors[i] }} />
                {name}
                <span className="ml-auto tnum font-medium text-ink">
                  {formatValue(data[hover]?.values[i] ?? 0)}
                </span>
              </p>
            ))}
          </>
        ) : null}
      </Tooltip>
    </div>
  );
}

/* --------------------------------------------------------------- líneas --- */

export interface LineSeries {
  name: string;
  values: number[];
  /** Color propio en vez del que toca por orden: el rojo del p95. */
  color?: string;
  /** Punto fijo en el valor más alto: dónde se fue el p95. */
  markMax?: boolean;
  /** Relleno bajo la línea, del color que se indique. */
  area?: string;
}

export function Lines({
  labels,
  series,
  height = 200,
  unit = '',
}: {
  labels: string[];
  series: LineSeries[];
  height?: number;
  unit?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useId();
  const width = 640;
  const padding = { top: 14, right: 46, bottom: 22, left: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const max = niceMax(Math.max(...series.flatMap((s) => s.values)));
  const step = labels.length > 1 ? plotWidth / (labels.length - 1) : 0;
  const cadaCuanto = cadaCuantasEtiquetas(labels.length);

  const pointAt = (index: number, value: number) => ({
    x: padding.left + index * step,
    y: padding.top + plotHeight * (1 - value / max),
  });

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        onMouseLeave={() => setHover(null)}
      >
        <clipPath id={clipId}>
          <rect x={padding.left} y={0} width={plotWidth} height={height} />
        </clipPath>

        {[0, 0.5, 1].map((ratio) => {
          const y = padding.top + plotHeight * (1 - ratio);
          return (
            <g key={ratio}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={y}
                y2={y}
                stroke={gridStroke(ratio)}
                strokeWidth="1"
              />
              <text
                x={padding.left - 6}
                y={y + 3.5}
                textAnchor="end"
                className="fill-[var(--c-ink-muted)] text-[10px]"
              >
                {Math.round(max * ratio)}
              </text>
            </g>
          );
        })}

        {/* Cruz vertical bajo el puntero */}
        {hover !== null ? (
          <line
            x1={padding.left + hover * step}
            x2={padding.left + hover * step}
            y1={padding.top}
            y2={padding.top + plotHeight}
            stroke="var(--c-line-strong)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        ) : null}

        {series.map((line, seriesIndex) => {
          const points = line.values.map((value, index) => pointAt(index, value));
          const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
          const last = points[points.length - 1];
          const color = line.color ?? SERIES[seriesIndex];
          const maxIndex = line.values.indexOf(Math.max(...line.values));
          const base = padding.top + plotHeight;

          return (
            <g key={line.name}>
              <g clipPath={`url(#${clipId})`}>
                {line.area && points.length > 1 ? (
                  <motion.path
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.56, ease: [0.05, 0.7, 0.1, 1] }}
                    d={`${d} L${last!.x},${base} L${points[0]!.x},${base} Z`}
                    fill={line.area}
                  />
                ) : null}
                <motion.path
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.56, ease: [0.05, 0.7, 0.1, 1] }}
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {line.markMax && points[maxIndex] ? (
                  <circle
                    cx={points[maxIndex]!.x}
                    cy={points[maxIndex]!.y}
                    r="4"
                    fill={color}
                    stroke="var(--c-surface)"
                    strokeWidth="2"
                  />
                ) : null}
                {hover !== null && points[hover] ? (
                  <circle
                    cx={points[hover]!.x}
                    cy={points[hover]!.y}
                    r="4.5"
                    fill={color}
                    stroke="var(--c-surface)"
                    strokeWidth="2"
                  />
                ) : null}
              </g>

              {/* Etiqueta directa al final, fuera del recorte: con dos o más
                  series la identidad no depende solo del color. */}
              {last && series.length > 1 ? (
                <text
                  x={last.x + 8}
                  y={last.y + 3.5}
                  className="fill-[var(--c-ink-secondary)] text-[10px] font-medium"
                >
                  {line.name}
                </text>
              ) : null}
            </g>
          );
        })}

        {labels.map((label, index) => (
          <g key={label}>
            <rect
              x={padding.left + index * step - step / 2}
              y={padding.top}
              width={step || plotWidth}
              height={plotHeight}
              fill="transparent"
              onMouseEnter={() => setHover(index)}
            />
            {index % cadaCuanto === 0 ? (
              <text
                x={padding.left + index * step}
                y={height - 6}
                textAnchor="middle"
                className="fill-[var(--c-ink-muted)] text-[10px]"
              >
                {label}
              </text>
            ) : null}
          </g>
        ))}
      </svg>

      <Tooltip
        visible={hover !== null}
        x={hover !== null ? ((padding.left + hover * step) / width) * 100 : 0}
      >
        {hover !== null ? (
          <>
            <p className="text-caption font-medium text-ink">{labels[hover]}</p>
            {series.map((line, i) => (
              <p key={line.name} className="flex items-center gap-1.5 text-micro text-ink-secondary">
                <span className="size-2 rounded-xs" style={{ backgroundColor: line.color ?? SERIES[i] }} />
                {line.name}
                <span className="ml-auto tnum font-medium text-ink">
                  {line.values[hover]}
                  {unit}
                </span>
              </p>
            ))}
          </>
        ) : null}
      </Tooltip>
    </div>
  );
}

/* ------------------------------------------------- barras horizontales --- */

export function HorizontalBars({
  data,
  formatValue = (v: number) => String(v),
  color = 'var(--c-series-1)',
}: {
  /** `rural`: la pista va en tinte verde, para leer de un vistazo qué es vereda. */
  data: { label: string; value: number; hint?: string; rural?: boolean }[];
  formatValue?: (value: number) => string;
  color?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));

  return (
    <ul className="space-y-2">
      {data.map((item, index) => (
        <li key={item.label} className="group">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-caption text-ink">{item.label}</span>
            <span className="tnum shrink-0 text-caption font-medium text-ink">
              {formatValue(item.value)}
            </span>
          </div>
          <div
            className={cn(
              'mt-1 h-2 overflow-hidden rounded-full',
              item.rural ? 'bg-success-tint' : 'bg-surface-sunk',
            )}
          >
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${(item.value / max) * 100}%` }}
              transition={{ duration: 0.38, delay: index * 0.028, ease: [0.05, 0.7, 0.1, 1] }}
              className="h-full rounded-full"
              style={{ backgroundColor: color }}
            />
          </div>
          {item.hint ? <p className="mt-0.5 text-micro text-ink-muted">{item.hint}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------- mapa de calor --- */

/**
 * Carreras por día de la semana y hora: dónde se llena el servicio.
 *
 * Un solo tono, de claro a oscuro, y la celda vacía en el gris de fondo: un
 * cero no se confunde con «poco». Las horas de la madrugada sin ninguna
 * carrera en todo el periodo se recortan, para que el resto respire.
 */
export function MapaDeCalor({ dias, valores }: { dias: string[]; valores: number[][] }) {
  const [hover, setHover] = useState<{ dia: number; hora: number } | null>(null);
  const max = Math.max(1, ...valores.flat());
  const conCarreras = Array.from({ length: 24 }, (_, h) => valores.some((fila) => (fila[h] ?? 0) > 0));
  const primera = Math.min(6, Math.max(0, conCarreras.indexOf(true)));
  const horas = Array.from({ length: 24 - primera }, (_, i) => primera + i);

  const fondo = (v: number) =>
    v === 0
      ? 'var(--c-surface-sunk)'
      : `color-mix(in srgb, var(--brand) ${Math.round(18 + (v / max) * 82)}%, var(--surface))`;

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <div
        className="grid gap-[2px]"
        style={{ gridTemplateColumns: `2.25rem repeat(${horas.length}, minmax(0, 1fr))` }}
      >
        {dias.map((dia, d) => (
          <div key={dia} className="contents">
            <span className="self-center text-micro text-ink-muted">{dia}</span>
            {horas.map((h) => {
              const v = valores[d]?.[h] ?? 0;
              const activa = hover?.dia === d && hover.hora === h;
              return (
                <span
                  key={h}
                  onMouseEnter={() => setHover({ dia: d, hora: h })}
                  className={cn('h-6 rounded-xs', activa && 'ring-2 ring-[var(--ink)] ring-offset-1')}
                  style={{ backgroundColor: fondo(v) }}
                />
              );
            })}
          </div>
        ))}
        <span />
        {horas.map((h) => (
          <span key={h} className="pt-1 text-center text-[10px] text-ink-muted">
            {h % 3 === 0 ? h : ''}
          </span>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-end gap-1.5 text-micro text-ink-muted">
        Menos
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <span key={p} className="size-3 rounded-xs" style={{ backgroundColor: fondo(p * max) }} />
        ))}
        Más
      </div>

      <Tooltip visible={hover !== null} x={hover ? ((hover.hora - primera + 1) / (horas.length + 1)) * 100 : 0}>
        {hover ? (
          <>
            <p className="text-caption font-medium text-ink">
              {dias[hover.dia]} · {hover.hora}:00 a {hover.hora + 1}:00
            </p>
            <p className="text-micro text-ink-secondary">
              <span className="tnum font-medium text-ink">{valores[hover.dia]?.[hover.hora] ?? 0}</span> carreras
            </p>
          </>
        ) : null}
      </Tooltip>
    </div>
  );
}

/* ------------------------------------------------------------------ apoyo --- */

function Tooltip({ visible, x, children }: { visible: boolean; x: number; children: ReactNode }) {
  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.12 }}
          style={{ left: `${Math.min(84, Math.max(2, x))}%` }}
          className="pointer-events-none absolute top-0 min-w-36 -translate-x-1/2 rounded-md border border-line bg-surface-raised px-2.5 py-1.5 shadow-md"
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Con muchos días, una etiqueta de cada tantas: doce caben sin pisarse. */
function cadaCuantasEtiquetas(total: number): number {
  return Math.max(1, Math.ceil(total / 12));
}

/**
 * Techo del eje en un número redondo (1, 2, 5 × 10^n) para que las
 * referencias se lean solas: 0 / 25 / 50, nunca 0 / 11 / 23 / 34 / 45.
 */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}
