import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Car, Check, Pencil, Plus, Search } from 'lucide-react';
import type { VehicleType } from '@tax/shared';
import { VEHICLE_TYPES, VEHICLE_TYPE_LABEL } from '@tax/shared';
import { Banner, Button, Card, EmptyState, Field, Input, Modal, Select, StatusPill, cn, useToast } from '@tax/ui';
import { ApiError, api } from '../api/client';
import { actions } from '../live/store';

/**
 * Vehículos de la flota (18/11/2026).
 *
 * Existen para elegir de ellos los vehículos que cada conductor puede
 * manejar: un conductor solo abre turno o cambia de carro dentro de los
 * suyos. Se dan de alta y se editan; no se borran, porque sus turnos y
 * carreras los siguen nombrando. Desactivado, nadie abre turno en él.
 */

export interface Vehiculo {
  id: string;
  plate: string;
  internalNumber: string | null;
  type: VehicleType;
  capacity: number;
  active: boolean;
  brand: string | null;
  modelYear: number | null;
  /** Conductores vigentes que lo tienen permitido. */
  conductores: number;
}

export function useVehiculos(enabled = true) {
  return useQuery({
    queryKey: ['vehiculos'],
    queryFn: () => api.get<Vehiculo[]>('/v1/admin/vehicles'),
    enabled,
  });
}

/** «002 · UBP472», o solo la placa si no tiene número interno. */
export function nombreDeVehiculo(v: { plate: string; internalNumber?: string | null }) {
  return v.internalNumber ? `${v.internalNumber} · ${v.plate}` : v.plate;
}

/* ------------------------------------------------- selector múltiple --- */

/**
 * Elegir varios vehículos de la flota: búsqueda arriba, lista con casillas y
 * los elegidos como etiquetas que se quitan con un clic. Con 62 móviles una
 * lista desplegable de selección múltiple nativa es inmanejable; esto se
 * filtra por placa o número interno escribiendo dos caracteres.
 */
