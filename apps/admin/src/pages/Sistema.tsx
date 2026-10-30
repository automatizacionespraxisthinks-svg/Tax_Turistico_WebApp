import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Fingerprint } from 'lucide-react';
import { formatRelative } from '@tax/shared';
import { Card, EmptyState, SectionLabel, Skeleton, StatusPill, Tabs, cn, transition } from '@tax/ui';
import { useAuditLog, useAuditVerification, usePuede, useSesion } from '../api/queries';
import { RolesAdmin } from '../components/RolesAdmin';
import { UsuariosAdmin } from '../components/UsuariosAdmin';

type Tab = 'usuarios' | 'roles' | 'auditoria';

/**
 * Sistema: las cuentas de la oficina, sus roles y la bitácora de auditoría.
 * Cada pestaña sale con su permiso.
 *
 * Aquí estaban también el estado de los servicios y los eventos a n8n. Se
 * quitaron de la vista por decisión de la empresa; la API sigue vigilando y
 * reintentando igual, y `/health`, `/ready` y `/status` siguen respondiendo
 * para el monitoreo externo.
 */
export function Sistema() {
  // Cada pestaña existe solo con su permiso. No es la barrera —el servidor
  // responde 403— sino no enseñar lo que no se puede usar.
  const sesion = useSesion();
  const puede = usePuede();
  const pestanas = [
    ...(puede('usuarios.gestionar') ? [{ value: 'usuarios' as const, label: 'Usuarios' }] : []),
    ...(puede('roles.gestionar') ? [{ value: 'roles' as const, label: 'Roles y permisos' }] : []),
    ...(puede('auditoria.ver') ? [{ value: 'auditoria' as const, label: 'Auditoría' }] : []),
  ];
  const [elegida, setElegida] = useState<Tab | null>(null);
  const tab = pestanas.find((p) => p.value === elegida)?.value ?? pestanas[0]?.value;

  // Sin saber aún el rol, cualquier pestaña sería un parpadeo: al recargar se
  // veía un instante la auditoría antes de saltar a usuarios.
  if (sesion.isLoading) {
    return (
      <div className="space-y-4 p-5">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!tab) {
    return (
      <div className="p-5">
        <Card>
          <EmptyState
            icon={<Fingerprint className="size-4" />}
            title="Nada que ver aquí con tu rol"
            description="Usuarios, roles y auditoría piden permisos que tu rol no tiene."
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-5">
      <Tabs value={tab} onChange={setElegida} options={pestanas} />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={transition.base}
        >
          {tab === 'usuarios' ? <UsuariosAdmin /> : null}
          {tab === 'roles' ? <RolesAdmin /> : null}
          {tab === 'auditoria' ? <Auditoria /> : null}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

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
          title="No se pudo leer la bitácora"
          description="Si te acaban de quitar el permiso «Ver la auditoría», ya no la puedes ver."
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
