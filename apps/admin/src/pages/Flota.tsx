import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Ban, Car, CreditCard, Search, ShieldAlert, SignalLow } from 'lucide-react';
import type { Driver, MovilVinculado } from '@tax/shared';
import {
  DRIVER_STATUS_LABEL,
  DRIVER_STATUS_TONE,
  ZONA_HORARIA_PAIPA,
  finDeSuspension,
  formatDistance,
  formatRelative,
  haversineKm,
  maskPhone,
} from '@tax/shared';
import {
  Card,
  EmptyState,
  Input,
  Meta,
  SectionLabel,
  Segmented,
  Sheet,
  Stat,
  StatusPill,
  cn,
  staggerList,
  staggerItem,
  transition,
} from '@tax/ui';
import { useLive } from '../live/store';
import { zoneOf } from '../live/store';
import { useSesion } from '../api/queries';
import { GestionConductor, NuevoConductorBoton } from '../components/ConductorAdmin';

type Filter = 'turno' | 'disponibles' | 'carrera' | 'todos' | 'atencion';

const FILTERS: { value: Filter; label: string; match: (d: Driver) => boolean }[] = [
  { value: 'turno', label: 'En turno', match: (d) => d.status !== 'OFF_SHIFT' },
  { value: 'disponibles', label: 'Disponibles', match: (d) => d.status === 'AVAILABLE' },
  { value: 'carrera', label: 'En carrera', match: (d) => d.status === 'ON_RIDE' },
  {
    value: 'atencion',
    label: 'Con alerta',
    match: (d) =>
      Boolean(d.suspendidoHasta) ||
      !d.deviceRegistered ||
      !d.vehicle.active ||
      Boolean(estadoLicencia(d.licenciaVence).alerta) ||
      (d.status !== 'OFF_SHIFT' && (d.positionAgeSeconds ?? 0) > 60),
  },
  { value: 'todos', label: 'Todos', match: () => true },
];