export function SelectorDeVehiculos({
  value,
  onChange,
  vehiculos,
  cargando,
  id,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  vehiculos: Vehiculo[];
  cargando?: boolean;
  id?: string;
}) {
  const [busqueda, setBusqueda] = useState('');
  const elegidos = new Set(value);
  const porId = new Map(vehiculos.map((v) => [v.id, v]));

  const visibles = useMemo(() => {
    const aguja = busqueda.trim().toLowerCase().replace(/[\s-]/g, '');
    return vehiculos
      .filter((v) => v.active || elegidos.has(v.id))
      .filter(
        (v) =>
          !aguja ||
          v.plate.toLowerCase().includes(aguja) ||
          (v.internalNumber ?? '').toLowerCase().includes(aguja) ||
          (v.brand ?? '').toLowerCase().includes(aguja),
      );
    // `elegidos` cambia con `value`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehiculos, busqueda, value]);

  const alternar = (vehiculoId: string) =>
    onChange(elegidos.has(vehiculoId) ? value.filter((x) => x !== vehiculoId) : [...value, vehiculoId]);

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((vehiculoId) => {
            const v = porId.get(vehiculoId);
            return (
              <button
                key={vehiculoId}
                type="button"
                onClick={() => alternar(vehiculoId)}
                title="Quitar"
                className="inline-flex items-center gap-1 rounded-full border border-[var(--tone-line)] bg-[var(--tone-bg)] px-2.5 py-0.5 font-mono text-caption text-[var(--tone-ink)] tone-accent"
              >
                {v ? nombreDeVehiculo(v) : '…'}
                <span aria-hidden="true">×</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-caption text-ink-muted">Ninguno elegido.</p>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
        <Input
          id={id}
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar por placa o número interno…"
          className="pl-8"
          aria-label="Buscar vehículos"
        />
      </div>

      <div className="max-h-56 overflow-y-auto rounded-md border border-line" role="listbox" aria-multiselectable="true">
        {cargando ? (
          <p className="p-3 text-caption text-ink-muted">Cargando vehículos…</p>
        ) : visibles.length === 0 ? (
          <p className="p-3 text-caption text-ink-muted">
            {vehiculos.length === 0 ? 'No hay vehículos dados de alta. Créalos en la pestaña Vehículos.' : 'Ninguno coincide.'}
          </p>
        ) : (
          visibles.map((v) => {
            const marcado = elegidos.has(v.id);
            return (
              <button
                key={v.id}
                type="button"
                role="option"
                aria-selected={marcado}
                onClick={() => alternar(v.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 border-b border-line px-3 py-2 text-left last:border-0',
                  marcado ? 'bg-accent-soft' : 'hover:bg-surface-sunk',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-sm border',
                    marcado ? 'border-accent bg-accent text-on-accent' : 'border-line-strong',
                  )}
                >
                  {marcado ? <Check className="size-3" /> : null}
                </span>
                <span className="font-mono text-base text-ink">{nombreDeVehiculo(v)}</span>
                <span className="truncate text-caption text-ink-muted">
                  {VEHICLE_TYPE_LABEL[v.type]}
                  {v.brand ? ` · ${v.brand}` : ''}
                </span>
                {!v.active ? <span className="ml-auto shrink-0 text-micro text-ink-muted">inactivo</span> : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------- la pestaña --- */

interface FormVehiculo {
  plate: string;
  internalNumber: string;
  type: VehicleType;
  capacity: string;
}

const capacidadSugerida = (t: VehicleType) => (t === 'van' ? 8 : t === 'camioneta' ? 5 : 4);

export function VehiculosAdmin({ gestionar }: { gestionar: boolean }) {
  const vehiculos = useVehiculos();
  const [busqueda, setBusqueda] = useState('');
  const [editando, setEditando] = useState<Vehiculo | 'nuevo' | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const cambiarActivo = useMutation({
    mutationFn: (v: Vehiculo) => api.patch(`/v1/admin/vehicles/${v.id}`, { active: !v.active }),
    onSuccess: async (_r, v) => {
      await qc.invalidateQueries({ queryKey: ['vehiculos'] });
      await actions.refreshDrivers();
      toast.push({
        tone: v.active ? 'warning' : 'positive',
        title: v.active ? `${v.plate} desactivado` : `${v.plate} activado`,
        description: v.active ? 'Nadie puede abrir turno en él, aunque lo tenga permitido.' : undefined,
      });
    },
    onError: (e) =>
      toast.push({ tone: 'critical', title: 'No se pudo cambiar', description: e instanceof ApiError ? e.message : undefined }),
  });

  const filas = useMemo(() => {
    const aguja = busqueda.trim().toLowerCase().replace(/[\s-]/g, '');
    return (vehiculos.data ?? []).filter(
      (v) =>
        !aguja ||
        v.plate.toLowerCase().includes(aguja) ||
        (v.internalNumber ?? '').includes(aguja) ||
        (v.brand ?? '').toLowerCase().includes(aguja),
    );
  }, [vehiculos.data, busqueda]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
          <Input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Placa, número interno o marca…"
            className="pl-8"
            aria-label="Buscar vehículos"
          />
        </div>
        {gestionar ? (
          <Button icon={<Plus className="size-4" />} onClick={() => setEditando('nuevo')}>
            Nuevo vehículo
          </Button>
        ) : null}
      </div>

      {vehiculos.isLoading ? (
        <p className="text-caption text-ink-muted">Cargando…</p>
      ) : filas.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Car className="size-4" />}
            title={busqueda ? 'Ningún vehículo coincide' : 'Todavía no hay vehículos'}
            description={busqueda ? 'Limpia la búsqueda.' : 'Dalos de alta aquí o carga el listado maestro.'}
          />
        </Card>
      ) : (
        <Card flush className="overflow-hidden">
          <table className="w-full text-left text-base">
            <thead className="border-b border-line bg-surface-sunk text-micro uppercase tracking-[0.07em] text-ink-muted">
              <tr>
                <th className="px-4 py-2 font-semibold">Interno</th>
                <th className="px-4 py-2 font-semibold">Placa</th>
                <th className="px-4 py-2 font-semibold">Tipo</th>
                <th className="hidden px-4 py-2 font-semibold sm:table-cell">Marca</th>
                <th className="px-4 py-2 font-semibold">Conductores</th>
                <th className="px-4 py-2 font-semibold">Estado</th>
                {gestionar ? <th className="px-4 py-2" /> : null}
              </tr>
            </thead>
            <tbody>
              {filas.map((v) => (
                <tr key={v.id} className={cn('border-b border-line last:border-0', !v.active && 'text-ink-muted')}>
                  <td className="px-4 py-2.5 font-mono">{v.internalNumber ?? '—'}</td>
                  <td className="px-4 py-2.5 font-mono font-medium">{v.plate}</td>
                  <td className="px-4 py-2.5">
                    {VEHICLE_TYPE_LABEL[v.type]} · {v.capacity}
                  </td>
                  <td className="hidden px-4 py-2.5 sm:table-cell">
                    {v.brand ?? '—'}
                    {v.modelYear ? ` ${v.modelYear}` : ''}
                  </td>
                  <td className="px-4 py-2.5 tnum">{v.conductores}</td>
                  <td className="px-4 py-2.5">
                    <StatusPill tone={v.active ? 'positive' : 'neutral'}>{v.active ? 'Activo' : 'Inactivo'}</StatusPill>
                  </td>
                  {gestionar ? (
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditando(v)}>
                          Editar
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={cambiarActivo.isPending && cambiarActivo.variables?.id === v.id}
                          onClick={() => cambiarActivo.mutate(v)}
                        >
                          {v.active ? 'Desactivar' : 'Activar'}
                        </Button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {editando ? (
        <FormularioVehiculo vehiculo={editando === 'nuevo' ? null : editando} onCerrar={() => setEditando(null)} />
      ) : null}
    </div>
  );
}

function FormularioVehiculo({ vehiculo, onCerrar }: { vehiculo: Vehiculo | null; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [datos, setDatos] = useState<FormVehiculo>(() => ({
    plate: vehiculo?.plate ?? '',
    internalNumber: vehiculo?.internalNumber ?? '',
    type: vehiculo?.type ?? 'sedan',
    capacity: String(vehiculo?.capacity ?? 4),
  }));
  const [error, setError] = useState<string | null>(null);

  const capacidad = Number(datos.capacity);
  const listo =
    (vehiculo !== null || datos.plate.trim().length >= 5) && Number.isInteger(capacidad) && capacidad >= 1 && capacidad <= 20;

  const guardar = useMutation({
    mutationFn: () =>
      vehiculo
        ? api.patch(`/v1/admin/vehicles/${vehiculo.id}`, {
            internalNumber: datos.internalNumber.trim() || null,
            type: datos.type,
            capacity: capacidad,
          })
        : api.post('/v1/admin/vehicles', {
            plate: datos.plate.trim(),
            internalNumber: datos.internalNumber.trim() || undefined,
            type: datos.type,
            capacity: capacidad,
          }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['vehiculos'] });
      await actions.refreshDrivers();
      toast.push({ tone: 'positive', title: vehiculo ? 'Vehículo actualizado' : 'Vehículo dado de alta' });
      onCerrar();
    },
    onError: (e) => setError((e instanceof ApiError && e.message) || 'No se pudo guardar.'),
  });

  return (
    <Modal
      open
      onClose={onCerrar}
      title={vehiculo ? `Editar ${vehiculo.plate}` : 'Nuevo vehículo'}
      subtitle={vehiculo ? 'La placa no se cambia: identifica al vehículo en su historial.' : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!listo} loading={guardar.isPending} onClick={() => guardar.mutate()}>
            {vehiculo ? 'Guardar' : 'Dar de alta'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Placa" htmlFor="v-placa" required={!vehiculo}>
            <Input
              id="v-placa"
              autoCapitalize="characters"
              placeholder="UBP472"
              disabled={vehiculo !== null}
              value={datos.plate}
              onChange={(e) => setDatos({ ...datos, plate: e.target.value.toUpperCase() })}
              className="font-mono"
            />
          </Field>
          <Field label="Número interno" htmlFor="v-interno" hint="El del móvil en la empresa: 002.">
            <Input
              id="v-interno"
              inputMode="numeric"
              value={datos.internalNumber}
              onChange={(e) => setDatos({ ...datos, internalNumber: e.target.value })}
              className="font-mono"
            />
          </Field>
          <Field label="Tipo" htmlFor="v-tipo">
            <Select
              id="v-tipo"
              value={datos.type}
              onChange={(e) => {
                const tipo = e.target.value as VehicleType;
                setDatos({ ...datos, type: tipo, capacity: String(capacidadSugerida(tipo)) });
              }}
            >
              {VEHICLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {VEHICLE_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pasajeros" htmlFor="v-cap" hint="Sin contar al conductor.">
            <Input
              id="v-cap"
              inputMode="numeric"
              value={datos.capacity}
              onChange={(e) => setDatos({ ...datos, capacity: e.target.value.replace(/\D/g, '') })}
            />
          </Field>
        </div>
        {error ? <Banner tone="critical">{error}</Banner> : null}
      </div>
    </Modal>
  );
}
