import { useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Database,
  Fingerprint,
  QrCode,
  RefreshCw,
  Send,
  ServerCrash,
  ShieldCheck,
  Smartphone,
  Trash2,
} from 'lucide-react';
import {
  CHECK_STATE_LABEL,
  CHECK_STATE_TONE,
  OUTBOX_EVENT_LABEL,
  OUTBOX_STATUS_LABEL,
  OUTBOX_STATUS_TONE,
  WAHA_STATUS_LABEL,
  WAHA_STATUS_TONE,
  formatRelative,
  type CheckState,
  type ServiceId,
} from '@tax/shared';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  CardHeader,
  SectionLabel,
  Segmented,
  Sheet,
  Skeleton,
  Stat,
  StatusPill,
  Tabs,
  cn,
  transition,
  useToast,
} from '@tax/ui';
import { api } from '../api/client';
import {
  useAuditLog,
  useAuditVerification,
  useSesion,
  useSystemChecks,
  useSystemStatus,
} from '../api/queries';
import { UsuariosAdmin } from '../components/UsuariosAdmin';
import { actions, useLive } from '../live/store';

type Tab = 'estado' | 'outbox' | 'auditoria' | 'usuarios';

export function Sistema() {
  const [tab, setTab] = useState<Tab>('estado');
  const outbox = useLive((s) => s.outbox);
  const dead = outbox.filter((e) => e.status === 'dead').length;

  // La pestaña solo existe para administradores. No es la barrera —el
  // servidor responde 403 a un operador— sino no enseñar lo que no puede usar.
  const sesion = useSesion();
  const esAdmin = sesion.data?.user.role === 'administrador';

  return (
    <div className="space-y-4 p-5">
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'estado', label: 'Estado' },
          { value: 'outbox', label: 'Eventos a n8n', count: outbox.length },
          { value: 'auditoria', label: 'Auditoría' },
          ...(esAdmin ? [{ value: 'usuarios' as const, label: 'Usuarios' }] : []),
        ]}
      />

      {dead > 0 ? (
        <Banner tone="critical" icon={<Send className="size-4" />}>
          {dead} {dead === 1 ? 'evento' : 'eventos'} en cola muerta tras agotar los 10 intentos. El
          agente no habrá confirmado esas carreras al cliente.
        </Banner>
      ) : null}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={transition.base}
        >
          {tab === 'estado' ? <Estado /> : null}
          {tab === 'outbox' ? <Outbox /> : null}
          {tab === 'auditoria' ? <Auditoria /> : null}
          {tab === 'usuarios' && esAdmin ? <UsuariosAdmin /> : null}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ estado */

const ICONO_SERVICIO: Record<ServiceId, ReactNode> = {
  postgres: <Database className="size-4" />,
  redis: <Activity className="size-4" />,
  n8n: <Send className="size-4" />,
  whatsapp: <Smartphone className="size-4" />,
  api_key: <ShieldCheck className="size-4" />,
};

