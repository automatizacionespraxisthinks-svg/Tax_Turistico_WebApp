import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Camera, Flag, LocateFixed, Lock, Navigation, Phone, UserCheck, X } from 'lucide-react';
import type { RideStatus, StatusTone } from '@tax/shared';
import { RIDE_STATUS_LABEL, RIDE_STATUS_TONE, formatDistance } from '@tax/shared';
import { StatusPill, TONE_CLASS, cn, spring, transition } from '@tax/ui';
import { ActionBar, AddressBlock, Screen } from '../components/Chrome';
import { AvisoDeUbicacion, IrConMapas } from '../components/IrConMapas';
import { api } from '../api/client';
import type { OfferedRide } from '../state/session';

type ActiveStatus = Extract<RideStatus, 'ASSIGNED' | 'DRIVER_ARRIVED' | 'IN_PROGRESS'>;

const STEPS: ActiveStatus[] = ['ASSIGNED', 'DRIVER_ARRIVED', 'IN_PROGRESS'];

/**
 * Carrera en curso: un solo botón grande por estado.
 *
 * El botón lleva el color de la etapa, el mismo que la carrera tiene en el
 * panel de la oficina: azul mientras va a recoger, morado en el punto, verde
 * azulado con el pasajero a bordo. Así el conductor sabe en qué paso está sin
 * leer, y la oficina y él hablan del mismo color.
 *
 * Debajo de la dirección van Maps y Waze, ya con la ruta pedida, y un aviso
 * cuando el punto no es la ubicación que compartió el cliente.
 *
 * "Llegué" solo se habilita a menos de 150 m del punto; más lejos se puede
 * marcar igual, pero queda registrada la excepción (§5.3). "Finalizar" queda
 * bloqueado los primeros minutos con el pasajero a bordo: el servidor no deja
 * cerrar antes, y un botón que siempre falla es peor que uno que dice cuánto
 * falta.
 */
