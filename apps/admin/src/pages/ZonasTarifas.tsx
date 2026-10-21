import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FileText, Gauge, MapPin, Radar, Save } from 'lucide-react';
import type { FareRule, Place, WaveConfig, Zone } from '@tax/shared';
import { formatMoney } from '@tax/shared';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  SectionLabel,
  Segmented,
  StatusPill,
  Tabs,
  cn,
  staggerItem,
  staggerList,
  transition,
  useToast,
} from '@tax/ui';
import { useFareRules, usePlaces } from '../api/queries';
import { useLive } from '../live/store';

type Tab = 'zonas' | 'lugares' | 'tarifas';

export function ZonasTarifas() {
  const [tab, setTab] = useState<Tab>('zonas');
  const zoneCount = useLive((s) => s.zones.length);
  const places = usePlaces();
  const fareRules = useFareRules();

  return (
    <div className="space-y-4 p-5">
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'zonas', label: 'Zonas y oleadas', count: zoneCount },
          { value: 'lugares', label: 'Catálogo de lugares', count: places.data?.length },
          { value: 'tarifas', label: 'Tarifas', count: fareRules.data?.length },
        ]}
      />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={transition.base}
        >
          {tab === 'zonas' ? <Zonas /> : null}
          {tab === 'lugares' ? <Lugares places={places.data ?? []} /> : null}
          {tab === 'tarifas' ? <Tarifas rules={fareRules.data ?? []} /> : null}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/* -------------------------------------------------------------------- zonas */

