import { motion } from 'motion/react';
import { Flag, LocateFixed, Navigation, Phone, UserCheck } from 'lucide-react';
import type { RideStatus } from '@tax/shared';
import { RIDE_STATUS_LABEL, formatDistance, formatMoney } from '@tax/shared';
import { Button, StatusPill, cn, transition } from '@tax/ui';
import { ActionBar, AddressBlock, Screen } from '../components/Chrome';
import type { OfferedRide } from '../state/session';

type ActiveStatus = Extract<RideStatus, 'ASSIGNED' | 'DRIVER_ARRIVED' | 'IN_PROGRESS'>;

const STEPS: ActiveStatus[] = ['ASSIGNED', 'DRIVER_ARRIVED', 'IN_PROGRESS'];

/**
 * Carrera en curso: un solo botón grande por estado.
 *
 * "Llegué" solo se habilita a menos de 150 m del punto; más lejos se puede
 * marcar igual, pero queda registrada la excepción (§5.3).
 */
export function Carrera({
  offer,
  status,
  metersToPickup,
  onArrived,
  onBoard,
  onFinish,
}: {
  offer: OfferedRide;
  status: ActiveStatus;
  metersToPickup: number;
  onArrived: () => void;
  onBoard: () => void;
  onFinish: () => void;
}) {
  const nearby = metersToPickup <= 150;
  const stepIndex = STEPS.indexOf(status);

  return (
    <>
      <Screen className="gap-4">
        <Progress stepIndex={stepIndex} />

        <div className="flex items-center justify-between gap-3">
          <StatusPill tone={status === 'IN_PROGRESS' ? 'progress' : 'info'} size="md" live>
            {RIDE_STATUS_LABEL[status]}
          </StatusPill>
          <span className="font-mono text-caption text-ink-muted">{offer.code}</span>
        </div>

        {status === 'IN_PROGRESS' ? (
          <AddressBlock label="Llevar a" text={offer.dropoffText} />
        ) : (
          <AddressBlock
            label="Recoger en"
            text={offer.pickupText}
            reference={offer.pickupReference}
          />
        )}

        {status !== 'IN_PROGRESS' ? (
          <div
            className={cn(
              'flex items-center gap-3 rounded-lg border px-4 py-3.5',
              nearby
                ? 'tone-positive border-[var(--tone-line)] bg-[var(--tone-bg)]'
                : 'border-line bg-surface-sunk',
            )}
          >
            <LocateFixed
              className={cn('size-5 shrink-0', nearby ? 'text-[var(--tone-ink)]' : 'text-ink-muted')}
            />
            <div className="min-w-0 flex-1">
              <p className={cn('text-lg font-medium', nearby ? 'text-[var(--tone-ink)]' : 'text-ink')}>
                {nearby ? 'Estás en el punto' : `A ${formatDistance(metersToPickup / 1000)} del punto`}
              </p>
              <p className="text-caption text-ink-muted">
                {nearby ? 'Puedes marcar que llegaste.' : 'La distancia se actualiza con tu GPS.'}
              </p>
            </div>
          </div>
        ) : null}

        {/* El teléfono solo aparece una vez aceptada la carrera (§8.1). */}
        <div className="rounded-lg border border-line bg-surface p-4">
          <p className="text-micro font-semibold uppercase tracking-[0.07em] text-ink-muted">
            Cliente
          </p>
          <div className="mt-1.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xl font-medium text-ink">
                {offer.customerName ?? 'Cliente'}
              </p>
              <p className="font-mono text-base text-ink-secondary">
                {offer.customerPhone ?? 'Cargando…'}
              </p>
            </div>
            <a
              href={offer.customerPhone ? `tel:${offer.customerPhone}` : undefined}
              aria-label={`Llamar a ${offer.customerName ?? 'el cliente'}`}
              className={cn(
                'flex size-12 shrink-0 items-center justify-center rounded-full border border-line bg-surface-sunk text-ink',
                'transition-colors duration-150 ease-[var(--ease-standard)] active:bg-accent-soft',
              )}
            >
              <Phone className="size-5" />
            </a>
          </div>
          {offer.notes ? (
            <p className="mt-3 border-t border-line pt-3 text-lg leading-snug text-ink-secondary">
              {offer.notes}
            </p>
          ) : null}
        </div>

        <div className="flex items-baseline justify-between rounded-lg border border-line bg-surface-sunk px-4 py-3">
          <span className="text-base text-ink-muted">Tarifa estimada</span>
          <span className="tnum text-xl font-semibold text-ink">{formatMoney(offer.fareEstimate)}</span>
        </div>
      </Screen>

      <ActionBar>
        {status === 'ASSIGNED' ? (
          <Button
            variant="primary"
            size="touch"
            icon={<Navigation className="size-5" />}
            onClick={onArrived}
          >
            {nearby ? 'Llegué al punto' : 'Marcar que llegué'}
          </Button>
        ) : null}

        {status === 'DRIVER_ARRIVED' ? (
          <Button
            variant="primary"
            size="touch"
            icon={<UserCheck className="size-5" />}
            onClick={onBoard}
          >
            Pasajero a bordo
          </Button>
        ) : null}

        {status === 'IN_PROGRESS' ? (
          <Button variant="primary" size="touch" icon={<Flag className="size-5" />} onClick={onFinish}>
            Finalizar carrera
          </Button>
        ) : null}

        {!nearby && status === 'ASSIGNED' ? (
          <p className="text-center text-caption text-ink-muted">
            Estás a más de 150 m; si marcas ahora, queda registrada la excepción.
          </p>
        ) : null}
      </ActionBar>
    </>
  );
}

/** Tres pasos; el relleno avanza, no salta. */
function Progress({ stepIndex }: { stepIndex: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {STEPS.map((step, index) => (
        <div key={step} className="h-1 flex-1 overflow-hidden rounded-full bg-surface-sunk">
          <motion.div
            initial={false}
            animate={{ scaleX: index <= stepIndex ? 1 : 0 }}
            transition={transition.panel}
            style={{ originX: 0 }}
            className="h-full rounded-full bg-accent"
          />
        </div>
      ))}
    </div>
  );
}
