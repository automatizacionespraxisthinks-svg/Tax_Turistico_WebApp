import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import { formatMoney } from '@tax/shared';
import { AnimatedNumber, Button, spring, transition } from '@tax/ui';
import { ActionBar, DataRow, Screen } from '../components/Chrome';
import type { OfferedRide, SessionState } from '../state/session';

/** Cierre de la carrera: confirmación breve y vuelta a disponible. */
export function Resumen({
  offer,
  session,
  onContinue,
}: {
  offer: OfferedRide | null;
  session: SessionState;
  onContinue: () => void;
}) {
  return (
    <>
      <Screen className="justify-center text-center">
        <div className="flex flex-col items-center gap-5">
          <motion.div
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={spring.snappy}
            className="tone-positive flex size-16 items-center justify-center rounded-full border border-[var(--tone-line)] bg-[var(--tone-bg)]"
          >
            <motion.span
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.12, ...transition.enter }}
            >
              <Check className="size-8 text-[var(--tone-ink)]" />
            </motion.span>
          </motion.div>

          <div>
            <h1 className="text-display font-semibold tracking-[-0.02em] text-ink">
              Carrera finalizada
            </h1>
            {offer ? (
              <p className="mt-1.5 font-mono text-caption text-ink-muted">{offer.code}</p>
            ) : null}
          </div>

          <p className="tnum text-[2.5rem] font-semibold leading-none tracking-[-0.025em] text-ink">
            {formatMoney(session.lastFare)}
          </p>
          <p className="-mt-3 text-base text-ink-muted">Tarifa estimada de esta carrera</p>
        </div>

        <div className="mt-6 rounded-lg border border-line bg-surface px-4 text-left">
          <DataRow label="Carreras de hoy" value={<AnimatedNumber value={session.ridesToday} />} />
          <DataRow label="Total del día" value={formatMoney(session.earnedToday)} />
        </div>
      </Screen>

      <ActionBar>
        <Button variant="primary" size="touch" onClick={onContinue}>
          Volver a estar disponible
        </Button>
      </ActionBar>
    </>
  );
}
