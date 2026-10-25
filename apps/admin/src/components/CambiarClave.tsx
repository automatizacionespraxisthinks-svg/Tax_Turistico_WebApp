import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Check, KeyRound } from 'lucide-react';
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_STRENGTH_LABEL,
  evaluatePassword,
} from '@tax/shared';
import { Banner, Button, Field, Input, Sheet, cn, transition } from '@tax/ui';
import { ApiError, api } from '../api/client';
import { useSesion } from '../api/queries';

/**
 * Cambiar la propia contraseña.
 *
 * Pide la actual, y no es burocracia: sin eso, cualquiera que se siente ante
 * una sesión abierta podría cambiarla y dejar fuera a su dueño. Es la
 * diferencia entre una sesión secuestrada doce horas y una cuenta perdida.
 *
 * La validación usa `evaluatePassword` de `@tax/shared`, la misma función que
 * aplica el servidor. Si el panel juzgara con sus propias reglas, el operador
 * escribiría algo que a sus ojos vale y recibiría un error sin entender nada.
 */

export function Medidor({ fuerza }: { fuerza: number }) {
  // Cuatro tramos y no un porcentaje: un número exacto invita a pelearse con
  // el medidor en vez de a escribir algo más largo.
  const tonos = [
    'bg-[var(--t-critical-solid)]',
    'bg-[var(--t-critical-solid)]',
    'bg-[var(--t-warning-solid)]',
    'bg-[var(--t-positive-solid)]',
    'bg-[var(--t-positive-solid)]',
  ];

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <motion.div
            key={i}
            animate={{ opacity: i < fuerza ? 1 : 0.18 }}
            transition={transition.base}
            className={cn('h-1 flex-1 rounded-full', i < fuerza ? tonos[fuerza] : 'bg-line-strong')}
          />
        ))}
      </div>
      <p className="text-micro text-ink-muted">{PASSWORD_STRENGTH_LABEL[fuerza]}</p>
    </div>
  );
}

export function CambiarClave() {
  const [abierto, setAbierto] = useState(false);
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [repetida, setRepetida] = useState('');
  const [error, setError] = useState<string>();
  const [listo, setListo] = useState(false);

  const sesion = useSesion();
  const usuario = sesion.data?.user;

  const veredicto = useMemo(
    () => evaluatePassword(nueva, { email: usuario?.email, name: usuario?.name }),
    [nueva, usuario?.email, usuario?.name],
  );

  const coinciden = nueva.length > 0 && nueva === repetida;
  const puedeEnviar = actual.length > 0 && veredicto.ok && coinciden;

  const cambiar = useMutation({
    mutationFn: () =>
      api.post('/v1/auth/password', { currentPassword: actual, newPassword: nueva }),
    onSuccess: () => {
      setListo(true);
      setError(undefined);
    },
    onError: (causa: unknown) => {
      setError(
        causa instanceof ApiError
          ? causa.message
          : 'No se pudo cambiar la contraseña. Inténtalo de nuevo.',
      );
    },
  });

  const cerrar = () => {
    setAbierto(false);
    setActual('');
    setNueva('');
    setRepetida('');
    setError(undefined);
    setListo(false);
  };

  return (
    <>
      <button
        onClick={() => setAbierto(true)}
        className="text-micro text-ink-muted transition-colors duration-150 hover:text-ink"
      >
        Cambiar contraseña
      </button>

      <Sheet
        open={abierto}
        onClose={cerrar}
        title="Cambiar contraseña"
        subtitle={listo ? undefined : usuario?.email}
      >
        {listo ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={transition.enter}
            className="space-y-4"
          >
            <Banner tone="positive" icon={<Check className="size-4" />}>
              Contraseña cambiada. Tus otras sesiones abiertas quedaron cerradas; esta sigue
              funcionando.
            </Banner>
            <Button variant="primary" size="lg" className="w-full" onClick={cerrar}>
              Entendido
            </Button>
          </motion.div>
        ) : (
          <div className="space-y-4">
            <Field label="Contraseña actual" htmlFor="actual" required>
              <Input
                id="actual"
                type="password"
                autoComplete="current-password"
                value={actual}
                onChange={(e) => setActual(e.target.value)}
              />
            </Field>

            <Field
              label="Contraseña nueva"
              htmlFor="nueva"
              required
              hint={`Al menos ${PASSWORD_MIN_LENGTH} caracteres. Una frase que recuerdes vale más que algo corto con símbolos.`}
            >
              <Input
                id="nueva"
                type="password"
                autoComplete="new-password"
                value={nueva}
                onChange={(e) => setNueva(e.target.value)}
              />
            </Field>

            {nueva ? <Medidor fuerza={veredicto.fuerza} /> : null}

            {nueva && veredicto.problemas.length > 0 ? (
              <ul className="space-y-1 rounded-md border border-[var(--t-warning-line)] bg-[var(--t-warning-bg)] p-3 text-caption text-[var(--t-warning-ink)]">
                {veredicto.problemas.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}

            <Field
              label="Repite la nueva"
              htmlFor="repetida"
              required
              error={repetida && !coinciden ? 'No coinciden.' : undefined}
            >
              <Input
                id="repetida"
                type="password"
                autoComplete="new-password"
                value={repetida}
                onChange={(e) => setRepetida(e.target.value)}
              />
            </Field>

            {error ? <Banner tone="critical">{error}</Banner> : null}

            <p className="text-micro text-ink-muted">
              Al cambiarla se cerrarán tus otras sesiones abiertas. Tu segundo factor no cambia.
            </p>

            <Button
              variant="primary"
              size="lg"
              className="w-full"
              icon={<KeyRound className="size-4" />}
              disabled={!puedeEnviar}
              loading={cambiar.isPending}
              onClick={() => cambiar.mutate()}
            >
              Cambiar contraseña
            </Button>
          </div>
        )}
      </Sheet>
    </>
  );
}
