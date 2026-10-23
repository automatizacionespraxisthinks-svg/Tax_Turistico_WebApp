import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Ban, Car, MessageSquare, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Driver, Ride } from '@tax/shared';
import {
  ACTOR_LABEL,
  RIDE_STATUS_LABEL,
  RIDE_STATUS_TONE,
  formatDateTime,
  formatDistance,
  formatMoney,
  formatTime,
  haversineKm,
  maskPhone,
  transitionsFrom,
} from '@tax/shared';
import {
  Button,
  Field,
  Meta,
  SectionLabel,
  Select,
  StatusPill,
  TONE_CLASS,
  Tabs,
  cn,
  transition,
  useToast,
} from '@tax/ui';
import { actions, loadRideDetail, useLive } from '../live/store';

type DetailTab = 'resumen' | 'oleadas' | 'bitacora';

/**
 * Distancia con coma decimal.
 *
 * `toFixed` escribe «1.3», y justo encima de un «$ 7.600» donde el punto son
 * miles eso se lee por un momento como mil trescientos. En la misma tarjeta
 * no pueden convivir los dos usos del punto.
 */
function formatKm(km: number): string {
  return `${km.toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
}

export function RideDetail({ ride }: { ride: Ride }) {
  const [tab, setTab] = useState<DetailTab>('resumen');
  const drivers = useLive((s) => s.drivers);

  /*
   * El listado trae la carrera sin historial ni ofertas: traerlos para
   * doscientas filas sería un desperdicio cuando solo se abre una. Se piden
   * al abrir el detalle, y el store los guarda en la misma carrera.
   */
  useEffect(() => {
    void loadRideDetail(ride.id).catch(() => undefined);
  }, [ride.id]);
  const driver = ride.driverId ? drivers.find((d) => d.id === ride.driverId) : undefined;

  return (
    <div className="space-y-5">
      <Header ride={ride} driver={driver} />

      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'resumen', label: 'Resumen' },
          { value: 'oleadas', label: 'Oleadas', count: ride.offers.length },
          { value: 'bitacora', label: 'Bitácora', count: ride.history.length },
        ]}
      />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={transition.fast}
        >
          {tab === 'resumen' ? <Resumen ride={ride} driver={driver} /> : null}
          {tab === 'oleadas' ? <Oleadas ride={ride} /> : null}
          {tab === 'bitacora' ? <Bitacora ride={ride} /> : null}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Header({ ride, driver }: { ride: Ride; driver?: Driver }) {
  const distance =
    ride.pickup.point && driver?.position ? haversineKm(driver.position, ride.pickup.point) : undefined;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusPill tone={RIDE_STATUS_TONE[ride.status]} size="md" live={ride.status === 'NOTIFIED'}>
        {RIDE_STATUS_LABEL[ride.status]}
      </StatusPill>
      <span className="rounded-full border border-line px-2 py-0.5 text-micro text-ink-muted">
        versión {ride.version}
      </span>
      {distance !== undefined ? (
        <span className="rounded-full border border-line px-2 py-0.5 text-micro text-ink-muted">
          conductor a {formatDistance(distance)}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ resumen */

function Resumen({ ride, driver }: { ride: Ride; driver?: Driver }) {
  const zone = useLive((s) => s.zones.find((z) => z.id === ride.zoneId));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <Meta label="Cliente">{ride.customerName}</Meta>
        <Meta label="Teléfono" mono>
          {/* El operador sí lo ve; el conductor solo tras aceptar (§8.1). */}
          {ride.customerPhone}
        </Meta>
        <Meta label="Línea">{ride.line}</Meta>
        <Meta label="Pasajeros">{ride.passengers}</Meta>
      </div>

      <div className="rounded-md border border-line">
        <Route label="Recogida" text={ride.pickup.text} reference={ride.pickup.reference} />
        {ride.dropoff ? (
          <Route
            label="Destino"
            text={ride.dropoff.text}
            /* Un destino que puso el conductor al cerrar no es el que pidio
               el cliente: quien lee la ficha tiene que poder distinguirlos. */
            reference={
              ride.dropoffSource === 'conductor' ? 'Registrado donde terminó la carrera' : undefined
            }
            last
          />
        ) : null}
      </div>

      {ride.notes ? (
        <div className="flex gap-2 rounded-md border border-line bg-surface-sunk p-2.5">
          <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-ink-muted" />
          <p className="text-base text-ink-secondary">{ride.notes}</p>
        </div>
      ) : null}

      <div>
        <SectionLabel>Tarifa</SectionLabel>
        <div className="mt-2 rounded-md border border-line bg-surface-sunk px-3 py-2.5">
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-title font-semibold tnum text-ink">
                {formatMoney(ride.fareFinal ?? ride.fareEstimate)}
              </p>
              <p className="text-micro text-ink-muted">
                {ride.fareFinal !== undefined
                  ? `Final${ride.distanceKm !== undefined ? ` · ${formatKm(ride.distanceKm)}` : ''} · regla ${ride.fareRuleVersion}`
                  : `Estimada · regla ${ride.fareRuleVersion} · zona ${zone?.name ?? '—'}`}
              </p>
            </div>
            <span className="inline-flex items-center gap-1 text-micro text-ink-muted">
              <ShieldCheck className="size-3.5" />
              Tarifa autorizada
            </span>
          </div>

          {/*
            Con tarifa final, la estimada no desaparece: es la que se le dijo
            al cliente cuando pidio el taxi. Si hay diferencia, la oficina la
            ve aqui y no cuando el cliente llama a reclamar.
          */}
          {ride.fareFinal !== undefined ? (
            <p className="mt-2 border-t border-line pt-2 text-micro text-ink-muted">
              Se le dijo {formatMoney(ride.fareEstimate)} al pedirla
              {ride.fareFinal !== ride.fareEstimate
                ? ` · ${ride.fareFinal > ride.fareEstimate ? '+' : '−'}${formatMoney(Math.abs(ride.fareFinal - ride.fareEstimate))}`
                : ' · sin diferencia'}
            </p>
          ) : null}
        </div>
      </div>

      {driver ? (
        <div>
          <SectionLabel>Conductor asignado</SectionLabel>
          <div className="mt-2 flex items-center gap-3 rounded-md border border-line p-2.5">
            <div className="flex size-9 items-center justify-center rounded-md bg-surface-sunk">
              <Car className="size-4 text-ink-secondary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-medium text-ink">{driver.name}</p>
              <p className="text-micro text-ink-muted">
                Código {driver.code} · {driver.vehicle.plate} · {driver.vehicle.type}
              </p>
            </div>
            <span className="font-mono text-caption text-ink-muted">{maskPhone(driver.phone)}</span>
          </div>
        </div>
      ) : null}

      <RideActions ride={ride} />
    </div>
  );
}

function Route({
  label,
  text,
  reference,
  last,
}: {
  label: string;
  text: string;
  reference?: string;
  last?: boolean;
}) {
  return (
    <div className={cn('flex gap-2.5 p-2.5', !last && 'border-b border-line')}>
      <div className="flex flex-col items-center pt-1">
        <span className={cn('size-2 rounded-full', last ? 'bg-ink' : 'border-2 border-accent bg-surface')} />
        {!last ? <span className="mt-1 w-px flex-1 bg-line" /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-micro font-medium uppercase tracking-[0.06em] text-ink-muted">{label}</p>
        <p className="text-base text-ink">{text}</p>
        {reference ? <p className="text-caption text-ink-muted">{reference}</p> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ acciones */

function RideActions({ ride }: { ride: Ride }) {
  const { push } = useToast();
  const drivers = useLive((s) => s.drivers);
  const [assigning, setAssigning] = useState(false);
  const [choice, setChoice] = useState('');

  const available = drivers.filter((d) => d.status === 'AVAILABLE');
  const allowed = transitionsFrom(ride.status, 'operator');
  if (allowed.length === 0) return null;

  const canRelaunch = allowed.some((t) => t.to === 'NOTIFIED');
  const canAssign = allowed.some((t) => t.to === 'ASSIGNED');
  const canCancel = allowed.some((t) => t.to === 'CANCELLED');

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <SectionLabel>Acciones del operador</SectionLabel>

      <div className="flex flex-wrap gap-2">
        {canRelaunch ? (
          <Button
            icon={<RefreshCw className="size-3.5" />}
            onClick={() => {
              void actions
                .relaunch(ride.id)
                .then(() =>
                  push({
                    tone: 'info',
                    title: 'Despacho relanzado',
                    description: `${ride.code} vuelve a oleada 1.`,
                  }),
                )
                .catch((error: unknown) =>
                  push({
                    tone: 'critical',
                    title: 'No se pudo relanzar',
                    description: error instanceof Error ? error.message : undefined,
                  }),
                );
            }}
          >
            Relanzar despacho
          </Button>
        ) : null}

        {canAssign ? (
          <Button variant={assigning ? 'primary' : 'secondary'} onClick={() => setAssigning((v) => !v)}>
            Asignar manualmente
          </Button>
        ) : null}

        {canCancel ? (
          <Button
            variant="danger"
            icon={<Ban className="size-3.5" />}
            onClick={() => {
              void actions
                .cancel(ride.id, 'Cancelada por la oficina')
                .then(() =>
                  push({
                    tone: 'warning',
                    title: 'Carrera cancelada',
                    description: `${ride.code} quedó cancelada.`,
                  }),
                )
                .catch((error: unknown) =>
                  push({
                    tone: 'critical',
                    title: 'No se pudo cancelar',
                    description: error instanceof Error ? error.message : undefined,
                  }),
                );
            }}
          >
            Cancelar
          </Button>
        ) : null}
      </div>

      <AnimatePresence initial={false}>
        {assigning ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={transition.base}
            className="overflow-hidden"
          >
            <div className="flex items-end gap-2 pt-1">
              <Field label="Conductor disponible" className="flex-1" htmlFor="assign-driver">
                <Select id="assign-driver" value={choice} onChange={(e) => setChoice(e.target.value)}>
                  <option value="">Selecciona un conductor…</option>
                  {available.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code} · {d.name} · {d.vehicle.plate}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="primary"
                disabled={!choice}
                onClick={() => {
                  void actions
                    .assign(ride.id, choice)
                    .then(() => {
                      setAssigning(false);
                      setChoice('');
                      push({
                        tone: 'positive',
                        title: 'Conductor asignado',
                        description: `${ride.code} quedó asignada.`,
                      });
                    })
                    .catch((error: unknown) =>
                      push({
                        tone: 'critical',
                        title: 'No se pudo asignar',
                        description: error instanceof Error ? error.message : undefined,
                      }),
                    );
                }}
              >
                Confirmar
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <p className="text-micro text-ink-muted">
        Solo aparecen las transiciones que la máquina de estados permite desde{' '}
        <span className="font-medium">{RIDE_STATUS_LABEL[ride.status]}</span>.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ oleadas */

function Oleadas({ ride }: { ride: Ride }) {
  const waves = [1, 2, 3] as const;

  return (
    <div className="space-y-4">
      <p className="text-caption text-ink-muted">
        Cada oferta explica por qué un conductor recibió o no la carrera: radio, orden por ETA y
        vencimiento de la oleada.
      </p>

      {waves.map((wave) => {
        const offers = ride.offers.filter((o) => o.wave === wave);
        if (offers.length === 0) return null;

        return (
          <div key={wave}>
            <SectionLabel>Oleada {wave}</SectionLabel>
            <ul className="mt-2 space-y-1.5">
              {offers.map((offer) => {
                const tone =
                  offer.response === 'accepted'
                    ? 'positive'
                    : offer.response === 'pending'
                      ? 'warning'
                      : offer.response === 'rejected'
                        ? 'critical'
                        : 'neutral';
                const label = {
                  accepted: 'Aceptó',
                  pending: 'Pendiente',
                  rejected: 'Rechazó',
                  expired: 'Venció',
                  revoked: 'Revocada',
                }[offer.response];

                return (
                  <li
                    key={`${offer.driverId}-${offer.sentAt}`}
                    className={cn(
                      TONE_CLASS[tone],
                      'flex items-center gap-3 rounded-md border border-line px-2.5 py-2',
                      offer.response === 'accepted' && 'border-[var(--tone-line)] bg-[var(--tone-bg)]',
                    )}
                  >
                    <span className="size-1.5 shrink-0 rounded-full bg-[var(--tone-solid)]" />
                    <span className="min-w-0 flex-1 truncate text-base text-ink">{offer.driverName}</span>
                    <span className="tnum shrink-0 text-caption text-ink-muted">
                      {formatDistance(offer.distanceKm)} · {offer.etaMinutes} min
                    </span>
                    <span className="shrink-0 text-caption font-medium text-[var(--tone-ink)]">{label}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------- bitácora */

function Bitacora({ ride }: { ride: Ride }) {
  return (
    <ol className="relative space-y-0">
      {ride.history.map((entry, index) => {
        const last = index === ride.history.length - 1;
        return (
          <li key={`${entry.to}-${entry.at}`} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  TONE_CLASS[RIDE_STATUS_TONE[entry.to]],
                  'mt-1.5 size-2.5 shrink-0 rounded-full border-2 border-surface bg-[var(--tone-solid)]',
                )}
              />
              {!last ? <span className="w-px flex-1 bg-line" /> : null}
            </div>
            <div className={cn('min-w-0 flex-1', !last && 'pb-4')}>
              <p className="text-base font-medium text-ink">{RIDE_STATUS_LABEL[entry.to]}</p>
              <p className="text-caption text-ink-muted">
                {ACTOR_LABEL[entry.actor]} · {entry.actorName} ·{' '}
                <time title={formatDateTime(entry.at)}>{formatTime(entry.at)}</time>
              </p>
              {entry.note ? <p className="mt-0.5 text-caption text-ink-secondary">{entry.note}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
