import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Check, MapPin, Users, X } from 'lucide-react';
import { formatDistance } from '@tax/shared';
import { Button, ProgressRing, StatusPill, cn, transition } from '@tax/ui';
import { ActionBar, AddressBlock, Screen } from '../components/Chrome';
import type { OfferedRide } from '../state/session';

/**
 * Oferta entrante.
 *
 * Es la pantalla más exigente: llega sin aviso, el conductor puede estar en
 * movimiento y la ventana es de segundos. Por eso:
 *  - un solo dato grande (la dirección) y un solo botón principal;
 *  - el aro de cuenta atrás cambia a crítico en los últimos 10 s;
 *  - vibra al aparecer, para que se note sin mirar.
 */
export function Oferta({
  offer,
  onAccept,
  onReject,
  onExpire,
}: {
  offer: OfferedRide;
  onAccept: () => void;
  onReject: () => void;
  onExpire: () => void;
}) {
  const total = 45;
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.round((offer.expiresAt - Date.now()) / 1000)),
  );

  useEffect(() => {
    // Vibration API: patrón corto-largo, distinto de una notificación normal.
    navigator.vibrate?.([120, 70, 220]);
  }, [offer.code]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const next = Math.max(0, Math.round((offer.expiresAt - Date.now()) / 1000));
      setRemaining(next);
      if (next === 0) {
        window.clearInterval(id);
        onExpire();
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [offer.expiresAt, onExpire]);

  const urgent = remaining <= 10;

  return (
    <>
      <Screen className="gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <StatusPill tone="warning" size="md" live>
              {offer.wave === 4 ? 'Para todos' : `Oleada ${offer.wave}`} · nueva carrera
            </StatusPill>
            <p className="mt-2 font-mono text-caption text-ink-muted">{offer.code}</p>
          </div>

          <ProgressRing
            progress={remaining / total}
            size={64}
            stroke={5}
            tone={urgent ? 'critical' : 'warning'}
          >
            <motion.span
              key={remaining}
              initial={{ opacity: 0.4, scale: urgent ? 1.2 : 1 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={transition.fast}
              className={cn(
                'tnum text-lg font-semibold',
                urgent ? 'text-[var(--t-critical-ink)]' : 'text-ink',
              )}
            >
              {remaining}
            </motion.span>
          </ProgressRing>
        </div>

        <AddressBlock
          label="Recoger en"
          text={offer.pickupText}
          reference={offer.pickupReference}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Chip icon={<MapPin className="size-3.5" />}>
            {formatDistance(offer.distanceKm)} · {offer.etaMinutes} min
          </Chip>
          <Chip icon={<Users className="size-3.5" />}>
            {offer.passengers} {offer.passengers === 1 ? 'pasajero' : 'pasajeros'}
          </Chip>
          <Chip>{offer.zoneName}</Chip>
        </div>

        <div className="rounded-lg border border-line bg-surface-sunk p-4">
          <p className="text-micro font-semibold uppercase tracking-[0.07em] text-ink-muted">
            Destino
          </p>
          <p className="mt-1 text-xl font-medium text-ink">{offer.dropoffText ?? 'Sin destino indicado'}</p>
        </div>

        {offer.notes ? (
          <p className="rounded-md border border-line px-3 py-2.5 text-lg leading-snug text-ink-secondary">
            {offer.notes}
          </p>
        ) : null}

        <p className="text-caption text-ink-muted">
          El teléfono del cliente aparece solo cuando aceptas.
        </p>
      </Screen>

      <ActionBar>
        <Button variant="primary" size="touch" icon={<Check className="size-6" />} onClick={onAccept}>
          Aceptar carrera
        </Button>
        <Button variant="ghost" size="lg" className="w-full" icon={<X className="size-4" />} onClick={onReject}>
          Rechazar
        </Button>
      </ActionBar>
    </>
  );
}

function Chip({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-caption text-ink-secondary">
      {icon}
      {children}
    </span>
  );
}