export function Carrera({
  offer,
  status,
  metersToPickup,
  minRideMinutes,
  onArrived,
  onBoard,
  onFinish,
}: {
  offer: OfferedRide;
  status: ActiveStatus;
  metersToPickup: number | null;
  minRideMinutes: number;
  onArrived: () => void;
  onBoard: () => void;
  onFinish: () => void;
}) {
  // Sin punto (carrera sin ubicar) no hay distancia que medir: el conductor
  // se guía por la dirección y marca «Llegué» cuando lo encuentre.
  const conPunto = offer.pickupPoint !== undefined;
  const nearby = conPunto && metersToPickup !== null && metersToPickup <= 150;
  const stepIndex = STEPS.indexOf(status);
  const tone = RIDE_STATUS_TONE[status];
  const faltan = useFaltaParaFinalizar(status === 'IN_PROGRESS' ? offer.startedAt : undefined, minRideMinutes);

  return (
    <>
      <Screen className="gap-4">
        <Progress stepIndex={stepIndex} tone={tone} />

        <div className="flex items-center justify-between gap-3">
          <StatusPill tone={tone} size="md" live>
            {RIDE_STATUS_LABEL[status]}
          </StatusPill>
          <span className="font-mono text-caption text-ink-muted">{offer.code}</span>
        </div>

        {status === 'IN_PROGRESS' ? (
          <div className="flex flex-col gap-3">
            <AddressBlock label="Llevar a" text={offer.dropoffText ?? 'Sin destino indicado'} />
            {/* Al destino solo con coordenadas: casi siempre lo dicen ya a
                bordo, y una dirección suelta puede ser de otro pueblo. */}
            <IrConMapas point={offer.dropoffPoint} />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <AddressBlock
              label="Recoger en"
              text={offer.pickupText}
              reference={offer.pickupReference}
            />
            <AvisoDeUbicacion origen={offer.pickupSource} />
            <IrConMapas point={offer.pickupPoint} text={offer.pickupText} />
          </div>
        )}

        {/* La foto solo mientras va a recogerlo: después ya no le sirve, y
            es la puerta de la casa de alguien. */}
        {status !== 'IN_PROGRESS' && offer.pickupPhotoAt ? (
          <FotoDelLugar rideId={offer.rideId} version={offer.pickupPhotoAt} />
        ) : null}

        {status !== 'IN_PROGRESS' && conPunto ? (
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
                {nearby
                  ? 'Estás en el punto'
                  : metersToPickup === null
                    ? 'Buscando tu posición…'
                    : `A ${formatDistance(metersToPickup / 1000)} del punto`}
              </p>
              <p className="text-caption text-ink-muted">
                {nearby
                  ? 'Puedes marcar que llegaste.'
                  : metersToPickup === null
                    ? 'La distancia aparece en cuanto responda el GPS.'
                    : 'La distancia se actualiza con tu GPS.'}
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
      </Screen>

      <ActionBar>
        {status === 'ASSIGNED' ? (
          <BotonDeEtapa tone={tone} icon={<Navigation className="size-6" />} onClick={onArrived}>
            {nearby ? 'Llegué al punto' : 'Marcar que llegué'}
          </BotonDeEtapa>
        ) : null}

        {status === 'DRIVER_ARRIVED' ? (
          <BotonDeEtapa tone={tone} icon={<UserCheck className="size-6" />} onClick={onBoard}>
            Pasajero a bordo
          </BotonDeEtapa>
        ) : null}

        {status === 'IN_PROGRESS' ? (
          faltan > 0 ? (
            <BotonDeEtapa
              tone={tone}
              icon={<Lock className="size-6" />}
              disabled
              progreso={1 - faltan / (minRideMinutes * 60_000)}
            >
              Finalizar en <span className="tnum">{formatoCuenta(faltan)}</span>
            </BotonDeEtapa>
          ) : (
            <BotonDeEtapa tone={tone} icon={<Flag className="size-6" />} onClick={onFinish}>
              Finalizar carrera
            </BotonDeEtapa>
          )
        ) : null}

        {!nearby && status === 'ASSIGNED' && conPunto && metersToPickup !== null ? (
          <p className="text-center text-base text-ink-muted">
            Estás a más de 150 m; si marcas ahora, queda registrada la excepción.
          </p>
        ) : null}

        {status === 'IN_PROGRESS' && faltan > 0 ? (
          <p className="text-center text-base text-ink-muted">
            Una carrera dura al menos {minRideMinutes} minutos desde que sube el pasajero.
          </p>
        ) : null}
      </ActionBar>
    </>
  );
}

/** Milisegundos que faltan para poder finalizar; 0 si ya se puede. */
function useFaltaParaFinalizar(startedAt: number | undefined, minutos: number): number {
  const calcular = () => (startedAt === undefined ? 0 : Math.max(0, startedAt + minutos * 60_000 - Date.now()));
  const [faltan, setFaltan] = useState(calcular);

  // Al subir el pasajero, la cuenta se pone al día en este mismo render. En
  // el efecto llegaba un render tarde, y «Finalizar» se pintaba habilitado
  // un instante antes de bloquearse.
  const [startedAtPrevio, setStartedAtPrevio] = useState(startedAt);
  if (startedAtPrevio !== startedAt) {
    setStartedAtPrevio(startedAt);
    setFaltan(calcular());
  }

  useEffect(() => {
    if (startedAt === undefined) return;
    const id = window.setInterval(() => {
      const siguiente = calcular();
      setFaltan(siguiente);
      if (siguiente === 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
    // `calcular` cambia con cada render; lo que importa son sus entradas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt, minutos]);

  return faltan;
}

/** «7:42», hacia abajo y sin saltos de anchura gracias a `tnum`. */
function formatoCuenta(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * El botón de cada etapa: grande, con letra de 24 px y el color del estado.
 *
 * Bloqueado se queda gris, y por dentro se va llenando del color de la etapa
 * a medida que pasa el tiempo: se ve de lejos cuánto falta sin leer el número.
 */
function BotonDeEtapa({
  tone,
  icon,
  children,
  onClick,
  disabled = false,
  progreso,
}: {
  tone: StatusTone;
  icon: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  progreso?: number;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.985 }}
      transition={spring.snappy}
      className={cn(
        TONE_CLASS[tone],
        'relative flex h-[4.5rem] w-full items-center justify-center overflow-hidden rounded-lg px-6',
        'text-2xl font-bold tracking-[-0.01em]',
        disabled
          ? 'cursor-not-allowed border border-line bg-surface-sunk text-ink-secondary'
          : 'border border-transparent bg-[var(--tone-solid)] text-on-accent shadow-sm',
      )}
    >
      {progreso !== undefined ? (
        <motion.span
          aria-hidden="true"
          initial={false}
          animate={{ scaleX: Math.min(1, Math.max(0, progreso)) }}
          transition={{ duration: 0.9, ease: 'linear' }}
          style={{ originX: 0 }}
          className="absolute inset-0 bg-[var(--tone-bg)]"
        />
      ) : null}
      <span className="relative flex items-center gap-3">
        {icon}
        <span>{children}</span>
      </span>
    </motion.button>
  );
}

/**
 * La foto que mandó el cliente: la puerta, la esquina, la tienda de al lado.
 * En una vereda dice lo que una dirección no dice nunca. Tocándola se ve a
 * pantalla completa.
 */
function FotoDelLugar({ rideId, version }: { rideId: string; version: string }) {
  const [url, setUrl] = useState<string>();
  const [fallo, setFallo] = useState(false);
  const [grande, setGrande] = useState(false);

  useEffect(() => {
    let creada: string | undefined;
    let cancelado = false;
    setFallo(false);
    api
      .imagen(`/v1/driver/rides/${rideId}/photo`)
      .then((blob) => {
        if (cancelado) return;
        creada = URL.createObjectURL(blob);
        setUrl(creada);
      })
      .catch(() => {
        if (!cancelado) setFallo(true);
      });
    return () => {
      cancelado = true;
      if (creada) URL.revokeObjectURL(creada);
    };
    // `version` cambia si el cliente manda otra foto: hay que pedirla de nuevo.
  }, [rideId, version]);

  if (fallo) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => url && setGrande(true)}
        className="overflow-hidden rounded-lg border border-line bg-surface text-left"
      >
        <p className="flex items-center gap-1.5 px-4 pb-2 pt-3 text-micro font-semibold uppercase tracking-[0.07em] text-ink-muted">
          <Camera className="size-3.5" />
          Foto que envió el cliente
        </p>
        {url ? (
          <img src={url} alt="Foto del lugar de recogida" className="max-h-56 w-full object-cover" />
        ) : (
          <div className="animate-breathe h-40 w-full bg-surface-sunk" />
        )}
        <p className="px-4 py-2 text-caption text-ink-muted">Toca la foto para verla completa.</p>
      </button>

      <AnimatePresence>
        {grande && url ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transition.fast}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-3"
            onClick={() => setGrande(false)}
          >
            <img src={url} alt="Foto del lugar de recogida" className="max-h-full max-w-full object-contain" />
            <button
              type="button"
              aria-label="Cerrar la foto"
              onClick={() => setGrande(false)}
              className="absolute right-4 top-4 flex size-12 items-center justify-center rounded-full bg-white/15 text-white"
            >
              <X className="size-6" />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/** Tres pasos; el relleno avanza, no salta, y lleva el color de la etapa. */
function Progress({ stepIndex, tone }: { stepIndex: number; tone: StatusTone }) {
  return (
    <div className={cn(TONE_CLASS[tone], 'flex items-center gap-1.5')}>
      {STEPS.map((step, index) => (
        <div key={step} className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunk">
          <motion.div
            initial={false}
            animate={{ scaleX: index <= stepIndex ? 1 : 0 }}
            transition={transition.panel}
            style={{ originX: 0 }}
            className="h-full rounded-full bg-[var(--tone-solid)]"
          />
        </div>
      ))}
    </div>
  );
}