export function Flota() {
  const drivers = useLive((s) => s.drivers);
  const rides = useLive((s) => s.rides);
  const [filter, setFilter] = useState<Filter>('turno');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sesion = useSesion();
  // Solo cortesía: quien autoriza es el guardia de la API, que exige rol
  // administrador. Enseñar un botón que siempre falla es peor que ocultarlo.
  const esAdmin = sesion.data?.user.role === 'administrador';

  const active = FILTERS.find((f) => f.value === filter) ?? FILTERS[0]!;

  const counts = useMemo(
    () =>
      Object.fromEntries(FILTERS.map((f) => [f.value, drivers.filter(f.match).length])) as Record<
        Filter,
        number
      >,
    [drivers],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return drivers
      .filter((d) => active.match(d))
      .filter(
        (d) =>
          !needle ||
          d.name.toLowerCase().includes(needle) ||
          d.code.includes(needle) ||
          d.vehicle.plate.toLowerCase().includes(needle) ||
          (d.moviles ?? []).some((m) => m.placa.toLowerCase().includes(needle) || m.interno?.includes(needle)),
      )
      .sort((a, b) => Number(b.status !== 'OFF_SHIFT') - Number(a.status !== 'OFF_SHIFT'));
  }, [drivers, active, query]);

  const selected = drivers.find((d) => d.id === selectedId) ?? null;
  const selectedRide = selected?.currentRideId
    ? rides.find((r) => r.id === selected.currentRideId)
    : undefined;

  const stale = drivers.filter(
    (d) => d.status !== 'OFF_SHIFT' && (d.positionAgeSeconds ?? 0) > 60,
  ).length;

  return (
    <div className="space-y-4 p-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Flota vinculada" value={drivers.length} hint="Vehículos habilitados" />
        <Stat label="En turno" value={counts.turno} tone="info" hint="GPS activo durante el turno" />
        <Stat label="Disponibles" value={counts.disponibles} tone="positive" hint="Candidatos a oleada" />
        <Stat
          label="Sin GPS reciente"
          value={stale}
          tone={stale > 0 ? 'warning' : 'positive'}
          icon={<SignalLow className="size-3.5" />}
          hint="Más de 60 s sin posición"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({ value: f.value, label: f.label, count: counts[f.value] }))}
        />
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nombre, código o placa…"
            className="pl-8"
            aria-label="Buscar conductores"
          />
        </div>
        {esAdmin ? <NuevoConductorBoton /> : null}
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Car className="size-4" />}
            title="Ningún conductor coincide"
            description="Ajusta el filtro o limpia la búsqueda."
          />
        </Card>
      ) : (
        <motion.div
          variants={staggerList(rows.length)}
          initial="hidden"
          animate="visible"
          className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3"
        >
          <AnimatePresence initial={false}>
            {rows.map((driver) => (
              <DriverCard key={driver.id} driver={driver} onClick={() => setSelectedId(driver.id)} />
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      <Sheet
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        title={selected?.name ?? ''}
        subtitle={selected ? `Código ${selected.code} · ${vehiculoDe(selected)}` : undefined}
      >
        {selected ? (
          <div className="space-y-5">
            <DriverDetail driver={selected} rideCode={selectedRide?.code} />
            {esAdmin ? <GestionConductor driver={selected} /> : null}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

function DriverCard({ driver, onClick }: { driver: Driver; onClick: () => void }) {
  const stale = driver.status !== 'OFF_SHIFT' && (driver.positionAgeSeconds ?? 0) > 60;
  const licencia = estadoLicencia(driver.licenciaVence);

  return (
    <motion.button
      layout
      variants={staggerItem}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={transition.base}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.99 }}
      onClick={onClick}
      className={cn(
        'rounded-lg border border-line bg-surface p-3 text-left',
        'transition-[border-color,box-shadow] duration-150 ease-[var(--ease-standard)] hover:border-line-strong hover:shadow-sm',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-base font-medium text-ink">{driver.name}</p>
          <p className="text-micro text-ink-muted">
            Código {driver.code} · {vehiculoDe(driver)}
          </p>
        </div>
        <StatusPill
          tone={DRIVER_STATUS_TONE[driver.status]}
          live={driver.status === 'ON_RIDE'}
        >
          {DRIVER_STATUS_LABEL[driver.status]}
        </StatusPill>
      </div>

      <div className="mt-2.5 flex items-center gap-3 text-micro text-ink-muted">
        <span className="tnum">{driver.ridesToday} carreras hoy</span>
        <span className="tnum">{Math.round(driver.acceptanceRate * 100)} % aceptación</span>
        {driver.shiftStartedAt ? (
          <span className="ml-auto">turno {formatRelative(driver.shiftStartedAt)}</span>
        ) : null}
      </div>

      {(driver.suspendidoHasta ||
        driver.aceptaPagoElectronico ||
        stale ||
        !driver.deviceRegistered ||
        !driver.vehicle.active ||
        licencia.alerta) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {driver.suspendidoHasta ? <Suspendido hasta={driver.suspendidoHasta} /> : null}
          {driver.aceptaPagoElectronico ? <PagoElectronico /> : null}
          {stale ? <Alert>Sin GPS reciente</Alert> : null}
          {!driver.deviceRegistered ? <Alert>Dispositivo sin registrar</Alert> : null}
          {!driver.vehicle.active ? <Alert>Vehículo inactivo</Alert> : null}
          {licencia.alerta ? <Alert>{licencia.alerta}</Alert> : null}
        </div>
      )}
    </motion.button>
  );
}

/**
 * Suspendido por el reglamento: rojo, porque hoy no puede trabajar. En la
 * tarjeta va solo el día; la hora exacta, en el título y en la ficha.
 */
function Suspendido({ hasta }: { hasta: string }) {
  const dia = new Date(hasta).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', timeZone: ZONA_HORARIA_PAIPA });
  return (
    <span
      title={`Suspendido hasta el ${finDeSuspension(hasta)}`}
      className="tone-critical inline-flex items-center gap-1 rounded-full border border-[var(--tone-line)] bg-[var(--tone-bg)] px-2 py-0.5 text-micro font-medium text-[var(--tone-ink)]"
    >
      <Ban className="size-3" />
      Suspendido hasta el {dia}
    </span>
  );
}

/** Recibe pagos electrónicos: un dato, no una alerta, y en azul. */
function PagoElectronico() {
  return (
    <span className="tone-info inline-flex items-center gap-1 rounded-full border border-[var(--tone-line)] bg-[var(--tone-bg)] px-2 py-0.5 text-micro text-[var(--tone-ink)]">
      <CreditCard className="size-3" />
      Pago electrónico
    </span>
  );
}

function Alert({ children }: { children: string }) {
  return (
    <span className="tone-warning inline-flex items-center gap-1 rounded-full border border-[var(--tone-line)] bg-[var(--tone-bg)] px-2 py-0.5 text-micro text-[var(--tone-ink)]">
      <ShieldAlert className="size-3" />
      {children}
    </span>
  );
}

function DriverDetail({ driver, rideCode }: { driver: Driver; rideCode?: string }) {
  const zone = driver.position ? zoneOf(driver.position) : undefined;
  const distanceToCenter = driver.position
    ? haversineKm(driver.position, { lat: 5.7803, lng: -73.1142 })
    : undefined;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <StatusPill tone={DRIVER_STATUS_TONE[driver.status]} size="md" live={driver.status === 'ON_RIDE'}>
          {DRIVER_STATUS_LABEL[driver.status]}
        </StatusPill>
        {rideCode ? (
          <span className="rounded-full border border-line px-2 py-0.5 font-mono text-micro text-ink-muted">
            {rideCode}
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Meta label="Teléfono" mono>
          {driver.phone ? maskPhone(driver.phone) : 'Sin celular registrado'}
        </Meta>
        <Meta label="Placa" mono>
          {driver.vehicle.plate}
        </Meta>
        <Meta label="Tipo de vehículo">{driver.vehicle.type}</Meta>
        <Meta label="Capacidad">{driver.vehicle.capacity} pasajeros</Meta>
        <Meta label="Carreras hoy">{driver.ridesToday}</Meta>
        <Meta label="Aceptación">{Math.round(driver.acceptanceRate * 100)} %</Meta>
        <Meta label="Pago electrónico">{driver.aceptaPagoElectronico ? 'Lo recibe' : 'No lo recibe'}</Meta>
      </div>

      <div>
        <SectionLabel>Posición</SectionLabel>
        <div className="mt-2 space-y-1.5 rounded-md border border-line p-3 text-base">
          {driver.position ? (
            <>
              <Row label="Zona">{zone?.name ?? 'Fuera de zona'}</Row>
              <Row label="Antigüedad">{driver.positionAgeSeconds ?? 0} s</Row>
              <Row label="Distancia al centro">
                {distanceToCenter !== undefined ? formatDistance(distanceToCenter) : '—'}
              </Row>
              <Row label="Coordenadas">
                <span className="font-mono text-caption">
                  {driver.position.lat.toFixed(5)}, {driver.position.lng.toFixed(5)}
                </span>
              </Row>
            </>
          ) : (
            <p className="text-ink-muted">
              Sin turno abierto: el GPS no se registra fuera del turno.
            </p>
          )}
        </div>
      </div>

      <Vinculacion driver={driver} />

      <div>
        <SectionLabel>Seguridad</SectionLabel>
        <div className="mt-2 space-y-1.5 rounded-md border border-line p-3 text-base">
          <Row label="Dispositivo registrado">{driver.deviceRegistered ? 'Sí' : 'No'}</Row>
          <Row label="Acceso">Código + placa + PIN personal</Row>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-caption text-ink-muted">{label}</span>
      <span className="text-ink">{children}</span>
    </div>
  );
}

/* ------------------------------------------------------- listado maestro --- */

/** En turno, el taxi con que salió; si no, su móvil del listado maestro. */
function vehiculoDe(driver: Driver): string {
  if (driver.status !== 'OFF_SHIFT' && driver.vehicle.plate !== '—') return `${driver.vehicle.plate} · ${driver.vehicle.type}`;
  const movil = driver.moviles?.find((m) => m.rol === 'conductor') ?? driver.moviles?.[0];
  return movil ? `${movil.interno ? `Móvil ${movil.interno} · ` : ''}${movil.placa}` : 'Sin móvil vinculado';
}

const fechaCorta = (dia: string) =>
  new Date(`${dia}T12:00:00Z`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * La licencia, como la mira la oficina: vencida, por vencer en el mes, o al
 * día. Solo avisa; no impide trabajar, que eso lo decide la empresa.
 */
function estadoLicencia(vence?: string): { texto: string; alerta?: string } {
  if (!vence) return { texto: 'Sin dato en el listado' };
  const dias = Math.floor((Date.parse(`${vence}T23:59:59-05:00`) - Date.now()) / 86_400_000);
  if (dias < 0) return { texto: `Vencida desde el ${fechaCorta(vence)}`, alerta: 'Licencia vencida' };
  if (dias <= 30) {
    return { texto: `Vence el ${fechaCorta(vence)}`, alerta: dias === 0 ? 'Licencia vence hoy' : `Licencia vence en ${dias} días` };
  }
  return { texto: `Al día, vence el ${fechaCorta(vence)}` };
}

function Vinculacion({ driver }: { driver: Driver }) {
  const licencia = estadoLicencia(driver.licenciaVence);
  const moviles: MovilVinculado[] = driver.moviles ?? [];
  return (
    <div>
      <SectionLabel>Vinculación con la empresa</SectionLabel>
      <div className="mt-2 space-y-1.5 rounded-md border border-line p-3 text-base">
        {moviles.length ? (
          moviles.map((m) => (
            <Row key={m.placa} label={m.rol === 'conductor' ? 'Conductor del móvil' : 'Relevador del móvil'}>
              <span className="font-mono">{m.interno ?? '—'}</span> · <span className="font-mono">{m.placa}</span>
              {m.marca ? ` · ${m.marca}${m.modelo ? ` ${m.modelo}` : ''}` : ''}
              {!m.activo ? ' · inactivo' : ''}
            </Row>
          ))
        ) : (
          <p className="text-ink-muted">Sin móvil en el listado maestro.</p>
        )}
        <Row label="Licencia">
          <span className={licencia.alerta ? 'text-[var(--t-warning-ink)]' : undefined}>{licencia.texto}</span>
        </Row>
        {driver.licenciaRestriccion ? <Row label="Restricción">{driver.licenciaRestriccion}</Row> : null}
      </div>
    </div>
  );
}