function Estado() {
  const connected = useLive((s) => s.connected);
  const wahaSessions = useLive((s) => s.wahaSessions);
  const status = useSystemStatus();
  const checks = useSystemChecks();
  const sesion = useSesion();
  const esAdmin = sesion.data?.user.role === 'administrador';
  const { push } = useToast();
  const [qrDe, setQrDe] = useState<string | null>(null);
  const [actualizando, setActualizando] = useState(false);

  const whatsapp = checks.data?.services.find((s) => s.id === 'whatsapp');
  const monitorApagado = whatsapp?.state === 'apagado';
  const rss = checks.data?.memory.rssMb ?? status.data?.process.rssMb ?? 0;
  const limite = checks.data?.memory.limitMb ?? null;
  const usoMemoria = limite ? Math.round((rss / limite) * 100) : null;

  async function actualizar() {
    setActualizando(true);
    try {
      let detalle = 'Se volvió a comprobar cada servicio.';
      if (whatsapp && !monitorApagado) {
        const revision = await actions.revisarLineas();
        detalle = revision.ok
          ? `Líneas revisadas en WAHA: ${revision.conectadas} de ${revision.lineas} conectadas.`
          : `WAHA no responde: ${revision.error}`;
      }
      await Promise.all([status.refetch(), checks.refetch()]);
      push({ tone: 'info', title: 'Estado actualizado', description: detalle });
    } catch (error) {
      push({
        tone: 'critical',
        title: 'No se pudo actualizar',
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setActualizando(false);
    }
  }

  async function quitar(id: string, label: string) {
    try {
      await actions.quitarLinea(id);
      push({ tone: 'positive', title: 'Línea quitada', description: `${label} ya no sale en el panel.` });
    } catch (error) {
      push({
        tone: 'critical',
        title: 'No se pudo quitar',
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat
          label="Carreras activas"
          value={status.data?.rides.active ?? 0}
          tone="info"
          hint={`${status.data?.rides.unassigned ?? 0} sin asignar`}
        />
        <Stat
          label="Memoria de tax-api"
          value={rss}
          unit="MB"
          tone={usoMemoria !== null && usoMemoria >= 80 ? 'warning' : 'info'}
          hint={
            limite
              ? `${usoMemoria}% de los ${limite} MB del contenedor`
              : checks.isSuccess
                ? 'El contenedor no tiene límite fijado'
                : 'Leyendo el límite…'
          }
        />
        <Stat
          label="Asignación p95"
          value={status.data?.slo.assignmentP95Seconds ?? 0}
          unit="s"
          tone="progress"
          hint="Últimas 24 horas"
        />
        <Stat
          label="Eventos en cola muerta"
          value={status.data?.outbox.dead ?? 0}
          tone={(status.data?.outbox.dead ?? 0) > 0 ? 'critical' : 'positive'}
          hint="Requieren reenvío manual"
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="space-y-3">
          <CardHeader
            title="Líneas de WhatsApp"
            subtitle="Tres líneas publicadas: si una se bloquea, las otras siguen atendiendo"
          />

          {monitorApagado ? (
            <Banner tone="warning" icon={<Smartphone className="size-4" />}>
              El monitor está apagado: falta <span className="font-mono">WAHA_URL</span> en la API.
              Nadie está revisando las líneas y una caída no avisaría a nadie.
            </Banner>
          ) : null}

          {wahaSessions.length === 0 ? (
            monitorApagado ? null : (
              <EmptyState
                icon={<Smartphone className="size-4" />}
                title="WAHA no ha informado ninguna línea"
                description="En cuanto el monitor vea una sesión en WAHA, aparece aquí."
              />
            )
          ) : (
            <ul className="space-y-2">
              {wahaSessions.map((linea) => (
                <li
                  key={linea.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line px-3 py-2.5"
                >
                  <Smartphone className="size-4 shrink-0 text-ink-muted" />
                  {/* Con ancho mínimo: si no cabe, bajan la píldora y el botón,
                      no el texto a una columna de una palabra. */}
                  <div className="min-w-[10rem] flex-1">
                    <p className="text-base font-medium text-ink">{linea.label}</p>
                    <p className="font-mono text-micro text-ink-muted">
                      {linea.phone ?? 'sin número vinculado'}
                    </p>
                    {linea.statusSince ? (
                      <p
                        className={cn(
                          'text-micro',
                          linea.connected ? 'text-ink-muted' : 'text-[var(--t-critical-ink)]',
                        )}
                      >
                        {/* «Sin atender», no «dejó de atender»: una línea nueva
                            que nace pidiendo el QR nunca llegó a atender. */}
                        {linea.connected ? 'Conectada' : 'Sin atender'} {desde(linea.statusSince)}
                      </p>
                    ) : null}
                  </div>
                  <StatusPill
                    tone={WAHA_STATUS_TONE[linea.status]}
                    live={linea.status === 'working'}
                    size="md"
                  >
                    {WAHA_STATUS_LABEL[linea.status]}
                  </StatusPill>
                  {linea.status === 'scan_qr' ? (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<QrCode className="size-3.5" />}
                      onClick={() => setQrDe(linea.id)}
                    >
                      Ver QR
                    </Button>
                  ) : null}
                  {linea.status === 'missing' && esAdmin ? (
                    <Button
                      size="sm"
                      icon={<Trash2 className="size-3.5" />}
                      onClick={() => void quitar(linea.id, linea.label)}
                    >
                      Quitar
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {!monitorApagado ? (
            <p className="text-micro text-ink-muted">
              Revisión automática cada minuto
              {whatsapp ? <> · {whatsapp.detail}</> : null}. Si una línea deja de atender, suena una
              alerta en el panel, queda un letrero rojo arriba hasta que vuelva y se manda a n8n el
              evento «Línea de WhatsApp caída», para avisar al equipo técnico si el flujo lo tiene
              configurado.
            </p>
          ) : null}
        </Card>

        <Card className="space-y-3">
          <CardHeader
            title="Servicios"
            subtitle={
              checks.data
                ? `Comprobados ${formatRelative(checks.data.checkedAt)} · se repite cada 15 s`
                : 'Comprobando…'
            }
          />
          {checks.isError ? (
            <Banner tone="critical" icon={<ServerCrash className="size-4" />}>
              No se pudieron leer las comprobaciones: {checks.error.message}
            </Banner>
          ) : null}
          <ul className="space-y-2">
            {checks.data?.services.map((servicio) => (
              <Service
                key={servicio.id}
                icon={ICONO_SERVICIO[servicio.id]}
                name={servicio.name}
                detail={servicio.detail}
                state={servicio.state}
              />
            ))}
            {/* El socket es lo único que se comprueba desde el navegador:
                lo que importa es si este panel recibe los cambios. */}
            <Service
              icon={<Activity className="size-4" />}
              name="WebSocket"
              detail={connected ? 'este panel recibe los cambios en vivo' : 'reconectando'}
              state={connected ? 'ok' : 'fallo'}
            />
          </ul>
          <Button
            icon={<RefreshCw className="size-3.5" />}
            loading={actualizando}
            onClick={() => void actualizar()}
          >
            Actualizar estado
          </Button>
        </Card>
      </div>

      <QrDeLinea lineaId={qrDe} onClose={() => setQrDe(null)} />
    </div>
  );
}

/** «desde hace 3 min», «desde el 24/10 10:00»: cuánto lleva así la línea. */
function desde(iso: string): string {
  const relativo = formatRelative(iso);
  if (relativo === 'ahora') return 'desde hace un momento';
  return relativo.startsWith('hace') ? `desde ${relativo}` : `desde el ${relativo}`;
}

function Service({
  icon,
  name,
  detail,
  state,
}: {
  icon: ReactNode;
  name: string;
  detail: string;
  state: CheckState;
}) {
  return (
    <li className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
      <span className="shrink-0 text-ink-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base text-ink">{name}</p>
        <p className="break-words text-micro text-ink-muted">{detail}</p>
      </div>
      <StatusPill tone={CHECK_STATE_TONE[state]} live={state === 'ok'}>
        {CHECK_STATE_LABEL[state]}
      </StatusPill>
    </li>
  );
}

/**
 * El QR para volver a vincular una línea, pedido a WAHA a través de la API.
 * WhatsApp lo cambia cada pocos segundos, así que se renueva solo; y en
 * cuanto el monitor ve la línea conectada, deja de pedirlo y lo dice.
 */
function QrDeLinea({ lineaId, onClose }: { lineaId: string | null; onClose: () => void }) {
  const wahaSessions = useLive((s) => s.wahaSessions);
  const linea = wahaSessions.find((l) => l.id === lineaId) ?? null;
  const vinculada = linea?.status === 'working';
  const qr = useQuery({
    queryKey: ['waha-qr', lineaId],
    queryFn: () => api.get<{ image: string }>(`/v1/admin/waha/${encodeURIComponent(lineaId!)}/qr`),
    enabled: Boolean(lineaId) && !vinculada,
    refetchInterval: 15_000,
    retry: false,
    gcTime: 0,
  });

  return (
    <Sheet
      open={Boolean(lineaId)}
      onClose={onClose}
      title={`Vincular ${linea?.label ?? 'línea'}`}
      subtitle="En el teléfono: WhatsApp › Dispositivos vinculados › Vincular un dispositivo"
    >
      <div className="space-y-3">
        {vinculada ? (
          <Banner tone="positive" icon={<Smartphone className="size-4" />}>
            Línea vinculada: el monitor ya la ve conectada.
          </Banner>
        ) : qr.isError ? (
          <Banner tone="critical" icon={<QrCode className="size-4" />}>
            WAHA no dio el código: {qr.error.message}
          </Banner>
        ) : qr.data ? (
          <img
            src={qr.data.image}
            alt={`Código QR para vincular ${linea?.label ?? 'la línea'}`}
            className="mx-auto w-full max-w-xs rounded-md bg-white p-3"
          />
        ) : (
          <Skeleton className="mx-auto aspect-square h-auto max-w-xs" />
        )}
        {!vinculada ? (
          <p className="text-micro text-ink-muted">
            El código se renueva solo cada 15 segundos. Cuando el teléfono lo lea, el monitor verá
            la línea conectada en menos de un minuto, o al pulsar «Actualizar estado».
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ outbox */

function Outbox() {
  const outbox = useLive((s) => s.outbox);
  const [filter, setFilter] = useState<'todos' | 'dead' | 'pending'>('todos');
  const { push } = useToast();

  const rows = outbox.filter((e) => filter === 'todos' || e.status === filter);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'todos', label: 'Todos', count: outbox.length },
            { value: 'pending', label: 'En cola', count: outbox.filter((e) => e.status === 'pending').length },
            { value: 'dead', label: 'Cola muerta', count: outbox.filter((e) => e.status === 'dead').length },
          ]}
        />
        <p className="text-caption text-ink-muted">
          Entrega al menos una vez · reintentos 1 s → 15 min, 10 intentos
        </p>
      </div>

      <Card flush className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line text-micro uppercase tracking-[0.06em] text-ink-muted">
              <th className="px-4 py-2 font-medium">Evento</th>
              <th className="px-3 py-2 font-medium">Carrera</th>
              <th className="px-3 py-2 text-right font-medium">Versión</th>
              <th className="px-3 py-2 text-right font-medium">Intentos</th>
              <th className="px-3 py-2 font-medium">Estado</th>
              <th className="px-4 py-2 text-right font-medium">Creado</th>
            </tr>
          </thead>
          <tbody>
            <AnimatePresence initial={false}>
              {rows.map((event) => (
                <motion.tr
                  key={event.eventId}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={transition.fast}
                  className="border-b border-line last:border-0"
                >
                  <td className="px-4 py-2.5">
                    <p className="text-base text-ink">{OUTBOX_EVENT_LABEL[event.type]}</p>
                    <p className="font-mono text-micro text-ink-muted">{event.eventId}</p>
                    {event.lastError ? (
                      <p className="mt-0.5 text-micro text-[var(--t-critical-ink)]">{event.lastError}</p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-caption text-ink-secondary">{event.rideCode}</td>
                  <td className="px-3 py-2.5 text-right tnum text-base text-ink-secondary">{event.rideVersion}</td>
                  <td className="px-3 py-2.5 text-right tnum text-base text-ink-secondary">{event.attempts}</td>
                  <td className="px-3 py-2.5">
                    <StatusPill
                      tone={OUTBOX_STATUS_TONE[event.status]}
                      live={event.status === 'delivering'}
                    >
                      {OUTBOX_STATUS_LABEL[event.status]}
                    </StatusPill>
                  </td>
                  <td className="px-4 py-2.5 text-right text-caption text-ink-muted">
                    {event.status === 'dead' ? (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          void actions
                            .retryEvent(event.eventId)
                            .then(() =>
                              push({
                                tone: 'positive',
                                title: 'Evento reenviado',
                                description: `${event.rideCode} salió de la cola muerta.`,
                              }),
                            )
                            .catch(() =>
                              push({ tone: 'critical', title: 'No se pudo reenviar' }),
                            );
                        }}
                      >
                        Reintentar
                      </Button>
                    ) : (
                      <time>{formatRelative(event.createdAt)}</time>
                    )}
                  </td>
                </motion.tr>
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- auditoría */

const ROLE_TONE: Record<string, 'info' | 'accent' | 'progress' | 'neutral'> = {
  administrador: 'info',
  operador: 'accent',
  'integración': 'progress',
  integration: 'progress',
  sistema: 'neutral',
  system: 'neutral',
  driver: 'progress',
  customer: 'neutral',
};

function Auditoria() {
  const entries = useAuditLog(50);
  const verification = useAuditVerification();

  if (entries.isError) {
    return (
      <Card>
        <EmptyState
          icon={<Fingerprint className="size-4" />}
          title="Sin permiso para ver la bitácora"
          description="La auditoría es de administradores; tu sesión es de operador."
        />
      </Card>
    );
  }

  const rows = entries.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-caption text-ink-muted">
        <Fingerprint className="size-3.5" />
        Bitácora de solo inserción con hash encadenado: cada fila incluye el hash de la anterior, así
        una modificación rompe la cadena.
        {verification.data ? (
          <StatusPill tone={verification.data.ok ? 'positive' : 'critical'}>
            {verification.data.ok
              ? 'Cadena verificada'
              : `Cadena rota en la fila ${verification.data.brokenAtSeq}`}
          </StatusPill>
        ) : null}
      </div>

      <Card flush className="overflow-hidden">
        <ul>
          {rows.map((entry, index) => (
            <motion.li
              key={entry.seq}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, delay: index * 0.02, ease: [0.05, 0.7, 0.1, 1] }}
              className={cn(
                'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5 last:border-0',
              )}
            >
              <StatusPill tone={ROLE_TONE[entry.role] ?? 'neutral'} dot={false}>
                {entry.role}
              </StatusPill>
              <span className="text-base font-medium text-ink">{entry.actorName}</span>
              <span className="text-base text-ink-secondary">{entry.action}</span>
              <span className="font-mono text-caption text-ink-muted">
                {entry.entityId ?? entry.entity}
              </span>
              <span className="ml-auto flex items-center gap-3 text-micro text-ink-muted">
                <span className="font-mono">{entry.prevHash.slice(0, 8)}…</span>
                <span className="font-mono">{entry.ip ?? '—'}</span>
                <time>{formatRelative(entry.at)}</time>
              </span>
            </motion.li>
          ))}
        </ul>
      </Card>

      <SectionLabel>Retención</SectionLabel>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Fotos del lugar', value: '30 días' },
          { label: 'Histórico GPS', value: '6 meses' },
          { label: 'Conversaciones', value: '12 meses' },
          { label: 'Carreras y auditoría', value: '5 años' },
        ].map((item) => (
          <div key={item.label} className="rounded-md border border-line bg-surface px-3 py-2.5">
            <p className="text-micro uppercase tracking-[0.06em] text-ink-muted">{item.label}</p>
            <p className="mt-0.5 text-base font-medium text-ink">{item.value}</p>
          </div>
        ))}
      </div>
      <p className="text-micro text-ink-muted">
        Plazos propuestos, pendientes de confirmar con la empresa. El borrado automático corre como
        tarea programada.
      </p>
    </div>
  );
}
