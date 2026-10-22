import { motion } from 'motion/react';
import { BellOff, BellRing, Coffee, LogOut, Play, Radar } from 'lucide-react';
import { formatDuration, formatMoney } from '@tax/shared';
import { useState } from 'react';
import { Button, Field, Input, StatusPill, transition } from '@tax/ui';
import { ActionBar, DataRow, Screen } from '../components/Chrome';
import type { SessionState } from '../state/session';
import type { PushState } from '../api/push';
import { Instalar } from '../components/Instalar';

/**
 * Tres estados de espera en una sola pantalla: fuera de turno, disponible y en
 * pausa. Lo único que cambia es el bloque central y los botones; así el
 * conductor no aprende tres pantallas distintas.
 */
export function Turno({
  session,
  push,
  onEnablePush,
  onStartShift,
  onEndShift,
  onPause,
  onResume,
}: {
  session: SessionState;
  /** Si el teléfono avisará con la aplicación cerrada (ADR-07). */
  push: PushState;
  onEnablePush: () => void;
  /** La relación conductor–vehículo es por turno, no fija (§6). */
  onStartShift: (plate: string) => void;
  onEndShift: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  // Se recuerda la última placa: casi siempre es el mismo carro, pero puede
  // cambiar, y escribirla cada mañana con guantes sería absurdo.
  const [plate, setPlate] = useState(() => {
    try {
      return window.localStorage.getItem('tax.driver.plate') ?? '';
    } catch {
      return '';
    }
  });

  const start = () => {
    const normalized = plate.trim().toUpperCase();
    try {
      window.localStorage.setItem('tax.driver.plate', normalized);
    } catch {
      // Sin almacenamiento se escribe cada vez; no impide trabajar.
    }
    onStartShift(normalized);
  };
  const available = session.phase === 'available';
  const paused = session.phase === 'paused';
  const onShift = available || paused;

  const shiftSeconds = session.shiftStartedAt
    ? Math.floor((Date.now() - session.shiftStartedAt) / 1000)
    : 0;

  return (
    <>
      <Screen>
        <div className="flex flex-col items-center justify-center gap-5 py-10 text-center">
          {/* Mientras está disponible, el halo late: la app está escuchando. */}
          <div className="relative flex size-28 items-center justify-center">
            {available ? (
              <>
                <span
                  className="tone-positive absolute size-16 rounded-full bg-[var(--tone-solid)] opacity-20"
                  style={{ animation: 'tax-beacon 2.4s var(--ease-soft) infinite' }}
                />
                <span
                  className="tone-positive absolute size-16 rounded-full bg-[var(--tone-solid)] opacity-20"
                  style={{ animation: 'tax-beacon 2.4s var(--ease-soft) infinite 1.2s' }}
                />
              </>
            ) : null}
            <div
              className={cnTone(available ? 'tone-positive' : paused ? 'tone-warning' : 'tone-neutral')}
            >
              <Radar className="size-8" />
            </div>
          </div>

          <div>
            <motion.h1
              key={session.phase}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={transition.enter}
              className="text-display font-semibold tracking-[-0.02em] text-ink"
            >
              {available ? 'Esperando carrera' : paused ? 'En pausa' : 'Fuera de turno'}
            </motion.h1>
            <p className="mt-2 text-lg text-ink-secondary">
              {available
                ? 'Te avisamos con sonido y vibración cuando llegue una oferta.'
                : paused
                  ? 'No recibirás ofertas hasta que vuelvas a estar disponible.'
                  : 'Abre el turno para empezar a recibir carreras.'}
            </p>
          </div>

          {onShift ? (
            <StatusPill tone={available ? 'positive' : 'warning'} size="md" live={available}>
              Turno abierto · {formatDuration(shiftSeconds)}
            </StatusPill>
          ) : null}
        </div>

        {!onShift ? (
          <Field label="Placa del vehículo de hoy" htmlFor="plate" required>
            <Input
              id="plate"
              autoCapitalize="characters"
              value={plate}
              onChange={(event) => setPlate(event.target.value.toUpperCase())}
              placeholder="UBP472"
              className="h-14 font-mono text-xl tracking-[0.08em]"
            />
          </Field>
        ) : null}

        <div className="rounded-lg border border-line bg-surface px-4">
          <DataRow label="Carreras de hoy" value={session.ridesToday} />
          <DataRow label="Total estimado" value={formatMoney(session.earnedToday)} />
          {plate ? <DataRow label="Vehículo" value={plate} /> : null}
        </div>

        <Instalar compacto />

        {onShift ? <AvisoPush estado={push} onActivar={onEnablePush} /> : null}

        {!onShift ? (
          <p className="text-caption text-ink-muted">
            El GPS solo se registra con el turno abierto. Al cerrarlo deja de enviarse tu posición.
          </p>
        ) : null}
      </Screen>

      <ActionBar>
        {!onShift ? (
          <Button
            variant="primary"
            size="touch"
            icon={<Play className="size-5" />}
            disabled={plate.trim().length < 5}
            onClick={start}
          >
            Iniciar turno
          </Button>
        ) : null}

        {available ? (
          <Button size="touch" icon={<Coffee className="size-5" />} onClick={onPause}>
            Tomar una pausa
          </Button>
        ) : null}

        {paused ? (
          <Button variant="primary" size="touch" icon={<Play className="size-5" />} onClick={onResume}>
            Volver a estar disponible
          </Button>
        ) : null}

        {onShift ? (
          <Button variant="ghost" size="lg" className="w-full" icon={<LogOut className="size-4" />} onClick={onEndShift}>
            Cerrar turno
          </Button>
        ) : null}
      </ActionBar>
    </>
  );
}

function cnTone(tone: string) {
  return `${tone} relative flex size-16 items-center justify-center rounded-full border border-[var(--tone-line)] bg-[var(--tone-bg)] text-[var(--tone-ink)]`;
}

/**
 * Estado de los avisos.
 *
 * Es importante que el conductor sepa la verdad: creer que el teléfono va a
 * sonar cuando no va a sonar significa perder carreras sin entender por qué.
 * Por eso cada caso dice qué pasa y qué hacer, en vez de un icono tachado.
 */
function AvisoPush({ estado, onActivar }: { estado: PushState; onActivar: () => void }) {
  if (estado === 'no-soportado') return null;

  if (estado === 'activo') {
    return (
      <p className="flex items-center justify-center gap-1.5 text-caption text-ink-muted">
        <BellRing className="size-3.5" />
        Te avisamos aunque cierres la aplicación.
      </p>
    );
  }

  const contenido: Record<Exclude<PushState, 'activo' | 'no-soportado'>, { texto: string; accion?: string }> = {
    'sin-permiso': {
      texto: 'Sin avisos: solo verás las carreras con la aplicación abierta.',
      accion: 'Activar avisos',
    },
    denegado: {
      texto:
        'Los avisos están bloqueados en este teléfono. Actívalos en los ajustes del navegador para este sitio.',
    },
    'requiere-instalar': {
      texto:
        'Instala la aplicación en la pantalla de inicio para recibir avisos con la pantalla bloqueada.',
    },
  };

  const { texto, accion } = contenido[estado];

  return (
    <div className="tone-warning flex flex-col gap-2 rounded-lg border border-[var(--tone-line)] bg-[var(--tone-bg)] px-4 py-3">
      <p className="flex items-start gap-2 text-base text-[var(--tone-ink)]">
        <BellOff className="mt-0.5 size-4 shrink-0" />
        {texto}
      </p>
      {accion ? (
        <Button size="lg" className="w-full" onClick={onActivar}>
          {accion}
        </Button>
      ) : null}
    </div>
  );
}