function Zonas() {
  const loaded = useLive((s) => s.zones);
  const [edits, setEdits] = useState<Record<string, Zone>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const { push } = useToast();

  // Las zonas vienen del store en vivo; los cambios se guardan aparte hasta
  // que haya un endpoint de escritura, para no perder lo que el usuario
  // escribió si llega un refresco de la API entre medias.
  const zones = loaded.map((zone) => edits[zone.id] ?? zone);

  const setZones = (update: (current: Zone[]) => Zone[]) => {
    const next = update(zones);
    setEdits(Object.fromEntries(next.map((zone) => [zone.id, zone])));
  };

  const update = (zoneId: string, wave: 1 | 2 | 3, patch: Partial<WaveConfig>) => {
    setZones((current: Zone[]) =>
      current.map((zone) =>
        zone.id === zoneId
          ? { ...zone, waves: zone.waves.map((w) => (w.wave === wave ? { ...w, ...patch } : w)) }
          : zone,
      ),
    );
  };

  return (
    <motion.div
      variants={staggerList(zones.length)}
      initial="hidden"
      animate="visible"
      className="grid gap-3 lg:grid-cols-2"
    >
      {zones.map((zone) => {
        const open = editing === zone.id;
        return (
          <motion.div key={zone.id} variants={staggerItem}>
            <Card className="space-y-3">
              <CardHeader
                title={zone.name}
                subtitle={`Factor de tortuosidad ${zone.tortuosity.toFixed(2)} · ${zone.activeDrivers} conductores habituales`}
                actions={
                  <>
                    <StatusPill tone={zone.kind === 'urbano' ? 'info' : 'accent'} dot={false}>
                      {zone.kind}
                    </StatusPill>
                    <Button size="sm" onClick={() => setEditing(open ? null : zone.id)}>
                      {open ? 'Cerrar' : 'Editar'}
                    </Button>
                  </>
                }
              />

              <div className="grid grid-cols-3 gap-2">
                {zone.waves.map((wave) => (
                  <div
                    key={wave.wave}
                    className="rounded-md border border-line bg-surface-sunk px-2.5 py-2"
                  >
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
                      {zone.waves.map((wave) => (
                        <div key={wave.wave} className="grid grid-cols-3 gap-2">
                          <Field label={`Radio oleada ${wave.wave} (km)`}>
                            <Input
                              type="number"
                              step="0.5"
                              value={wave.radiusKm}
                              onChange={(e) =>
                                update(zone.id, wave.wave, { radiusKm: Number(e.target.value) })
                              }
                            />
                          </Field>
                          <Field label="Candidatos">
                            <Input
                              type="number"
                              value={wave.candidates}
                              onChange={(e) =>
                                update(zone.id, wave.wave, { candidates: Number(e.target.value) })
                              }
                            />
                          </Field>
                          <Field label="Vencimiento (s)">
                            <Input
                              type="number"
                              step="5"
                              value={wave.timeoutSeconds}
                              onChange={(e) =>
                                update(zone.id, wave.wave, { timeoutSeconds: Number(e.target.value) })
                              }
                            />
                          </Field>
                        </div>
                      ))}

                      <div className="flex items-center justify-between gap-3">
                        <p className="text-micro text-ink-muted">
                          Los valores iniciales se fijan con la empresa; cada cambio queda en la
                          bitácora de auditoría.
                        </p>
                        <Button
                          variant="primary"
                          icon={<Save className="size-3.5" />}
                          onClick={() => {
                            setEditing(null);
                            push({
                              tone: 'positive',
                              title: 'Parámetros guardados',
                              description: `${zone.name}: las próximas oleadas usan los nuevos valores.`,
                            });
                          }}
                        >
                          Guardar
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </Card>
          </motion.div>
        );
      })}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ lugares */

function Lugares({ places }: { places: Place[] }) {
  const [query, setQuery] = useState('');

  if (places.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<MapPin className="size-4" />}
          title="Catálogo vacío"
          description="Todavía no hay lugares cargados para resolver direcciones."
        />
      </Card>
    );
  }

  const rows = places
    .filter(
      (place) =>
        !query ||
        place.name.toLowerCase().includes(query.toLowerCase()) ||
        place.aliases.some((alias) => alias.includes(query.toLowerCase())),
    )
    .sort((a, b) => b.uses - a.uses);

  const max = Math.max(...places.map((p) => p.uses));

  return (
    <Card flush className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Catálogo de lugares</h2>
          <p className="text-micro text-ink-muted">
            Segunda capa de geocodificación: cuando el cliente no manda ubicación, el agente
            resuelve contra este catálogo.
          </p>
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar lugar o alias…"
          className="w-56"
          aria-label="Buscar lugar"
        />
      </div>

      <ul>
        {rows.map((place) => (
          <li
            key={place.id}
            className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0"
          >
            <MapPin className="size-3.5 shrink-0 text-ink-muted" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base text-ink">{place.name}</p>
              {place.aliases.length > 0 ? (
                <p className="truncate text-micro text-ink-muted">
                  También: {place.aliases.join(', ')}
                </p>
              ) : null}
            </div>
            <StatusPill tone={place.kind === 'vereda' ? 'accent' : 'neutral'} dot={false}>
              {place.kind}
            </StatusPill>
            {/* Barra de uso: magnitud en una sola rampa, sin ejes ni leyenda. */}
            <div className="hidden w-28 items-center gap-2 sm:flex">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunk">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${(place.uses / max) * 100}%` }}
                  transition={{ duration: 0.56, ease: [0.05, 0.7, 0.1, 1] }}
                  className="h-full rounded-full bg-[var(--c-ramp-5)]"
                />
              </div>
              <span className="tnum w-8 text-right text-micro text-ink-muted">{place.uses}</span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ------------------------------------------------------------------ tarifas */

function Tarifas({ rules }: { rules: FareRule[] }) {
  const versions = Array.from(new Set(rules.map((r) => r.version)));
  const [version, setVersion] = useState(versions[0] ?? '');
  const selected = version || versions[0] || '';
  const rows = rules.filter((r) => r.version === selected);
  const legal = rows[0]?.legalReference;

  if (rules.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<FileText className="size-4" />}
          title="Sin tarifas cargadas"
          description="La tabla de precios la publica la empresa con el acto administrativo vigente."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={selected}
          onChange={setVersion}
          options={versions.map((v) => ({ value: v, label: `Versión ${v}` }))}
        />
        <p className="inline-flex items-center gap-1.5 text-caption text-ink-muted">
          <FileText className="size-3.5" />
          {legal}
        </p>
      </div>

      <Card flush className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line text-micro uppercase tracking-[0.06em] text-ink-muted">
              <th className="px-4 py-2 font-medium">Origen → destino</th>
              <th className="px-3 py-2 text-right font-medium">Banderazo</th>
              <th className="px-3 py-2 text-right font-medium">Por km</th>
              <th className="px-3 py-2 text-right font-medium">Mínima</th>
              <th className="px-4 py-2 font-medium">Recargos</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((rule) => (
              <tr key={`${rule.originKind}-${rule.destinationKind}`} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 text-base text-ink">
                  <span className="capitalize">{rule.originKind}</span>
                  <span className="mx-1.5 text-ink-muted">→</span>
                  <span className="capitalize">{rule.destinationKind}</span>
                </td>
                <td className="px-3 py-2.5 text-right tnum text-base text-ink">{formatMoney(rule.baseFare)}</td>
                <td className="px-3 py-2.5 text-right tnum text-base text-ink">{formatMoney(rule.perKm)}</td>
                <td className="px-3 py-2.5 text-right tnum text-base text-ink">{formatMoney(rule.minimumFare)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {rule.surcharges.map((s) => (
                      <span
                        key={s.id}
                        className="rounded-full border border-line px-2 py-0.5 text-micro text-ink-secondary"
                        title={
                          s.fromHour !== undefined ? `De ${s.fromHour}:00 a ${s.toHour}:00` : 'Siempre'
                        }
                      >
                        {s.label} +{formatMoney(s.amount)}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div
        className={cn(
          'tone-warning flex items-start gap-2.5 rounded-md border border-[var(--tone-line)] bg-[var(--tone-bg)] px-3 py-2.5',
        )}
      >
        <Gauge className="mt-0.5 size-4 shrink-0 text-[var(--tone-ink)]" />
        <p className="text-base text-[var(--tone-ink)]">
          Cada carrera guarda la versión de la regla con la que se calculó. Al cliente siempre se le
          informa <span className="font-medium">tarifa estimada</span>; la tarifa cobrada debe
          coincidir con la autorizada por la alcaldía.
        </p>
      </div>
    </div>
  );
}
