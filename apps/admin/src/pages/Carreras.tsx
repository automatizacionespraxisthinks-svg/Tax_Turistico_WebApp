import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { Download, Search, SlidersHorizontal } from 'lucide-react';
import type { RideStatus } from '@tax/shared';
import {
  RIDE_STATUSES,
  RIDE_STATUS_LABEL,
  RIDE_STATUS_TONE,
  formatRelative,
  formatTime,
} from '@tax/shared';
import {
  Button,
  Card,
  EmptyState,
  Input,
  Segmented,
  Sheet,
  StatusPill,
  cn,
  transition,
} from '@tax/ui';
import { useExportar } from '../api/exportaciones';
import { usePuede } from '../api/queries';
import { RideDetail } from '../components/RideDetail';
import { useLive } from '../live/store';

type Filter = 'activas' | 'todas' | 'sin-asignar' | 'finalizadas' | 'canceladas';

const FILTERS: { value: Filter; label: string; match: (status: RideStatus) => boolean }[] = [
  {
    value: 'activas',
    label: 'Activas',
    match: (s) => s !== 'COMPLETED' && s !== 'CANCELLED',
  },
  { value: 'sin-asignar', label: 'Sin asignar', match: (s) => s === 'UNASSIGNED' },
  { value: 'finalizadas', label: 'Finalizadas', match: (s) => s === 'COMPLETED' },
  { value: 'canceladas', label: 'Canceladas', match: (s) => s === 'CANCELLED' },
  { value: 'todas', label: 'Todas', match: () => true },
];

