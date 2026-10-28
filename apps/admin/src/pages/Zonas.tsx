import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { MapPin, Plus, Radar, Save } from 'lucide-react';
import type { Place, WaveConfig, Zone } from '@tax/shared';
import { cambiosZonaSchema } from '@tax/shared';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  SectionLabel,
  StatusPill,
  Tabs,
  staggerItem,
  staggerList,
  transition,
  useToast,
} from '@tax/ui';
import { ApiError, api } from '../api/client';
import { usePlaces, useSesion } from '../api/queries';
import { actions, useLive } from '../live/store';
import { FormularioLugar, FormularioZona } from '../components/FormulariosCatalogo';

type Tab = 'zonas' | 'lugares';

/**
 * Zonas y lugares.
 *
 * Las zonas son los círculos donde hay servicio, cada uno con sus oleadas;
 * los lugares, los sitios que los clientes nombran sin dirección («la
 * terminal»), con las palabras clave con que el asistente los reconoce. Los
 * dos se crean aquí, en una ventana sobre la vista.
 *
 * Crear una zona o cambiar sus oleadas es de administrador: cambia cómo se
 * despacha. Los lugares los agrega cualquiera de la oficina.
 */
export function Zonas() {
  const [tab, setTab] = useState<Tab>('zonas');
  const zoneCount = useLive((s) => s.zones.length);
  const places = usePlaces();
  const sesion = useSesion();
  const esAdmin = sesion.data?.user.role === 'administrador';

  const [zonaNueva, setZonaNueva] = useState(false);
  const [lugarAbierto, setLugarAbierto] = useState<Place | 'nuevo' | null>(null);

  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { value: 'zonas', label: 'Zonas y oleadas', count: zoneCount },
            { value: 'lugares', label: 'Catálogo de lugares', count: places.data?.length },
          ]}
        />
        {tab === 'zonas' && esAdmin ? (
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setZonaNueva(true)}>
            Nueva zona
          </Button>
        ) : null}
        {tab === 'lugares' ? (
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setLugarAbierto('nuevo')}>
            Nuevo lugar
          </Button>
        ) : null}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={transition.base}
        >
          {tab === 'zonas' ? <ZonasYOleadas editable={esAdmin} /> : null}
          {tab === 'lugares' ? (
            <Lugares
              places={places.data ?? []}
              onAbrir={(lugar) => setLugarAbierto(lugar)}
              onNuevo={() => setLugarAbierto('nuevo')}
            />
          ) : null}
        </motion.div>
      </AnimatePresence>

      <FormularioZona open={zonaNueva} onClose={() => setZonaNueva(false)} />
      <FormularioLugar
        open={lugarAbierto !== null}
        onClose={() => setLugarAbierto(null)}
        lugar={lugarAbierto && lugarAbierto !== 'nuevo' ? lugarAbierto : undefined}
        lugares={places.data ?? []}
      />
    </div>
  );
}

/* -------------------------------------------------------------------- zonas */

function ZonasYOleadas({ editable }: { editable: boolean }) {
  const zones = useLive((s) => s.zones);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <motion.div
      variants={staggerList(zones.length)}
      initial="hidden"
      animate="visible"
      className="grid gap-3 lg:grid-cols-2"
    >
      {zones.map((zone) => (
        <motion.div key={zone.id} variants={staggerItem}>
          <TarjetaZona
            zone={zone}
            editable={editable}
            open={editing === zone.id}
            onToggle={() => setEditing(editing === zone.id ? null : zone.id)}
            onClose={() => setEditing(null)}
          />
        </motion.div>
      ))}
    </motion.div>
  );
}

