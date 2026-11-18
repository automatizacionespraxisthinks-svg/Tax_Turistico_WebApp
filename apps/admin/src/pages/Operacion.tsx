import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bot, CarFront, Check, Inbox, Timer, TriangleAlert } from 'lucide-react';
import type { Ride, RideStatus } from '@tax/shared';
import { METAS, RIDE_STATUS_LABEL, RIDE_STATUS_TONE, diaEnPaipa, formatRelative } from '@tax/shared';
import {
  BANDA_DE_ESTADO,
  Button,
  Card,
  EmptyState,
  ProgressRing,
  Sheet,
  Stat,
  StatusPill,
  cn,
  staggerList,
  transition,
} from '@tax/ui';
import { MapCanvas } from '../components/MapCanvas';
import { RideCard } from '../components/RideCard';
import { RideDetail } from '../components/RideDetail';
import { actions, useLive } from '../live/store';
import { usePuede } from '../api/queries';
import { useCifrasRecientes } from '../api/informes';

/**
 * Columnas del tablero: el ciclo de vida leído de izquierda a derecha. Cada
 * una lleva una banda sólida con el color de su estado, el mismo que llevan
 * los botones de la PWA.
 */
const COLUMNS: { status: RideStatus; title: string; band: string }[] = [
  { status: 'NOTIFIED', title: 'Buscando taxi', band: BANDA_DE_ESTADO.NOTIFIED },
  { status: 'ASSIGNED', title: 'Taxi en camino', band: BANDA_DE_ESTADO.ASSIGNED },
  { status: 'DRIVER_ARRIVED', title: 'Taxi en el lugar', band: BANDA_DE_ESTADO.DRIVER_ARRIVED },
  { status: 'IN_PROGRESS', title: 'En curso', band: BANDA_DE_ESTADO.IN_PROGRESS },
];

/** Segundos legibles: «45 s», «2 min 10 s». */
function duracion(segundos: number): { valor: number; unidad: string } {
  return segundos < 120 ? { valor: Math.round(segundos), unidad: 's' } : { valor: Math.round(segundos / 60), unidad: 'min' };
}

/** Si la carrera se pidió hoy, en hora de Paipa. */
function esDeHoy(iso: string): boolean {
  return diaEnPaipa(new Date(iso)) === diaEnPaipa(new Date());
}

