import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bot, CarFront, Check, Inbox, Timer, TriangleAlert } from 'lucide-react';
import type { Ride, RideStatus } from '@tax/shared';
import { RIDE_STATUS_LABEL, RIDE_STATUS_TONE, formatRelative } from '@tax/shared';
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

/*
 * Tiempo a asignación: cifras de muestra fijas hasta que la API lo dé en
 * vivo. El p95 se pinta en rojo cuando supera el objetivo.
 */
const P95_ASIGNACION_S = 58;
const OBJETIVO_OFERTA_S = 3;

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
  const selected = rides.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="space-y-4 p-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="Carreras activas"
          value={live.length}
          icon={<Inbox className="size-3.5" />}
          iconTone="info"
          hint={`${rides.length} hoy en total`}
        />
        <Stat
          label="Sin asignar"
          value={live.filter((r) => r.status === 'UNASSIGNED').length}
          tone={live.some((r) => r.status === 'UNASSIGNED') ? 'critical' : 'positive'}
          icon={<TriangleAlert className="size-3.5" />}
          iconTone="critical"
          hint="Tres oleadas agotadas"
        />
        <Stat
          label="Conductores libres"
          value={available}
          tone="positive"
          icon={<CarFront className="size-3.5" />}
          iconTone="positive"
          hint={`${onShift} de 62 en turno`}
        />
        <Stat
          label="Tiempo a asignación"
          value={23}
          unit="s"
          tone="info"
          icon={<Timer className="size-3.5" />}
          iconTone="info"
          hint={
            <>
              p95 hoy:{' '}
              <span className={cn(P95_ASIGNACION_S > OBJETIVO_OFERTA_S && 'text-danger')}>
                {P95_ASIGNACION_S} s
              </span>{' '}
              · objetivo &lt; {OBJETIVO_OFERTA_S} s para ofertar
            </>
          }
          trend={[31, 28, 26, 30, 24, 22, 25, 23]}
        />
        <Stat
          label="Sin intervención"
          value={83}
          unit="%"
          tone="positive"
          icon={<Bot className="size-3.5" />}
          iconTone="positive"
          hint="Meta inicial 80 %"
          trend={[72, 74, 77, 72, 69, 75, 81, 83]}
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

                {ride.status === 'UNASSIGNED' ? (
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
