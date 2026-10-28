import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Ban, Camera, Car, MessageSquare, RefreshCw } from 'lucide-react';
import type { Driver, Ride, RideOffer, WaveLogEntry } from '@tax/shared';
import {
  ACTOR_LABEL,
  RIDE_STATUS_LABEL,
  RIDE_STATUS_TONE,
  formatDateTime,
  formatDistance,
  formatTime,
  haversineKm,
  maskPhone,
  OLEADA_A_TODOS,
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
import { API_BASE, api } from '../api/client';

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
  const pestanas = useRef<HTMLDivElement>(null);

  // La pestaña de oleadas puede ser larga. Sin esto, al pasar a la bitácora
  // el panel se quedaba donde terminaban las oleadas y se veía en blanco.
  const cambiarPestana = (siguiente: DetailTab) => {
    setTab(siguiente);
    pestanas.current?.scrollIntoView({ block: 'nearest' });
  };
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

      <div ref={pestanas}>
        <Tabs
          value={tab}
          onChange={cambiarPestana}
          options={[
            { value: 'resumen', label: 'Resumen' },
            { value: 'oleadas', label: 'Oleadas', count: ride.waveLog?.length || ride.offers.length },
            { value: 'bitacora', label: 'Bitácora', count: ride.history.length },
          ]}
        />
      </div>

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

      {ride.customerId ? <TelefonoDePrueba ride={ride} /> : null}

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

      {ride.pickupPhotoAt ? <FotoDelLugar rideId={ride.id} version={ride.pickupPhotoAt} /> : null}

      {/* Sin precios: la empresa no los maneja desde el sistema. Lo que sí
          cuenta para la operación es cuánto se recorrió. */}
      <div>
        <SectionLabel>Recorrido</SectionLabel>
        <div className="mt-2 rounded-md border border-line bg-surface-sunk px-3 py-2.5">
          <p className="text-title font-semibold tnum text-ink">
            {ride.distanceKm !== undefined ? formatKm(ride.distanceKm) : '—'}
          </p>
          <p className="text-micro text-ink-muted">
            {ride.distanceKm !== undefined
              ? ride.dropoffSource === 'conductor'
                ? `Hasta donde el conductor la finalizó · zona ${zone?.name ?? '—'}`
                : `Hasta el destino que dijo el cliente · zona ${zone?.name ?? '—'}`
              : `Se mide al finalizar · zona ${zone?.name ?? '—'}`}
          </p>
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

const RESPUESTA: Record<RideOffer['response'], { label: string; tone: 'positive' | 'warning' | 'critical' | 'neutral' }> = {
  accepted: { label: 'Aceptó', tone: 'positive' },
  pending: { label: 'Pendiente', tone: 'warning' },
  rejected: { label: 'Rechazó', tone: 'critical' },
  expired: { label: 'No contestó', tone: 'neutral' },
  revoked: { label: 'Revocada', tone: 'neutral' },
};

/**
 * El reloj de la pestaña. Solo late mientras hay una oleada en curso: con la
 * carrera ya asignada o sin asignar no hay nada que contar, y un intervalo
 * corriendo para nada en cada ficha abierta es trabajo regalado.
 */
function useAhora(activo: boolean): number {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    if (!activo) return;
    setAhora(Date.now());
    const id = window.setInterval(() => setAhora(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [activo]);
  return ahora;
}

/**
 * Parte el registro en lanzamientos: el primero, y uno por cada «Relanzar».
 *
 * Las entradas nuevas dicen a qué intento pertenecen. Las de antes no, y ahí
 * cada oleada 1 marca el comienzo de uno: el despacho siempre arranca por la
 * oleada 1, así que es la misma regla dicha de otra forma. Se agrupa por
 * secuencia y no por número para que un registro viejo seguido de uno nuevo
 * no mezcle dos lanzamientos distintos que compartan número.
 */
function agruparPorIntento(registro: WaveLogEntry[]): WaveLogEntry[][] {
  const grupos: WaveLogEntry[][] = [];
  for (const entrada of registro) {
    const previa = grupos.at(-1)?.at(-1);
    const abreOtro =
      previa === undefined ||
      (entrada.intento !== undefined ? entrada.intento !== previa.intento : entrada.wave === 1);
    if (abreOtro) grupos.push([entrada]);
    else grupos.at(-1)!.push(entrada);
  }
  return grupos;
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function Oleadas({ ride }: { ride: Ride }) {
  const registro = ride.waveLog ?? [];
  const ultima = registro.at(-1);
  const enCurso =
    ride.status === 'NOTIFIED' && ultima !== undefined && ultima.expiresAt !== null ? ultima : undefined;
  const ahora = useAhora(Boolean(enCurso));
  const grupos = agruparPorIntento(registro);

  /*
   * Una oleada que no halló a nadie no tiene ofertas, aunque haya otras de
   * su mismo número en otro lanzamiento. Sin esta guarda, los relanzamientos
   * vacíos mostraban las ofertas del primero como si fueran suyas.
   */
  const ofertasDe = (entrada: WaveLogEntry) =>
    entrada.candidates === 0
      ? []
      : ride.offers.filter((o) => o.wave === entrada.wave && o.intento === (entrada.intento ?? 1));

  // Carreras de antes de que existiera el registro: solo hay ofertas, así
  // que se agrupan por oleada como se hacía siempre.
  if (registro.length === 0) {
    return ride.offers.length > 0 ? (
      <OleadasSinRegistro ride={ride} />
    ) : (
      <p className="text-caption text-ink-muted">
        {ride.status === 'PENDING'
          ? 'Buscando conductores…'
          : 'Esta carrera no pasó por el despacho automático.'}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-caption text-ink-muted">
        Cada oleada busca más lejos y espera más. Si no encuentra a nadie, pasa a la siguiente sin
        esperar el reloj.
      </p>

      {grupos.map((grupo, g) => (
        <section key={grupo[0]!.startedAt} className="space-y-2">
          {/* Con un solo lanzamiento, el título sobra. */}
          {grupos.length > 1 ? (
            <SectionLabel>{g === 0 ? 'Primer lanzamiento' : `Relanzamiento ${g}`}</SectionLabel>
          ) : null}
          <ol className="space-y-3">
            {grupo.map((entrada) => (
              <OleadaFila
                key={`${entrada.wave}-${entrada.startedAt}`}
                entrada={entrada}
                ofertas={ofertasDe(entrada)}
                enCurso={entrada === enCurso}
                ahora={ahora}
                esLaUltima={entrada === ultima}
                estado={ride.status}
              />
            ))}
          </ol>
        </section>
      ))}

      {/* Agotadas todas: que se lea el final, no solo que paró de moverse. */}
      {ride.status === 'UNASSIGNED' ? (
        <p className="tone-critical rounded-md border border-[var(--tone-line)] bg-[var(--tone-bg)] px-3 py-2 text-caption text-[var(--tone-ink)]">
          Nadie aceptó. La carrera quedó sin asignar y espera a la oficina.
        </p>
      ) : null}
    </div>
  );
}

function OleadaFila({
  entrada,
  ofertas,
  enCurso,
  ahora,
  esLaUltima,
  estado,
}: {
  entrada: WaveLogEntry;
  ofertas: RideOffer[];
  enCurso: boolean;
  ahora: number;
  esLaUltima: boolean;
  estado: Ride['status'];
}) {
  const aTodos = entrada.wave === OLEADA_A_TODOS;
  const titulo = aTodos ? 'Todos los disponibles' : `Oleada ${entrada.wave}`;
  const alcance =
    entrada.radiusKm === null ? 'sin límite de distancia' : `hasta ${formatDistance(entrada.radiusKm)}`;

  const inicio = new Date(entrada.startedAt).getTime();
  const fin = entrada.expiresAt ? new Date(entrada.expiresAt).getTime() : inicio;
  const restante = fin - ahora;
  const fraccion = enCurso && fin > inicio ? Math.min(1, Math.max(0, restante / (fin - inicio))) : 0;
  const aceptada = ofertas.some((o) => o.response === 'accepted');

  let lateral: string;
  if (entrada.candidates === 0) lateral = 'Pasó al instante';
  else if (aceptada) lateral = 'Aceptada';
  else if (enCurso) lateral = restante > 0 ? mmss(restante) : 'Pasando…';
  else if (esLaUltima && estado === 'NOTIFIED') lateral = 'Pasando…';
  // Si todos dijeron que no, la oleada no venció: la cerraron antes de tiempo.
  else if (ofertas.length > 0 && ofertas.every((o) => o.response === 'rejected')) lateral = 'Rechazada';
  else lateral = 'Venció';

  const disponiblesSinGps = entrada.sinGps ?? 0;

  return (
    <li className={cn('rounded-md border px-3 py-2.5', enCurso ? 'tone-warning border-[var(--tone-line)]' : 'border-line')}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-medium text-ink">
            {titulo}
            <span className="ml-1.5 text-caption font-normal text-ink-muted">· {alcance}</span>
          </p>
          <p className="text-micro text-ink-muted">
            <time title={formatDateTime(entrada.startedAt)}>{formatTime(entrada.startedAt)}</time>
            {' · '}
            {entrada.candidates === 0
              ? 'nadie disponible'
              : `${entrada.candidates} ${entrada.candidates === 1 ? 'conductor' : 'conductores'}`}
            {disponiblesSinGps > 0
              ? ` · ${disponiblesSinGps} disponible${disponiblesSinGps === 1 ? '' : 's'} sin GPS`
              : ''}
          </p>
        </div>
        <span
          className={cn(
            'tnum shrink-0 text-caption font-medium',
            aceptada && TONE_CLASS.positive,
            enCurso || aceptada ? 'text-[var(--tone-ink)]' : 'text-ink-muted',
          )}
        >
          {lateral}
        </span>
      </div>

      {/* La barra se vacía con el reloj: se ve de un vistazo cuánto le queda. */}
      {enCurso ? (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--tone-bg)]">
          <div
            className="h-full rounded-full bg-[var(--tone-solid)] transition-[width] duration-500 ease-linear"
            style={{ width: `${fraccion * 100}%` }}
          />
        </div>
      ) : null}

      {ofertas.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {ofertas.map((offer) => (
            <OfertaFila key={`${offer.driverId}-${offer.sentAt}`} offer={offer} />
          ))}
        </ul>
      ) : null}

      {disponiblesSinGps > 0 && entrada.candidates === 0 ? (
        <p className="mt-1.5 text-micro text-ink-muted">
          Hay conductores en turno, pero ninguno ha mandado su ubicación: sin ella no se les puede
          ofrecer la carrera.
        </p>
      ) : null}
    </li>
  );
}

function OfertaFila({ offer }: { offer: RideOffer }) {
  const { label, tone } = RESPUESTA[offer.response];
  return (
    <li
      className={cn(
        TONE_CLASS[tone],
        'flex items-center gap-3 rounded border border-transparent px-2 py-1.5',
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
}

/** Para carreras anteriores al registro de oleadas: solo hay ofertas. */
function OleadasSinRegistro({ ride }: { ride: Ride }) {
  const waves = [...new Set(ride.offers.map((o) => o.wave))].sort();
  return (
    <div className="space-y-4">
      {waves.map((wave) => (
        <div key={wave}>
          <SectionLabel>{wave === OLEADA_A_TODOS ? 'Todos los disponibles' : `Oleada ${wave}`}</SectionLabel>
          <ul className="mt-2 space-y-1.5">
            {ride.offers
              .filter((o) => o.wave === wave)
              .map((offer) => (
                <OfertaFila key={`${offer.driverId}-${offer.sentAt}`} offer={offer} />
              ))}
          </ul>
        </div>
      ))}
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

/**
 * La foto del lugar que mandó el cliente, la misma que ve el conductor. Va
 * con la sesión de la oficina, que un `<img src>` no lleva a otro dominio.
 */
function FotoDelLugar({ rideId, version }: { rideId: string; version: string }) {
  const [url, setUrl] = useState<string>();
  const [fallo, setFallo] = useState(false);

  useEffect(() => {
    let creada: string | undefined;
    let cancelado = false;
    setFallo(false);
    fetch(`${API_BASE}/v1/admin/rides/${rideId}/photo`, { credentials: 'include' })
      .then(async (respuesta) => {
        if (!respuesta.ok) throw new Error(String(respuesta.status));
        const blob = await respuesta.blob();
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
  }, [rideId, version]);

  return (
    <div>
      <SectionLabel>Foto del lugar</SectionLabel>
      <div className="mt-2 overflow-hidden rounded-md border border-line bg-surface-sunk">
        {fallo ? (
          <p className="px-3 py-2.5 text-caption text-ink-muted">
            La foto ya no está disponible: se borran a los 30 días.
          </p>
        ) : url ? (
          <a href={url} target="_blank" rel="noreferrer" title="Abrir la foto en grande">
            <img src={url} alt="Foto del lugar de recogida" className="max-h-64 w-full object-cover" />
          </a>
        ) : (
          <div className="animate-breathe h-40 w-full" />
        )}
        <p className="flex items-center gap-1.5 border-t border-line px-3 py-1.5 text-micro text-ink-muted">
          <Camera className="size-3" />
          La mandó el cliente por WhatsApp · el conductor la ve mientras va a recogerlo
        </p>
      </div>
    </div>
  );
}

/**
 * Un teléfono del equipo con el que se prueba el servicio. Marcarlo saca de
 * Reportes todas sus carreras, también las de antes, cuando está puesto
 * «No incluir pruebas».
 */
function TelefonoDePrueba({ ride }: { ride: Ride }) {
  const toast = useToast();
  const [marcado, setMarcado] = useState(ride.customerEsPrueba ?? false);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => setMarcado(ride.customerEsPrueba ?? false), [ride.customerEsPrueba]);

  const cambiar = async () => {
    setGuardando(true);
    try {
      await api.patch(`/v1/admin/customers/${ride.customerId}`, { esPrueba: !marcado });
      setMarcado(!marcado);
      toast.push({
        tone: 'info',
        title: marcado ? 'Ya no es un teléfono de prueba' : 'Marcado como teléfono de prueba',
        description: marcado
          ? 'Sus carreras vuelven a contar en Reportes.'
          : 'Reportes puede dejar fuera todas sus carreras, también las de antes.',
      });
    } catch {
      toast.push({ tone: 'critical', title: 'No se pudo cambiar la marca de prueba' });
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-caption font-medium text-ink">
          {marcado ? 'Teléfono de prueba' : '¿Es un teléfono de prueba?'}
        </p>
        <p className="text-micro text-ink-muted">
          {marcado
            ? 'Sus carreras no cuentan en Reportes con «No incluir pruebas».'
            : 'Márcalo si es del equipo y se usó para probar el servicio.'}
        </p>
      </div>
      <Button size="sm" variant="secondary" loading={guardando} onClick={() => void cambiar()}>
        {marcado ? 'Quitar marca' : 'Marcar'}
      </Button>
    </div>
  );
}
