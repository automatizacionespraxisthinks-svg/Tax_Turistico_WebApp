import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarDays, Check, ChevronDown, Search } from 'lucide-react';
import { MAX_DIAS_INFORME, diasDelRango, textoDelRango } from '@tax/shared';
import { Button, cn } from '@tax/ui';

/**
 * Los filtros de Reportes.
 *
 * Todos son el mismo botón con forma de píldora —«Sector: todos»— que abre su
 * lista debajo. Cuando un filtro está puesto, la píldora se tiñe de azul: de
 * un vistazo se sabe qué está recortando el tablero.
 */

/* --------------------------------------------------------- desplegable --- */

function Desplegable({
  etiqueta,
  resumen,
  activo,
  children,
  ancho = 'w-64',
  icono,
}: {
  etiqueta?: string;
  resumen: string;
  activo: boolean;
  children: (cerrar: () => void) => ReactNode;
  ancho?: string;
  icono?: ReactNode;
}) {
  const [abierto, setAbierto] = useState(false);
  // Una píldora cerca del borde derecho abre su lista hacia la izquierda:
  // si no, la lista se sale de la pantalla.
  const [alDerecho, setAlDerecho] = useState(false);
  const caja = useRef<HTMLDivElement>(null);
  const id = useId();

  const alternar = () => {
    const borde = caja.current?.getBoundingClientRect();
    if (borde) setAlDerecho(borde.left + 300 > window.innerWidth - 16);
    setAbierto((v) => !v);
  };

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (!caja.current?.contains(e.target as Node)) setAbierto(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAbierto(false);
    };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', fuera);
      document.removeEventListener('keydown', escape);
    };
  }, [abierto]);

  return (
    <div ref={caja} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={abierto}
        aria-controls={id}
        onClick={alternar}
        className={cn(
          'inline-flex h-8 max-w-72 items-center gap-1.5 rounded-md border px-3 text-caption font-medium',
          'transition-colors duration-150 ease-[var(--ease-standard)]',
          activo
            ? 'border-[var(--brand)] bg-accent-soft text-accent-ink'
            : 'border-line bg-surface text-ink hover:bg-surface-sunk',
        )}
      >
        {icono}
        <span className="truncate">
          {etiqueta ? `${etiqueta}: ` : ''}
          {resumen}
        </span>
        <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', abierto && 'rotate-180')} />
      </button>

      <AnimatePresence>
        {abierto ? (
          <motion.div
            id={id}
            role="dialog"
            aria-label={etiqueta ?? resumen}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className={cn(
              'absolute top-full z-30 mt-1.5 rounded-lg border border-line bg-surface-raised p-1.5 shadow-lg',
              alDerecho ? 'right-0' : 'left-0',
              ancho,
            )}
          >
            {children(() => setAbierto(false))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export interface OpcionDeFiltro<T extends string = string> {
  valor: T;
  texto: string;
  detalle?: string;
}

/** Con más de esto la lista trae buscador: buscar «101» es más rápido que bajar. */
const OPCIONES_PARA_BUSCAR = 8;

function Buscador({ valor, onCambiar }: { valor: string; onCambiar: (v: string) => void }) {
  return (
    <label className="mb-1 flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5">
      <Search className="size-3.5 shrink-0 text-ink-muted" />
      <input
        autoFocus
        value={valor}
        onChange={(e) => onCambiar(e.target.value)}
        placeholder="Buscar"
        className="min-w-0 flex-1 bg-transparent text-caption text-ink outline-none placeholder:text-ink-muted"
      />
    </label>
  );
}

const coincide = (o: OpcionDeFiltro, aguja: string) =>
  !aguja ||
  `${o.texto} ${o.detalle ?? ''}`
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .includes(aguja.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase());

function Fila({
  marcada,
  multiple,
  onClick,
  children,
  detalle,
}: {
  marcada: boolean;
  multiple?: boolean;
  onClick: () => void;
  children: ReactNode;
  detalle?: string;
}) {
  return (
    <button
      type="button"
      role={multiple ? 'menuitemcheckbox' : 'menuitemradio'}
      aria-checked={marcada}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-caption',
        'transition-colors duration-150 ease-[var(--ease-standard)] hover:bg-surface-sunk',
        marcada ? 'text-ink' : 'text-ink-secondary',
      )}
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center border',
          multiple ? 'rounded-xs' : 'rounded-full',
          marcada ? 'border-[var(--brand)] bg-brand text-on-accent' : 'border-line-strong bg-surface',
        )}
      >
        {marcada ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', marcada && 'font-semibold')}>{children}</span>
        {detalle ? <span className="block truncate text-micro text-ink-muted">{detalle}</span> : null}
      </span>
    </button>
  );
}

/** Un filtro de una sola opción. `undefined` es «todos». */
export function FiltroUnico<T extends string>({
  etiqueta,
  textoTodos,
  opciones,
  valor,
  onCambiar,
  sinEtiquetaCuandoTodos,
}: {
  etiqueta?: string;
  textoTodos: string;
  opciones: OpcionDeFiltro<T>[];
  valor: T | undefined;
  onCambiar: (v: T | undefined) => void;
  /** «Casco urbano y veredas» se lee solo; «Conductor: todos» necesita la etiqueta. */
  sinEtiquetaCuandoTodos?: boolean;
}) {
  const [aguja, setAguja] = useState('');
  const elegida = opciones.find((o) => o.valor === valor);
  const visibles = opciones.filter((o) => coincide(o, aguja));

  return (
    <Desplegable
      etiqueta={elegida || !sinEtiquetaCuandoTodos ? etiqueta : undefined}
      resumen={elegida?.texto ?? textoTodos}
      activo={Boolean(elegida)}
    >
      {(cerrar) => (
        <div role="menu" className="max-h-80 overflow-y-auto">
          {opciones.length > OPCIONES_PARA_BUSCAR ? <Buscador valor={aguja} onCambiar={setAguja} /> : null}
          {!aguja ? (
            <Fila
              marcada={!elegida}
              onClick={() => {
                onCambiar(undefined);
                cerrar();
              }}
            >
              {textoTodos}
            </Fila>
          ) : null}
          {visibles.map((o) => (
            <Fila
              key={o.valor}
              marcada={o.valor === valor}
              detalle={o.detalle}
              onClick={() => {
                onCambiar(o.valor);
                cerrar();
              }}
            >
              {o.texto}
            </Fila>
          ))}
          {visibles.length === 0 ? (
            <p className="px-2 py-2 text-caption text-ink-muted">Nada coincide con «{aguja}».</p>
          ) : null}
        </div>
      )}
    </Desplegable>
  );
}

/** Un filtro de varias opciones. La lista vacía es «todos». */
export function FiltroMultiple({
  etiqueta,
  textoTodos,
  opciones,
  valores,
  onCambiar,
}: {
  etiqueta: string;
  textoTodos: string;
  opciones: OpcionDeFiltro[];
  valores: string[];
  onCambiar: (v: string[]) => void;
}) {
  const [aguja, setAguja] = useState('');
  const elegidas = opciones.filter((o) => valores.includes(o.valor));
  const visibles = opciones.filter((o) => coincide(o, aguja));
  const resumen =
    elegidas.length === 0
      ? textoTodos
      : elegidas.length === 1
        ? elegidas[0]!.texto
        : `${elegidas[0]!.texto} y ${elegidas.length - 1} más`;

  const alternar = (valor: string) =>
    onCambiar(valores.includes(valor) ? valores.filter((v) => v !== valor) : [...valores, valor]);

  return (
    <Desplegable etiqueta={etiqueta} resumen={resumen} activo={elegidas.length > 0}>
      {() => (
        <div role="menu" className="max-h-80 overflow-y-auto">
          {opciones.length > OPCIONES_PARA_BUSCAR ? <Buscador valor={aguja} onCambiar={setAguja} /> : null}
          {!aguja ? (
            <Fila marcada={elegidas.length === 0} multiple onClick={() => onCambiar([])}>
              {textoTodos}
            </Fila>
          ) : null}
          {visibles.map((o) => (
            <Fila
              key={o.valor}
              multiple
              marcada={valores.includes(o.valor)}
              detalle={o.detalle}
              onClick={() => alternar(o.valor)}
            >
              {o.texto}
            </Fila>
          ))}
          {opciones.length === 0 ? (
            <p className="px-2 py-2 text-caption text-ink-muted">Todavía no hay opciones.</p>
          ) : null}
        </div>
      )}
    </Desplegable>
  );
}

/* ---------------------------------------------------------------- fechas --- */

/**
 * El periodo a mano. Dos fechas y «Aplicar»: cambiar el tablero con cada
 * clic del calendario lo recalcularía con periodos a medio elegir.
 */
export function RangoDeFechas({
  desde,
  hasta,
  hoy,
  onCambiar,
}: {
  desde: string;
  hasta: string;
  hoy: string;
  onCambiar: (rango: { desde: string; hasta: string }) => void;
}) {
  const [borrador, setBorrador] = useState({ desde, hasta });
  useEffect(() => setBorrador({ desde, hasta }), [desde, hasta]);

  const error =
    !borrador.desde || !borrador.hasta
      ? 'Elige las dos fechas.'
      : borrador.desde > borrador.hasta
        ? 'La fecha final va después de la inicial.'
        : diasDelRango(borrador.desde, borrador.hasta) > MAX_DIAS_INFORME
          ? `Hasta ${MAX_DIAS_INFORME} días por consulta.`
          : null;

  return (
    <Desplegable
      resumen={textoDelRango(desde, hasta)}
      activo={false}
      ancho="w-72"
      icono={<CalendarDays className="size-3.5 shrink-0 text-ink-muted" />}
    >
      {(cerrar) => (
        <form
          className="space-y-3 p-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (error) return;
            onCambiar(borrador);
            cerrar();
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            {(['desde', 'hasta'] as const).map((campo) => (
              <label key={campo} className="space-y-1">
                <span className="text-micro font-semibold uppercase tracking-[0.06em] text-ink-muted">
                  {campo === 'desde' ? 'Desde' : 'Hasta'}
                </span>
                <input
                  type="date"
                  value={borrador[campo]}
                  max={hoy}
                  onChange={(e) => setBorrador((b) => ({ ...b, [campo]: e.target.value }))}
                  className="h-8 w-full rounded-md border border-line bg-surface px-2 text-caption text-ink"
                />
              </label>
            ))}
          </div>
          <p className={cn('text-micro', error ? 'text-[var(--t-critical-ink)]' : 'text-ink-muted')}>
            {error ?? `${diasDelRango(borrador.desde, borrador.hasta)} días, en hora de Paipa.`}
          </p>
          <Button type="submit" size="sm" variant="primary" disabled={Boolean(error)} className="w-full">
            Aplicar
          </Button>
        </form>
      )}
    </Desplegable>
  );
}

/* --------------------------------------------------------------- casilla --- */

export function Casilla({
  marcada,
  onCambiar,
  children,
  title,
}: {
  marcada: boolean;
  onCambiar: (v: boolean) => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <label title={title} className="inline-flex cursor-pointer items-center gap-2 text-caption text-ink">
      <input
        type="checkbox"
        checked={marcada}
        onChange={(e) => onCambiar(e.target.checked)}
        className="size-4 accent-[var(--brand)]"
      />
      {children}
    </label>
  );
}
