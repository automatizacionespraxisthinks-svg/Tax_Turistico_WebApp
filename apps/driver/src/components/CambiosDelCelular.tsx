import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CarFront, UsersRound } from 'lucide-react';
import { Input, TONE_CLASS, cn, transition } from '@tax/ui';
import { PlacasPermitidas } from './PlacasPermitidas';

/**
 * Cambiar de carro o de conductor (17/11/2026).
 *
 * Un carro lo manejan varios conductores y un conductor maneja varios carros,
 * y muchas veces con el mismo celular:
 *
 * - **Cambiar de carro**: el mismo conductor, con su misma sesión, pasa a otro
 *   móvil. Solo con el turno abierto (sin turno, la placa se escribe al
 *   iniciarlo).
 * - **Cambiar de conductor**: quien tiene el celular sale de él —se cierra su
 *   turno y su sesión— y el compañero entra con su código y su PIN.
 *
 * Los dos piden confirmar en una hoja, como «Cancelar carrera»: un toque
 * accidental no le cierra el turno a nadie.
 */
export function CambiosDelCelular({
  enTurno,
  placaActual,
  conductor,
  onCambiarCarro,
  onCambiarConductor,
}: {
  enTurno: boolean;
  placaActual?: string;
  conductor?: { code: string; name: string };
  /** Devuelven el error para mostrarlo, o `null` si salió bien. */
  onCambiarCarro: (placa: string) => Promise<string | null>;
  onCambiarConductor: () => Promise<string | null>;
}) {
  const [hoja, setHoja] = useState<'carro' | 'conductor' | null>(null);
  const [placa, setPlaca] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const placaLimpia = placa.trim().toUpperCase();
  const placaValida = placaLimpia.length >= 5 && placaLimpia !== placaActual;

  const abrir = (cual: 'carro' | 'conductor') => {
    setPlaca('');
    setError(null);
    setHoja(cual);
  };

  const cerrar = () => {
    if (enviando) return;
    setHoja(null);
    setError(null);
  };

  const confirmar = async () => {
    setEnviando(true);
    setError(null);
    const fallo = hoja === 'carro' ? await onCambiarCarro(placaLimpia) : await onCambiarConductor();
    setEnviando(false);
    if (fallo) setError(fallo);
    else setHoja(null);
  };

  // Van en la barra de acciones, que es blanca también con el turno abierto.
  const boton = cn(
    'flex h-12 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-2',
    'text-base font-semibold text-ink transition-colors duration-150 ease-[var(--ease-standard)] active:bg-surface-sunk',
  );

  return (
    <>
      <div className={cn('grid gap-2', enTurno ? 'grid-cols-2' : 'grid-cols-1')}>
        {enTurno ? (
          <button type="button" className={boton} onClick={() => abrir('carro')}>
            <CarFront className="size-5 shrink-0" />
            Cambiar carro
          </button>
        ) : null}
        <button type="button" className={boton} onClick={() => abrir('conductor')}>
          <UsersRound className="size-5 shrink-0" />
          Cambiar conductor
        </button>
      </div>

      <Hoja abierta={hoja !== null} onCerrar={cerrar} titulo={hoja === 'carro' ? 'Cambiar de carro' : 'Cambiar de conductor'}>
        {hoja === 'carro' ? (
          <>
            <h2 className="text-2xl font-bold text-ink">¿A qué carro pasas?</h2>
            <p className="mt-2 text-lg leading-snug text-ink-secondary">
              Se cierra el turno{placaActual ? ` en el ${placaActual}` : ''} y se abre en el carro nuevo.
              Sigues con tu misma cuenta. Solo puedes pasar a uno de tus vehículos.
            </p>
            <div className="mt-4">
              <PlacasPermitidas
                elegida={placaLimpia}
                excluir={placaActual}
                onElegir={(p) => {
                  setPlaca(p);
                  setError(null);
                }}
              />
            </div>
            <label className="mt-4 block">
              <span className="text-base font-medium text-ink">Placa del carro nuevo</span>
              <Input
                autoFocus
                autoCapitalize="characters"
                maxLength={10}
                value={placa}
                onChange={(e) => {
                  setPlaca(e.target.value.toUpperCase());
                  setError(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && placaValida && !enviando && void confirmar()}
                placeholder="Escribe la placa"
                className="mt-1.5 h-14 font-mono text-xl tracking-[0.08em]"
              />
            </label>
          </>
        ) : (
          <>
            <h2 className="text-2xl font-bold text-ink">¿Entrega el celular a otro conductor?</h2>
            <p className="mt-2 text-lg leading-snug text-ink-secondary">
              {conductor ? (
                <>
                  Se cierra el turno y la sesión de <strong className="text-ink">{conductor.name}</strong>{' '}
                  (código {conductor.code}) en este celular.
                </>
              ) : (
                'Se cierra tu turno y tu sesión en este celular.'
              )}{' '}
              El otro conductor entra con su propio código y su PIN.
            </p>
          </>
        )}

        {error ? (
          <p className={cn(TONE_CLASS.critical, 'mt-3 rounded-lg bg-[var(--tone-bg)] px-4 py-3 text-lg text-[var(--tone-ink)]')}>
            {error}
          </p>
        ) : null}

        <div className="mt-5 space-y-2.5">
          <button
            type="button"
            disabled={enviando || (hoja === 'carro' && !placaValida)}
            onClick={() => void confirmar()}
            className={cn(
              'flex h-16 w-full items-center justify-center gap-2 rounded-lg text-xl font-bold',
              enviando || (hoja === 'carro' && !placaValida)
                ? 'cursor-not-allowed border border-line bg-surface-sunk text-ink-muted'
                : 'bg-brand text-on-accent',
            )}
          >
            {hoja === 'carro' ? <CarFront className="size-6" /> : <UsersRound className="size-6" />}
            {enviando
              ? 'Un momento…'
              : hoja === 'carro'
                ? 'Pasar a este carro'
                : 'Sí, cambiar de conductor'}
          </button>
          <button
            type="button"
            onClick={cerrar}
            disabled={enviando}
            className="flex h-14 w-full items-center justify-center rounded-lg border border-line bg-surface text-lg font-semibold text-ink"
          >
            No, volver
          </button>
        </div>
      </Hoja>
    </>
  );
}

/** Hoja que sube desde abajo, con el fondo oscurecido. */
function Hoja({
  abierta,
  onCerrar,
  titulo,
  children,
}: {
  abierta: boolean;
  onCerrar: () => void;
  titulo: string;
  children: ReactNode;
}) {
  return (
    <AnimatePresence>
      {abierta ? (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transition.fast}
            onClick={onCerrar}
            className="absolute inset-0 bg-ink/60"
          />
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-label={titulo}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={transition.panel}
            className="relative mx-auto w-full max-w-md rounded-t-[22px] bg-surface px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5"
          >
            {children}
          </motion.section>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
