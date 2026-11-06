import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Ban, Check } from 'lucide-react';
import {
  MOTIVOS_CANCELACION_CONDUCTOR,
  cancelacionConductorSchema,
  type MotivoCancelacionConductor,
} from '@tax/shared';
import { TONE_CLASS, cn, transition } from '@tax/ui';

/**
 * Cancelar la carrera por una causa mayor, antes de recoger al cliente.
 *
 * Dos pasos a propósito: el botón de la pantalla solo abre esta hoja, y la
 * carrera se cancela al confirmar aquí, con el motivo elegido. Un toque
 * accidental no deja a nadie sin taxi.
 *
 * El motivo sale de una lista corta —así se puede contar en Reportes— y con
 * «Otro» hay que escribir qué pasó. Con los demás, el detalle es opcional.
 */
export function CancelarCarrera({
  code,
  onConfirmar,
}: {
  code: string;
  /** Devuelve el error para mostrarlo, o `null` si se canceló. */
  onConfirmar: (motivo: MotivoCancelacionConductor, detalle?: string) => Promise<string | null>;
}) {
  const [abierta, setAbierta] = useState(false);
  const [motivo, setMotivo] = useState<MotivoCancelacionConductor | null>(null);
  const [detalle, setDetalle] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entrada = { motivo: motivo ?? undefined, detalle: detalle.trim() || undefined };
  const valida = cancelacionConductorSchema.safeParse(entrada).success;

  const cerrar = () => {
    if (enviando) return;
    setAbierta(false);
    setMotivo(null);
    setDetalle('');
    setError(null);
  };

  const confirmar = async () => {
    if (!motivo || !valida) return;
    setEnviando(true);
    setError(null);
    const fallo = await onConfirmar(motivo, detalle.trim() || undefined);
    setEnviando(false);
    if (fallo) setError(fallo);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setAbierta(true)}
        className={cn(
          TONE_CLASS.critical,
          'flex h-12 w-full items-center justify-center gap-2 rounded-lg text-lg font-semibold text-[var(--tone-ink)]',
          'transition-colors duration-150 ease-[var(--ease-standard)] active:bg-[var(--tone-bg)]',
        )}
      >
        <Ban className="size-5" />
        Cancelar carrera
      </button>

      <AnimatePresence>
        {abierta ? (
          <div className="fixed inset-0 z-50 flex flex-col justify-end">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transition.fast}
              onClick={cerrar}
              className="absolute inset-0 bg-ink/60"
            />
            <motion.section
              role="dialog"
              aria-modal="true"
              aria-label="Cancelar la carrera"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={transition.panel}
              className="relative mx-auto flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[22px] bg-surface"
            >
              <div className="overflow-y-auto px-5 pb-3 pt-5">
                <p className="font-mono text-caption text-ink-muted">{code}</p>
                <h2 className="mt-1 text-2xl font-bold text-ink">¿Cancelar la carrera?</h2>
                <p className="mt-2 text-lg leading-snug text-ink-secondary">
                  Solo por una causa mayor. El cliente se queda sin este taxi y la oficina recibe el aviso con
                  el motivo.
                </p>

                <fieldset className="mt-4 space-y-2">
                  <legend className="mb-2 text-micro font-semibold uppercase tracking-[0.07em] text-ink-muted">
                    ¿Por qué?
                  </legend>
                  {MOTIVOS_CANCELACION_CONDUCTOR.map((m) => {
                    const elegido = motivo === m.clave;
                    return (
                      <button
                        key={m.clave}
                        type="button"
                        role="radio"
                        aria-checked={elegido}
                        onClick={() => {
                          setMotivo(m.clave);
                          setError(null);
                        }}
                        className={cn(
                          'flex min-h-14 w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-lg',
                          elegido
                            ? cn(TONE_CLASS.critical, 'border-[var(--tone-solid)] bg-[var(--tone-bg)] font-semibold text-ink')
                            : 'border-line bg-surface text-ink',
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'flex size-6 shrink-0 items-center justify-center rounded-full border-2',
                            elegido ? 'border-[var(--tone-solid)] bg-[var(--tone-solid)] text-on-accent' : 'border-line-strong',
                          )}
                        >
                          {elegido ? <Check className="size-4" /> : null}
                        </span>
                        {m.texto}
                      </button>
                    );
                  })}
                </fieldset>

                {motivo ? (
                  <label className="mt-4 block">
                    <span className="text-base font-medium text-ink">
                      {motivo === 'otro' ? 'Cuenta qué pasó' : 'Detalle (opcional)'}
                    </span>
                    <textarea
                      value={detalle}
                      onChange={(e) => setDetalle(e.target.value.slice(0, 200))}
                      rows={3}
                      placeholder={motivo === 'otro' ? 'Por ejemplo: se me varó el carro en la vía a Duitama' : ''}
                      className="mt-1.5 w-full resize-none rounded-lg border border-line bg-surface px-3 py-2.5 text-lg text-ink outline-none focus:border-[var(--accent)]"
                    />
                    {motivo === 'otro' && detalle.trim().length > 0 && detalle.trim().length < 5 ? (
                      <span className="text-base text-ink-muted">Un poco más, para que la oficina entienda.</span>
                    ) : null}
                  </label>
                ) : null}

                {error ? (
                  <p className={cn(TONE_CLASS.critical, 'mt-3 rounded-lg bg-[var(--tone-bg)] px-4 py-3 text-lg text-[var(--tone-ink)]')}>
                    {error}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2.5 border-t border-line px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
                <button
                  type="button"
                  disabled={!valida || enviando}
                  onClick={() => void confirmar()}
                  className={cn(
                    TONE_CLASS.critical,
                    'flex h-16 w-full items-center justify-center gap-2 rounded-lg text-xl font-bold',
                    valida && !enviando
                      ? 'bg-[var(--tone-solid)] text-on-accent'
                      : 'cursor-not-allowed border border-line bg-surface-sunk text-ink-muted',
                  )}
                >
                  <Ban className="size-6" />
                  {enviando ? 'Cancelando…' : 'Sí, cancelar la carrera'}
                </button>
                <button
                  type="button"
                  onClick={cerrar}
                  disabled={enviando}
                  className="flex h-14 w-full items-center justify-center rounded-lg border border-line bg-surface text-lg font-semibold text-ink"
                >
                  No, volver a la carrera
                </button>
              </div>
            </motion.section>
          </div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
