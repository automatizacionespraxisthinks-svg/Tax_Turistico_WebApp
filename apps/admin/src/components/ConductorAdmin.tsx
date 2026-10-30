import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Ban, Check, Copy, CreditCard, KeyRound, Smartphone, UserPlus } from 'lucide-react';
import type { Driver, VehicleType } from '@tax/shared';
import {
  DIAS_DE_SUSPENSION,
  MAX_DIAS_SUSPENSION,
  VEHICLE_TYPES,
  finDeSuspension,
  formatRelative,
} from '@tax/shared';
import {
  Banner,
  Button,
  Field,
  Input,
  SectionLabel,
  Select,
  Sheet,
  Textarea,
  cn,
  transition,
  useToast,
} from '@tax/ui';
import { ApiError, api } from '../api/client';
import { actions } from '../live/store';

/**
 * Gestión de conductores desde la oficina (§6, §8.1).
 *
 * Todo lo que hay aquí lo autoriza el servidor, no esta pantalla: los
 * endpoints exigen rol `administrador`. Ocultar los botones a un operador es
 * cortesía —enseñar algo que siempre va a fallar es peor que no enseñarlo—,
 * no la barrera.
 *
 * El PIN aparece una sola vez, cuando se genera. No hay «ver PIN» en ningún
 * sitio porque en la base solo existe su hash Argon2; la única salida cuando
 * un conductor lo olvida es generarle otro.
 */

/* ------------------------------------------------------- PIN de una vez --- */

function PinUnaVez({ code, pin, onCerrar }: { code: string; pin: string; onCerrar: () => void }) {
  const [copiado, setCopiado] = useState(false);

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(pin);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      // Sin permiso de portapapeles queda leerlo de la pantalla.
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition.enter}
      className="space-y-4"
    >
      <Banner tone="warning">
        Este PIN no se vuelve a mostrar. Entrégaselo al conductor por un canal distinto del que usa
        para su código.
      </Banner>

      <div className="rounded-lg border border-line bg-surface-sunk p-5 text-center">
        <p className="text-caption text-ink-muted">PIN del conductor {code}</p>
        <p className="mt-1 select-all font-mono text-display font-semibold tracking-[0.25em] text-ink">
          {pin}
        </p>
      </div>

      <div className="flex gap-2">
        <Button
          className="flex-1"
          icon={copiado ? <Check className="size-4" /> : <Copy className="size-4" />}
          onClick={() => void copiar()}
        >
          {copiado ? 'Copiado' : 'Copiar'}
        </Button>
        <Button variant="primary" className="flex-1" onClick={onCerrar}>
          Ya lo anoté
        </Button>
      </div>
    </motion.div>
  );
}

/* ----------------------------------------------------- alta de conductor --- */

interface NuevoConductor {
  code: string;
  name: string;
  phone: string;
  plate: string;
  vehicleType: VehicleType;
}

const VACIO: NuevoConductor = { code: '', name: '', phone: '+57', plate: '', vehicleType: 'sedan' };