export function Operacion() {
  const rides = useLive((s) => s.rides);
  const drivers = useLive((s) => s.drivers);
  const pulseRideId = useLive((s) => s.pulseRideId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const live = useMemo(
    () => rides.filter((r) => r.status !== 'COMPLETED' && r.status !== 'CANCELLED'),
    [rides],
  );
  const unassigned = live.filter((r) => r.status === 'UNASSIGNED' || r.status === 'PENDING');
  const available = drivers.filter((d) => d.status === 'AVAILABLE').length;
  const onShift = drivers.filter((d) => d.status !== 'OFF_SHIFT').length;
  // La flota es la que está dada de alta y activa, no un número escrito a mano.
  const flota = drivers.filter((d) => d.active !== false).length;
  const selected = rides.find((r) => r.id === selectedId) ?? null;

  /*
   * Tiempo a asignación y sin intervención, de verdad (17/11/2026): antes
   * eran cifras de muestra fijas (23 s, p95 58 s, 83 %) con un objetivo
   * «< 3 s» que contradecía la meta de Reportes. Ahora salen del mismo
   * informe que Reportes, la cifra es la de hoy y la gráfica los últimos 7
   * días; las metas son las de `METAS`.
   */
  const puede = usePuede();
  const verCifras = puede('reportes.ver');
  const recientes = useCifrasRecientes(verCifras);
  const dias = recientes.data?.porDia ?? [];
  const hoy = dias.at(-1);
  const asignacion = hoy?.asignacionP50 != null ? duracion(hoy.asignacionP50) : null;
  const p95 = hoy?.asignacionP95 ?? null;
  const sinIntervencion = hoy?.sinIntervencion ?? null;
  const serie = (valores: (number | null)[]) => {
    const limpios = valores.filter((v): v is number => v != null);
    return limpios.length >= 2 ? limpios : undefined;
  };
  const sinDato = !verCifras ? 'Sin permiso para ver cifras' : recientes.isError ? 'No se pudieron cargar las cifras' : 'Sin carreras hoy todavía';

  return (
    <div className="space-y-4 p-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="Carreras activas"
          value={live.length}
          icon={<Inbox className="size-3.5" />}
          iconTone="info"
          hint={`${rides.filter((r) => esDeHoy(r.createdAt)).length} pedidas hoy`}
        />
        <Stat
          label="Sin asignar"
          value={live.filter((r) => r.status === 'UNASSIGNED').length}
          tone={live.some((r) => r.status === 'UNASSIGNED') ? 'critical' : 'positive'}
          icon={<TriangleAlert className="size-3.5" />}
          iconTone="critical"
          hint="Sin conductor tras todas las oleadas"
        />
        <Stat
          label="Conductores libres"
          value={available}
          tone="positive"
          icon={<CarFront className="size-3.5" />}
          iconTone="positive"
          hint={`${onShift} de ${flota} en turno`}
        />
        <Stat
          label="Tiempo a asignación"
          value={asignacion ? asignacion.valor : '—'}
          unit={asignacion?.unidad}
          tone={asignacion && hoy!.asignacionP50! > METAS.asignacionSegundos ? 'critical' : 'info'}
          icon={<Timer className="size-3.5" />}
          iconTone="info"
          hint={
            asignacion ? (
              <>
                Mediana de hoy
                {p95 != null ? (
                  <>
                    {' '}· p95{' '}
                    <span className={cn(p95 > METAS.asignacionSegundos && 'text-danger')}>
                      {duracion(p95).valor} {duracion(p95).unidad}
                    </span>
                  </>
                ) : null}{' '}
                · meta {METAS.asignacionSegundos} s
              </>
            ) : (
              sinDato
            )
          }
          trend={serie(dias.map((d) => d.asignacionP50))}
        />
        <Stat
          label="Sin intervención"
          value={sinIntervencion != null ? Math.round(sinIntervencion * 100) : '—'}
          unit={sinIntervencion != null ? '%' : undefined}
          tone={sinIntervencion == null ? 'neutral' : sinIntervencion >= METAS.sinIntervencion ? 'positive' : 'warning'}
          icon={<Bot className="size-3.5" />}
          iconTone="positive"
          hint={sinIntervencion != null ? `Hoy · meta ${Math.round(METAS.sinIntervencion * 100)} %` : sinDato}
          trend={serie(dias.map((d) => (d.sinIntervencion == null ? null : Math.round(d.sinIntervencion * 100))))}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <MapCanvas
          rides={live}
          selectedRideId={selectedId}
          onSelectRide={setSelectedId}
          className="h-[clamp(320px,44vh,540px)]"
        />
        <AttentionPanel rides={unassigned} onSelect={setSelectedId} selectedId={selectedId} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((column) => {
          const items = live.filter((r) => r.status === column.status);
          return (
            <Card key={column.status} flush className="flex min-h-40 flex-col overflow-hidden">
              {/* La banda cede 4 px de su relleno al hueco de debajo: así las
                  tarjetas no quedan pegadas al color y empiezan donde antes. */}
              <div
                className={cn('flex items-center justify-between gap-2 px-3 pb-1.5 pt-2', column.band)}
              >
                <p className="text-micro font-semibold uppercase tracking-[0.07em] text-on-accent">
                  {column.title}
                </p>
                <span className="tnum rounded-full bg-ink/25 px-1.5 text-micro font-semibold text-on-accent">
                  {items.length}
                </span>
              </div>

              <motion.div
                variants={staggerList(items.length)}
                initial="hidden"
                animate="visible"
                className="flex-1 space-y-2 px-2 pb-2 pt-1"
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  {items.map((ride) => (
                    <RideCard
                      key={ride.id}
                      ride={ride}
                      driver={drivers.find((d) => d.id === ride.driverId)}
                      selected={ride.id === selectedId}
                      pulse={ride.id === pulseRideId}
                      onClick={() => setSelectedId(ride.id)}
                    />
                  ))}
                </AnimatePresence>

                {items.length === 0 ? (
                  <p className="px-1 py-6 text-center text-caption text-ink-muted">
                    Sin carreras en este estado
                  </p>
                ) : null}
              </motion.div>
            </Card>
          );
        })}
      </div>

      <Sheet
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        title={selected?.code ?? ''}
        subtitle={
          selected ? `${selected.customerName} · creada ${formatRelative(selected.createdAt)}` : undefined
        }
      >
        {selected ? <RideDetail ride={selected} /> : null}
      </Sheet>
    </div>
  );
}