function TarjetaZona({
  zone,
  editable,
  open,
  onToggle,
  onClose,
}: {
  zone: Zone;
  editable: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const { push } = useToast();
  // Lo que se escribe vive aquí hasta guardar; un refresco de las zonas no lo pisa.
  const [waves, setWaves] = useState<WaveConfig[]>(zone.waves);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (wave: 1 | 2 | 3, patch: Partial<WaveConfig>) =>
    setWaves((actuales) => actuales.map((w) => (w.wave === wave ? { ...w, ...patch } : w)));

  const abrirOCerrar = () => {
    if (!open) setWaves(zone.waves);
    setError(null);
    onToggle();
  };

  const guardar = async () => {
    const validacion = cambiosZonaSchema.safeParse({ waves });
    if (!validacion.success) {
      setError(validacion.error.issues[0]?.message ?? 'Revisa los valores');
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      // Antes este botón solo mostraba «guardado»: no había a dónde mandarlo.
      await api.patch(`/v1/admin/zones/${zone.id}`, { waves });
      await actions.refreshZones();
      onClose();
      push({
        tone: 'positive',
        title: 'Oleadas guardadas',
        description: `${zone.name}: las próximas carreras se despachan con los nuevos valores.`,
      });
    } catch (causa) {
      setError(causa instanceof ApiError ? causa.message : 'No se pudo guardar.');
    } finally {
      setGuardando(false);
    }
  };

  const vistas = open ? waves : zone.waves;

  return (
    <Card className="space-y-3">
      <CardHeader
        title={zone.name}
        subtitle={`Factor de tortuosidad ${zone.tortuosity.toFixed(2)} · ${zone.activeDrivers} conductores habituales`}
        actions={
          <>
            <StatusPill tone={zone.kind === 'urbano' ? 'info' : 'positive'} dot={false}>
              {zone.kind === 'urbano' ? 'urbano' : 'vereda'}
            </StatusPill>
            {editable ? (
              <Button size="sm" onClick={abrirOCerrar}>
                {open ? 'Cerrar' : 'Editar'}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-3 gap-2">
        {vistas.map((wave) => (
          <div key={wave.wave} className="rounded-md border border-line bg-surface-sunk px-2.5 py-2">
            <p className="flex items-center gap-1 text-micro font-semibold uppercase tracking-[0.06em] text-ink-muted">
              <Radar className="size-3" />
              Oleada {wave.wave}
            </p>
            <p className="mt-1 tnum text-base text-ink">{wave.radiusKm} km</p>
            <p className="tnum text-micro text-ink-muted">
              {wave.candidates} candidatos · {wave.timeoutSeconds} s
            </p>
          </div>
        ))}
      </div>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={transition.base}
            className="overflow-hidden"
          >
            <div className="space-y-3 border-t border-line pt-3">
              <SectionLabel>Parámetros por oleada</SectionLabel>
              {waves.map((wave) => (
                <div key={wave.wave} className="grid grid-cols-3 gap-2">
                  <Field label={`Radio oleada ${wave.wave} (km)`}>
                    <Input
                      type="number"
                      step="0.5"
                      value={wave.radiusKm}
                      onChange={(e) => update(wave.wave, { radiusKm: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Candidatos">
                    <Input
                      type="number"
                      value={wave.candidates}
                      onChange={(e) => update(wave.wave, { candidates: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Vencimiento (s)">
                    <Input
                      type="number"
                      step="5"
                      value={wave.timeoutSeconds}
                      onChange={(e) => update(wave.wave, { timeoutSeconds: Number(e.target.value) })}
                    />
                  </Field>
                </div>
              ))}

              {error ? <p className="text-caption text-[var(--t-critical-ink)]">{error}</p> : null}

              <div className="flex items-center justify-between gap-3">
                <p className="text-micro text-ink-muted">
                  Cada oleada busca más lejos que la anterior. El cambio queda en la bitácora de auditoría.
                </p>
                <Button
                  variant="primary"
                  icon={<Save className="size-3.5" />}
                  loading={guardando}
                  onClick={() => void guardar()}
                >
                  Guardar
                </Button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Card>
  );
}

/* ------------------------------------------------------------------ lugares */

function Lugares({
  places,
  onAbrir,
  onNuevo,
}: {
  places: Place[];
  onAbrir: (lugar: Place) => void;
  onNuevo: () => void;
}) {
  const [query, setQuery] = useState('');

  if (places.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<MapPin className="size-4" />}
          title="Catálogo vacío"
          description="Agrega los sitios que los clientes nombran sin dirección: la terminal, el parque, los hoteles. El asistente los reconoce por sus palabras clave."
          action={
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={onNuevo}>
              Agregar el primero
            </Button>
          }
        />
      </Card>
    );
  }

  const buscada = query.trim().toLowerCase();
  const rows = places
    .filter(
      (place) =>
        !buscada ||
        place.name.toLowerCase().includes(buscada) ||
        place.aliases.some((alias) => alias.toLowerCase().includes(buscada)),
    )
    .sort((a, b) => b.uses - a.uses);

  const max = Math.max(1, ...places.map((p) => p.uses));

  return (
    <Card flush className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Catálogo de lugares</h2>
          <p className="text-micro text-ink-muted">
            Cuando el cliente no manda ubicación ni dirección, el asistente busca aquí el lugar que nombró. Toca uno
            para editarlo.
          </p>
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar lugar o palabra clave…"
          className="w-60"
          aria-label="Buscar lugar"
        />
      </div>

      <ul>
        {rows.map((place) => (
          <li key={place.id} className="border-b border-line last:border-0">
            <button
              type="button"
              onClick={() => onAbrir(place)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 ease-[var(--ease-standard)] hover:bg-surface-sunk"
            >
              <MapPin className="size-3.5 shrink-0 text-ink-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base text-ink">{place.name}</p>
                <p className="truncate text-micro text-ink-muted">
                  {place.aliases.length > 0 ? `También: ${place.aliases.join(', ')}` : 'Sin palabras clave: solo por su nombre'}
                </p>
              </div>
              <StatusPill tone={place.kind === 'rural' || place.kind === 'vereda' ? 'positive' : 'info'} dot={false}>
                {place.kind === 'rural' || place.kind === 'vereda' ? 'vereda' : 'urbano'}
              </StatusPill>
              {/* Barra de uso: magnitud en una sola rampa, sin ejes ni leyenda. */}
              <div className="hidden w-28 items-center gap-2 sm:flex" title="Veces que reconoció un pedido">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunk">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${(place.uses / max) * 100}%` }}
                    transition={{ duration: 0.56, ease: [0.05, 0.7, 0.1, 1] }}
                    className="h-full rounded-full bg-[var(--c-series-1)]"
                  />
                </div>
                <span className="tnum w-8 text-right text-micro text-ink-muted">{place.uses}</span>
              </div>
            </button>
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="px-4 py-6 text-center text-caption text-ink-muted">Ningún lugar coincide con «{query}».</li>
        ) : null}
      </ul>
    </Card>
  );
}