export function NuevoConductorBoton() {
  const [abierto, setAbierto] = useState(false);
  const [datos, setDatos] = useState<NuevoConductor>(VACIO);
  const [creado, setCreado] = useState<{ code: string; pin: string } | null>(null);
  const [error, setError] = useState<string>();
  const toast = useToast();

  const vehiculos = useQuery({
    queryKey: ['vehiculos'],
    queryFn: () => api.get<{ plate: string; type: VehicleType }[]>('/v1/admin/vehicles'),
    enabled: abierto,
  });

  const crear = useMutation({
    mutationFn: (body: NuevoConductor) =>
      api.post<{ code: string; pin: string }>('/v1/admin/drivers', body),
    onSuccess: async (respuesta) => {
      setCreado({ code: respuesta.code, pin: respuesta.pin });
      setError(undefined);
      await actions.refreshDrivers();
    },
    onError: (causa: unknown) => {
      setError(
        causa instanceof ApiError
          ? causa.message
          : 'No se pudo dar de alta. Inténtalo de nuevo.',
      );
    },
  });

  const cerrar = () => {
    setAbierto(false);
    setCreado(null);
    setDatos(VACIO);
    setError(undefined);
  };

  const listo =
    /^[0-9]{1,10}$/.test(datos.code) &&
    datos.name.trim().length >= 3 &&
    /^\+\d{8,15}$/.test(datos.phone) &&
    datos.plate.trim().length >= 5;

  return (
    <>
      <Button icon={<UserPlus className="size-4" />} onClick={() => setAbierto(true)}>
        Nuevo conductor
      </Button>

      <Sheet
        open={abierto}
        onClose={creado ? () => undefined : cerrar}
        title={creado ? 'Conductor dado de alta' : 'Nuevo conductor'}
        subtitle={creado ? undefined : 'El PIN se genera solo y se muestra una vez'}
      >
        {creado ? (
          <PinUnaVez
            code={creado.code}
            pin={creado.pin}
            onCerrar={() => {
              toast.push({ tone: 'positive', title: `Conductor ${creado.code} dado de alta` });
              cerrar();
            }}
          />
        ) : (
          <div className="space-y-4">
            <Field label="Código" htmlFor="code" required hint="El número con el que entra cada mañana.">
              <Input
                id="code"
                inputMode="numeric"
                placeholder="106"
                value={datos.code}
                onChange={(e) => setDatos({ ...datos, code: e.target.value.replace(/\D/g, '') })}
                className="font-mono"
              />
            </Field>

            <Field label="Nombre completo" htmlFor="name" required>
              <Input
                id="name"
                value={datos.name}
                onChange={(e) => setDatos({ ...datos, name: e.target.value })}
              />
            </Field>

            <Field label="Teléfono" htmlFor="phone" required hint="Con indicativo: +573001234567">
              <Input
                id="phone"
                inputMode="tel"
                value={datos.phone}
                onChange={(e) => setDatos({ ...datos, phone: e.target.value.replace(/[^\d+]/g, '') })}
                className="font-mono"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Placa" htmlFor="plate" required>
                <Input
                  id="plate"
                  list="placas-existentes"
                  autoCapitalize="characters"
                  placeholder="UBP472"
                  value={datos.plate}
                  onChange={(e) => setDatos({ ...datos, plate: e.target.value.toUpperCase() })}
                  className="font-mono"
                />
                {/* Sugiere las ya dadas de alta sin impedir escribir una nueva:
                    si la placa no existe, se crea el vehículo con ella. */}
                <datalist id="placas-existentes">
                  {(vehiculos.data ?? []).map((v) => (
                    <option key={v.plate} value={v.plate} />
                  ))}
                </datalist>
              </Field>

              <Field label="Tipo" htmlFor="tipo">
                <Select
                  id="tipo"
                  value={datos.vehicleType}
                  onChange={(e) => setDatos({ ...datos, vehicleType: e.target.value as VehicleType })}
                >
                  {VEHICLE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {error ? <Banner tone="critical">{error}</Banner> : null}

            <Button
              variant="primary"
              size="lg"
              className="w-full"
              disabled={!listo}
              loading={crear.isPending}
              onClick={() => crear.mutate(datos)}
            >
              Dar de alta
            </Button>
          </div>
        )}
      </Sheet>
    </>
  );
}

/* --------------------------------------------- gestión de un conductor --- */

interface Dispositivo {
  id: string;
  label: string;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  recibeAvisos: boolean;
}

/**
 * Suspensión por el reglamento interno: la desactivación con fecha de vuelta.
 *
 * Se elige en días porque así la piden («tres días»), contados desde ahora,
 * y debajo se ve la fecha exacta en que vuelve antes de confirmar. El motivo
 * es obligatorio: es una sanción y tiene que poder explicarse después. Al
 * cumplirse vuelve solo; «Levantar» es para perdonar antes de tiempo.
 */
function Suspension({ driver }: { driver: Driver }) {
  const toast = useToast();
  const [abierta, setAbierta] = useState(false);
  const [dias, setDias] = useState<number>(3);
  const [otra, setOtra] = useState('');
  const [motivo, setMotivo] = useState('');

  const diasElegidos = otra ? Number(otra) : dias;
  const diasValidos = Number.isInteger(diasElegidos) && diasElegidos >= 1 && diasElegidos <= MAX_DIAS_SUSPENSION;
  const motivoValido = motivo.trim().length >= 5;

  const suspender = useMutation({
    mutationFn: () =>
      api.post<{ suspendidoHasta: string }>(`/v1/admin/drivers/${driver.id}/suspension`, {
        dias: diasElegidos,
        motivo: motivo.trim(),
      }),
    onSuccess: async (r) => {
      await actions.refreshDrivers();
      setAbierta(false);
      setOtra('');
      setMotivo('');
      toast.push({
        tone: 'warning',
        title: `Suspendido hasta el ${finDeSuspension(r.suspendidoHasta)}`,
        description: 'Sale de las oleadas ya y no puede entrar a la aplicación. Una carrera en curso la termina.',
      });
    },
    onError: (error) =>
      toast.push({
        tone: 'critical',
        title: 'No se pudo suspender',
        description: error instanceof ApiError ? error.message : undefined,
      }),
  });

  const levantar = useMutation({
    mutationFn: () => api.del(`/v1/admin/drivers/${driver.id}/suspension`),
    onSuccess: async () => {
      await actions.refreshDrivers();
      toast.push({ tone: 'positive', title: 'Suspensión levantada', description: 'Ya puede volver a trabajar.' });
    },
    onError: () => toast.push({ tone: 'critical', title: 'No se pudo levantar la suspensión' }),
  });

  if (driver.suspendidoHasta) {
    return (
      <div className="tone-warning -mx-3 flex items-start justify-between gap-3 border-y border-[var(--tone-line)] bg-[var(--tone-bg)] px-3 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-base font-medium text-[var(--tone-ink)]">
            <Ban className="size-3.5 shrink-0" />
            Suspendido hasta el {finDeSuspension(driver.suspendidoHasta)}
          </p>
          {driver.motivoSuspension ? (
            <p className="mt-0.5 text-micro text-ink-secondary">{driver.motivoSuspension}</p>
          ) : null}
          <p className="mt-0.5 text-micro text-ink-muted">Vuelve solo al cumplirse la fecha.</p>
        </div>
        <Button size="sm" variant="secondary" loading={levantar.isPending} onClick={() => levantar.mutate()}>
          Levantar
        </Button>
      </div>
    );
  }

  return (
    <div className="border-t border-line pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base text-ink">Suspender por un tiempo</p>
          <p className="text-micro text-ink-muted">
            Por el reglamento interno: no recibe carreras ni entra a la aplicación hasta la fecha, y vuelve solo.
          </p>
        </div>
        {!abierta ? (
          <Button size="sm" variant="secondary" icon={<Ban className="size-4" />} onClick={() => setAbierta(true)}>
            Suspender
          </Button>
        ) : null}
      </div>

      {abierta ? (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (diasValidos && motivoValido) suspender.mutate();
          }}
        >
          <Field label="Cuántos días" hint={`De 1 a ${MAX_DIAS_SUSPENSION}, contados desde ahora.`}>
            <div className="flex flex-wrap items-center gap-1.5">
              {DIAS_DE_SUSPENSION.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => {
                    setDias(n);
                    setOtra('');
                  }}
                  className={cn(
                    'h-8 rounded-md border px-3 text-caption font-medium transition-colors',
                    !otra && dias === n
                      ? 'border-[var(--brand)] bg-brand text-on-accent'
                      : 'border-line-strong bg-surface text-ink hover:bg-surface-sunk',
                  )}
                >
                  {n} {n === 1 ? 'día' : 'días'}
                </button>
              ))}
              <div className="w-20">
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_DIAS_SUSPENSION}
                  placeholder="Otro"
                  aria-label="Otra cantidad de días"
                  value={otra}
                  onChange={(e) => setOtra(e.target.value.replace(/\D/g, '').slice(0, 2))}
                  className="h-8"
                />
              </div>
            </div>
          </Field>

          <Field label="Motivo" htmlFor="motivo-suspension" required>
            <Textarea
              id="motivo-suspension"
              rows={2}
              maxLength={280}
              placeholder="Qué falta del reglamento se sanciona"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
          </Field>

          <p className="text-caption text-ink-secondary">
            {diasValidos
              ? // Sin punto final: la hora ya termina en «p. m.».
                `Vuelve a trabajar el ${finDeSuspension(new Date(Date.now() + diasElegidos * 86_400_000))}`
              : `Escribe entre 1 y ${MAX_DIAS_SUSPENSION} días.`}
          </p>

          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setAbierta(false)}>
              Cancelar
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="danger"
              disabled={!diasValidos || !motivoValido}
              loading={suspender.isPending}
            >
              {diasValidos ? `Suspender ${diasElegidos} ${diasElegidos === 1 ? 'día' : 'días'}` : 'Suspender'}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

