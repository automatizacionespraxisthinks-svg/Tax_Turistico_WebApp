import { motion } from 'motion/react';
import { Check } from 'lucide-react';
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
  // Lo que duró con el pasajero a bordo: lo único de la carrera que le dice
  // algo al conductor ahora que no se manejan precios.
  const minutos = offer?.startedAt ? Math.max(1, Math.round((Date.now() - offer.startedAt) / 60_000)) : null;

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
        </div>

        <div className="mt-6 rounded-lg border border-line bg-surface px-4 text-left">
          {minutos !== null ? <DataRow label="Con el pasajero a bordo" value={`${minutos} min`} /> : null}
          <DataRow label="Carreras de hoy" value={<AnimatedNumber value={session.ridesToday} />} />
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