export function Carreras() {
  const { rideId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { exportar, generando } = useExportar();
  const puedeExportar = usePuede()('reportes.exportar');

  const rides = useLive((s) => s.rides);
  const drivers = useLive((s) => s.drivers);
  const pulseRideId = useLive((s) => s.pulseRideId);

  /*
   * Los filtros viven en la dirección (`?estado=canceladas&zona=…`), no en
   * el estado del componente: sobreviven a abrir y cerrar una ficha, a
   * recargar la página y al botón de atrás. Revisar las canceladas una por
   * una no puede obligar a volver a elegir «Canceladas» cada vez.
   */
  const [params, setParams] = useSearchParams();
  const estado = params.get('estado');
  const filter: Filter = FILTERS.some((f) => f.value === estado) ? (estado as Filter) : 'activas';
  const query = params.get('q') ?? '';
  const zoneId = params.get('zona') ?? '';

  const cambiarFiltro = (clave: 'estado' | 'q' | 'zona', valor: string, porDefecto = '') => {
    setParams(
      (previos) => {
        const siguientes = new URLSearchParams(previos);
        if (!valor || valor === porDefecto) siguientes.delete(clave);
        else siguientes.set(clave, valor);
        return siguientes;
      },
      // Escribir en el buscador no llena el historial de pasos de atrás.
      { replace: true },
    );
  };
  const setFilter = (valor: Filter) => cambiarFiltro('estado', valor, 'activas');
  const setQuery = (valor: string) => cambiarFiltro('q', valor);
  const setZoneId = (valor: string) => cambiarFiltro('zona', valor);
  const zones = useLive((s) => s.zones);

  const active = FILTERS.find((f) => f.value === filter) ?? FILTERS[0]!;

  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((f) => [f.value, rides.filter((r) => f.match(r.status)).length]),
      ) as Record<Filter, number>,
    [rides],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rides.filter((ride) => {
      if (!active.match(ride.status)) return false;
      if (zoneId && ride.zoneId !== zoneId) return false;
      if (!needle) return true;
      return (
        ride.code.toLowerCase().includes(needle) ||
        ride.customerName.toLowerCase().includes(needle) ||
        ride.customerPhone.includes(needle) ||
        ride.pickup.text.toLowerCase().includes(needle)
      );
    });
  }, [rides, active, zoneId, query]);

  const selected = rides.find((r) => r.id === rideId) ?? null;

  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({ value: f.value, label: f.label, count: counts[f.value] }))}
        />

        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Código, cliente, teléfono o dirección…"
            className="pl-8"
            aria-label="Buscar carreras"
          />
        </div>

        <select
          value={zoneId}
          onChange={(e) => setZoneId(e.target.value)}
          aria-label="Filtrar por zona"
          className="h-9 cursor-pointer rounded-md border border-line bg-surface px-2.5 text-base text-ink transition-colors duration-150 hover:border-line-strong"
        >
          <option value="">Todas las zonas</option>
          {zones.map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zone.name}
            </option>
          ))}
        </select>

        {/* Lo que se está viendo: el mismo estado, zona y búsqueda, de los
            últimos 30 días. La lista de arriba solo trae las 300 más recientes. */}
        {puedeExportar ? (
          <Button
            icon={<Download className="size-3.5" />}
            loading={generando('carreras-xlsx')}
            title="Excel con las carreras de los últimos 30 días que cumplen estos filtros"
            onClick={() =>
              void exportar({
                kind: 'carreras',
                format: 'xlsx',
                days: 30,
                statuses: filter === 'todas' ? undefined : RIDE_STATUSES.filter((s) => active.match(s)),
                zoneId: zoneId || undefined,
                query: query.trim() || undefined,
                filterLabel: filter === 'todas' ? undefined : active.label,
              })
            }
          >
            Exportar
          </Button>
        ) : null}
      </div>

      <Card flush className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-line text-micro uppercase tracking-[0.06em] text-ink-muted">
                <Th className="pl-4">Código</Th>
                <Th>Estado</Th>
                <Th>Recogida</Th>
                <Th>Cliente</Th>
                <Th>Conductor</Th>
                <Th className="pr-4 text-right">Creada</Th>
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {rows.map((ride) => {
                  const driver = drivers.find((d) => d.id === ride.driverId);
                  return (
                    <motion.tr
                      key={ride.id}
                      layout
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={transition.fast}
                      onClick={() =>
                        navigate({ pathname: `/carreras/${ride.id}`, search: location.search })
                      }
                      className={cn(
                        'cursor-pointer border-b border-line last:border-0',
                        'transition-colors duration-150 ease-[var(--ease-standard)] hover:bg-surface-sunk',
                        ride.id === pulseRideId && 'animate-flash',
                      )}
                    >
                      <Td className="pl-4 font-mono text-caption text-ink-secondary">{ride.code}</Td>
                      <Td>
                        <StatusPill tone={RIDE_STATUS_TONE[ride.status]} live={ride.status === 'NOTIFIED'}>
                          {RIDE_STATUS_LABEL[ride.status]}
                        </StatusPill>
                      </Td>
                      <Td className="max-w-56 truncate text-ink">{ride.pickup.text}</Td>
                      <Td className="text-ink-secondary">{ride.customerName}</Td>
                      <Td className="text-ink-secondary">
                        {driver ? `${driver.code} · ${driver.vehicle.plate}` : <Dash />}
                      </Td>
                      <Td className="pr-4 text-right text-ink-muted">
                        <time title={formatTime(ride.createdAt)}>{formatRelative(ride.createdAt)}</time>
                      </Td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            </tbody>
          </table>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={<SlidersHorizontal className="size-4" />}
            title="Ninguna carrera coincide"
            description="Prueba con otro estado, otra zona o limpia la búsqueda."
            action={
              <Button
                onClick={() => setParams({ estado: 'todas' }, { replace: true })}
              >
                Limpiar filtros
              </Button>
            }
          />
        ) : (
          <p className="border-t border-line px-4 py-2 text-micro text-ink-muted">
            {rows.length} {rows.length === 1 ? 'carrera' : 'carreras'}
          </p>
        )}
      </Card>

      <Sheet
        open={selected !== null}
        onClose={() => navigate({ pathname: '/carreras', search: location.search })}
        title={selected?.code ?? ''}
        subtitle={
          selected ? `${selected.customerName} · creada ${formatRelative(selected.createdAt)}` : undefined
        }
        width="lg"
      >
        {selected ? <RideDetail ride={selected} /> : null}
      </Sheet>
    </div>
  );
}

function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cn('px-3 py-2 font-medium', className)}>{children}</th>;
}

function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn('px-3 py-2.5 text-base', className)}>{children}</td>;
}

function Dash() {
  return <span className="text-ink-muted">—</span>;
}