export function GestionConductor({ driver }: { driver: Driver }) {
  const [pinNuevo, setPinNuevo] = useState<string | null>(null);
  const toast = useToast();
  const qc = useQueryClient();

  const dispositivos = useQuery({
    queryKey: ['dispositivos', driver.id],
    queryFn: () => api.get<Dispositivo[]>(`/v1/admin/drivers/${driver.id}/devices`),
  });

  const reiniciarPin = useMutation({
    mutationFn: () => api.post<{ pin: string }>(`/v1/admin/drivers/${driver.id}/pin`),
    onSuccess: (r) => setPinNuevo(r.pin),
    onError: () => toast.push({ tone: 'critical', title: 'No se pudo reiniciar el PIN' }),
  });

  const cambiarActivo = useMutation({
    mutationFn: (activo: boolean) => api.patch(`/v1/admin/drivers/${driver.id}`, { active: activo }),
    onSuccess: async (_r, activo) => {
      await actions.refreshDrivers();
      toast.push({
        tone: activo ? 'positive' : 'warning',
        title: activo ? 'Conductor activado' : 'Conductor desactivado',
        description: activo
          ? undefined
          : 'No recibirá ofertas nuevas. Una carrera en curso no se interrumpe.',
      });
    },
    onError: () => toast.push({ tone: 'critical', title: 'No se pudo cambiar el estado' }),
  });

  const cambiarPrueba = useMutation({
    mutationFn: (esPrueba: boolean) => api.patch(`/v1/admin/drivers/${driver.id}`, { esPrueba }),
    onSuccess: async (_r, esPrueba) => {
      await actions.refreshDrivers();
      toast.push({
        tone: 'info',
        title: esPrueba ? 'Marcado como cuenta de prueba' : 'Ya no es cuenta de prueba',
        description: esPrueba
          ? 'Despacha igual que siempre, pero Reportes puede dejar fuera sus carreras.'
          : 'Sus carreras vuelven a contar en Reportes.',
      });
    },
    onError: () => toast.push({ tone: 'critical', title: 'No se pudo cambiar la marca de prueba' }),
  });

  const cambiarPago = useMutation({
    mutationFn: (acepta: boolean) =>
      api.patch(`/v1/admin/drivers/${driver.id}`, { aceptaPagoElectronico: acepta }),
    onSuccess: async (_r, acepta) => {
      await actions.refreshDrivers();
      toast.push({
        tone: 'info',
        title: acepta ? 'Recibe pagos electrónicos' : 'Ya no recibe pagos electrónicos',
        description: acepta
          ? 'Desde ahora también le llegan las carreras que se pagan así.'
          : 'Las carreras con pago electrónico ya no se le ofrecen.',
      });
    },
    onError: () => toast.push({ tone: 'critical', title: 'No se pudo cambiar el medio de pago' }),
  });

  const revocar = useMutation({
    mutationFn: (deviceId: string) => api.post(`/v1/admin/drivers/devices/${deviceId}/revoke`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['dispositivos', driver.id] });
      await actions.refreshDrivers();
      toast.push({
        tone: 'positive',
        title: 'Dispositivo revocado',
        description: 'Ese celular deja de recibir ofertas y su acceso caduca.',
      });
    },
    onError: () => toast.push({ tone: 'critical', title: 'No se pudo revocar' }),
  });

  const vivos = (dispositivos.data ?? []).filter((d) => !d.revokedAt);

  return (
    <div className="space-y-5">
      <div>
        <SectionLabel>Gestión</SectionLabel>

        <div className="mt-2 space-y-3 rounded-md border border-line p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-base text-ink">Puede recibir carreras</p>
              <p className="text-micro text-ink-muted">
                {driver.active
                  ? 'Al desactivarlo sale de las oleadas de inmediato. Una carrera en curso no se interrumpe.'
                  : 'Está desactivado: no entra en ninguna oleada.'}
              </p>
            </div>
            <Button
              size="sm"
              variant={driver.active ? 'secondary' : 'primary'}
              loading={cambiarActivo.isPending}
              onClick={() => cambiarActivo.mutate(!driver.active)}
            >
              {driver.active ? 'Desactivar' : 'Activar'}
            </Button>
          </div>

          <Suspension driver={driver} />

          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-base text-ink">
                <CreditCard className="size-3.5 shrink-0 text-ink-muted" />
                Recibe pagos electrónicos
              </p>
              <p className="text-micro text-ink-muted">
                {driver.aceptaPagoElectronico
                  ? 'Le llegan también las carreras de clientes que pagan con Nequi, transferencia o datáfono.'
                  : 'No le llegan las carreras de clientes que pagan con pago electrónico.'}
              </p>
            </div>
            <Button
              size="sm"
              variant={driver.aceptaPagoElectronico ? 'secondary' : 'primary'}
              loading={cambiarPago.isPending}
              onClick={() => cambiarPago.mutate(!driver.aceptaPagoElectronico)}
            >
              {driver.aceptaPagoElectronico ? 'Quitar' : 'Habilitar'}
            </Button>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            <div className="min-w-0">
              <p className="text-base text-ink">Cuenta de prueba</p>
              <p className="text-micro text-ink-muted">
                {driver.esPrueba
                  ? 'Sus carreras, ofertas y turnos no cuentan en Reportes con «No incluir pruebas».'
                  : 'Márcala si el equipo la usa para probar la aplicación.'}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              loading={cambiarPrueba.isPending}
              onClick={() => cambiarPrueba.mutate(!driver.esPrueba)}
            >
              {driver.esPrueba ? 'Quitar marca' : 'Marcar'}
            </Button>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            <div className="min-w-0">
              <p className="text-base text-ink">PIN personal</p>
              <p className="text-micro text-ink-muted">
                No se puede consultar: solo existe su hash. Si lo olvidó, genera otro.
              </p>
            </div>
            <Button
              size="sm"
              icon={<KeyRound className="size-4" />}
              loading={reiniciarPin.isPending}
              onClick={() => reiniciarPin.mutate()}
            >
              Reiniciar
            </Button>
          </div>
        </div>

        {pinNuevo ? (
          <div className="mt-3">
            <PinUnaVez code={driver.code} pin={pinNuevo} onCerrar={() => setPinNuevo(null)} />
          </div>
        ) : null}
      </div>

      <div>
        <SectionLabel>Celulares registrados</SectionLabel>
        <div className="mt-2 space-y-2">
          {dispositivos.isLoading ? (
            <p className="text-caption text-ink-muted">Cargando…</p>
          ) : vivos.length === 0 ? (
            <p className="rounded-md border border-line p-3 text-base text-ink-muted">
              Ninguno activo. El conductor registra el suyo al entrar a la aplicación.
            </p>
          ) : (
            vivos.map((d) => (
              <div
                key={d.id}
                className="flex items-start justify-between gap-3 rounded-md border border-line p-3"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 truncate text-base text-ink">
                    <Smartphone className="size-3.5 shrink-0 text-ink-muted" />
                    {/* El `label` es el user-agent: largo e ilegible entero. */}
                    {d.label.slice(0, 48)}
                  </p>
                  <p className="text-micro text-ink-muted">
                    {d.lastSeenAt ? `Visto ${formatRelative(d.lastSeenAt)}` : 'Sin actividad'}
                    {d.recibeAvisos ? ' · recibe avisos' : ' · sin avisos'}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  loading={revocar.isPending}
                  onClick={() => revocar.mutate(d.id)}
                >
                  Revocar
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
