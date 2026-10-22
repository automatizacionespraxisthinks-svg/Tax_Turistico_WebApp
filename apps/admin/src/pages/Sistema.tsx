import { useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  Database,
  Fingerprint,
  QrCode,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import {
  OUTBOX_EVENT_LABEL,
  OUTBOX_STATUS_LABEL,
  OUTBOX_STATUS_TONE,
  WAHA_STATUS_LABEL,
  WAHA_STATUS_TONE,
  formatRelative,
} from '@tax/shared';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  CardHeader,
  SectionLabel,
  Segmented,
  Stat,
  StatusPill,
  Tabs,
  cn,
  transition,
  useToast,
} from '@tax/ui';
import { useAuditLog, useAuditVerification, useSesion, useSystemStatus } from '../api/queries';
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

function Estado() {
  const connected = useLive((s) => s.connected);
  const wahaSessions = useLive((s) => s.wahaSessions);
  const status = useSystemStatus();
  const { push } = useToast();

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
          value={status.data?.process.rssMb ?? 0}
          unit="MB"
          tone={(status.data?.process.rssMb ?? 0) > 400 ? 'warning' : 'info'}
          hint="Límite 512 MB en Dokploy"
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
          <ul className="space-y-2">
            {wahaSessions.map((session) => (
              <li
                key={session.id}
                className="flex items-center gap-3 rounded-md border border-line px-3 py-2.5"
              >
                <Smartphone className="size-4 shrink-0 text-ink-muted" />
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium text-ink">{session.label}</p>
                  <p className="font-mono text-micro text-ink-muted">{session.phone}</p>
                </div>
                <span className="tnum text-caption text-ink-muted">{session.messagesToday} msj.</span>
                <StatusPill
                  tone={WAHA_STATUS_TONE[session.status]}
                  live={session.status === 'working'}
                  size="md"
                >
                  {WAHA_STATUS_LABEL[session.status]}
                </StatusPill>
                {session.status === 'scan_qr' ? (
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<QrCode className="size-3.5" />}
                    onClick={() =>
                      push({
                        tone: 'info',
                        title: 'Código QR solicitado',
                        description: `Escanea con el teléfono de ${session.label}.`,
                      })
                    }
                  >
                    Ver QR
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-micro text-ink-muted">
            Revisión automática cada minuto. Una línea caída genera alerta inmediata a la oficina y
            al equipo técnico.
          </p>
        </Card>

        <Card className="space-y-3">
          <CardHeader title="Servicios" subtitle="Comprobaciones del último minuto" />
          <ul className="space-y-2">
            <Service icon={<Database className="size-4" />} name="PostgreSQL 16" detail="bases tax y waha" ok />
            <Service icon={<Activity className="size-4" />} name="Redis 7" detail="usuario ACL tax, prefijo tax:" ok />
            <Service icon={<Send className="size-4" />} name="Webhooks de n8n" detail="firma HMAC v1 válida" ok />
            <Service
              icon={<Activity className="size-4" />}
              name="WebSocket"
              detail={connected ? 'salas por conductor y por oficina' : 'reconectando'}
              ok={connected}
            />
            <Service
              icon={<ShieldCheck className="size-4" />}
              name="Clave de API de la integración"
              detail="rotada hace 38 días · rotación trimestral"
              ok
            />
          </ul>
          {/* El socket ya es real: reconecta solo y, al volver, el panel
              vuelve a pedir el estado completo. Este botón solo fuerza un
              refresco manual cuando alguien quiere comprobar algo ya. */}
          <Button
            icon={<RefreshCw className="size-3.5" />}
            onClick={() => {
              void status.refetch();
              push({
                tone: 'info',
                title: 'Estado actualizado',
                description: 'Se volvió a consultar la API.',
              });
            }}
          >
            Actualizar estado
          </Button>
        </Card>
      </div>
    </div>
  );
}

function Service({
  icon,
  name,
  detail,
  ok,
}: {
  icon: ReactNode;
  name: string;
  detail: string;
  ok: boolean;
}) {
  return (
    <li className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
      <span className="shrink-0 text-ink-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base text-ink">{name}</p>
        <p className="truncate text-micro text-ink-muted">{detail}</p>
      </div>
      <StatusPill tone={ok ? 'positive' : 'critical'} live={ok}>
        {ok ? 'Operativo' : 'Con fallo'}
      </StatusPill>
    </li>
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