/* ------------------------------------------------------- requieren atención */

function AttentionPanel({
  rides,
  onSelect,
  selectedId,
}: {
  rides: Ride[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  // Suscribirse al pulso de un segundo mantiene vivos los aros de cuenta atrás.
  useLive((s) => s.tick);
  const puedeRelanzar = usePuede()('carreras.despachar');

  return (
    <Card flush className="flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-transparent bg-ink px-3.5 py-2.5">
        <div>
          <h2 className="text-base font-semibold text-on-ink">Requieren atención</h2>
          <p className="text-micro text-on-ink-muted">Sin conductor o esperando la primera oleada</p>
        </div>
        <span className="tnum rounded-full bg-on-ink/15 px-2 py-0.5 text-micro font-semibold text-on-ink">
          {rides.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence initial={false} mode="popLayout">
          {rides.map((ride) => {
            const elapsed = (Date.now() - new Date(ride.createdAt).getTime()) / 1000;
            // El aro se vacía sobre la ventana de 5 min del objetivo de servicio.
            const progress = Math.max(0, 1 - elapsed / 300);
            const tone = RIDE_STATUS_TONE[ride.status];

            return (
              <motion.div
                key={ride.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 12 }}
                transition={transition.base}
                className={cn(
                  'flex items-center gap-3 border-b border-line px-3.5 py-3',
                  'transition-colors duration-150 ease-[var(--ease-standard)] hover:bg-surface-sunk',
                  ride.id === selectedId && 'bg-accent-soft/60',
                )}
              >
                {/* La fila abre el detalle; la acción es un control aparte,
                    nunca un botón dentro de otro botón. */}
                <button
                  onClick={() => onSelect(ride.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <ProgressRing
                    progress={progress}
                    size={38}
                    stroke={3}
                    tone={progress < 0.25 ? 'critical' : tone}
                  >
                    <span className="tnum text-micro font-semibold text-ink-secondary">
                      {Math.max(0, Math.round((300 - elapsed) / 60))}m
                    </span>
                  </ProgressRing>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-caption text-ink-secondary">
                      {ride.code}
                    </span>
                    <span className="block truncate text-base text-ink">{ride.pickup.text}</span>
                    <StatusPill tone={tone} className="mt-1" live>
                      {RIDE_STATUS_LABEL[ride.status]}
                    </StatusPill>
                  </span>
                </button>

                {ride.status === 'UNASSIGNED' && puedeRelanzar ? (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void actions.relaunch(ride.id).catch(() => undefined)}
                  >
                    Relanzar
                  </Button>
                ) : null}
              </motion.div>
            );
          })}
        </AnimatePresence>

        {rides.length === 0 ? (
          <EmptyState
            icon={<Check className="size-4" strokeWidth={3} />}
            tone="positive"
            title="Nada pendiente"
            description="Todas las carreras tienen conductor o están en curso."
          />
        ) : null}
      </div>
    </Card>
  );
}
