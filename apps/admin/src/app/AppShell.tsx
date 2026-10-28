import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import {
  BarChart3,
  CircleDot,
  LayoutGrid,
  type LucideIcon,
  Map,
  PanelLeftClose,
  PanelLeftOpen,
  Route as RouteIcon,
  ServerCog,
  Smartphone,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import { WAHA_STATUS_LABEL, WAHA_STATUS_TONE, formatTime, type StatusTone } from '@tax/shared';
import { Banner, LiveDot, StatusPill, cn, spring, transition } from '@tax/ui';
import { actions, useLive, type AlertaRecibida } from '../live/store';
import { api } from '../api/client';
import { CambiarClave } from '../components/CambiarClave';
import logo from '../assets/logo-tax-turistico.png';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Operación', icon: LayoutGrid, end: true },
  { to: '/carreras', label: 'Carreras', icon: RouteIcon },
  { to: '/flota', label: 'Flota', icon: Users },
  { to: '/zonas', label: 'Zonas', icon: Map },
  { to: '/reportes', label: 'Reportes', icon: BarChart3 },
  { to: '/sistema', label: 'Sistema', icon: ServerCog },
];

const TITLES: Record<string, string> = {
  '/': 'Operación',
  '/carreras': 'Carreras',
  '/flota': 'Flota',
  '/zonas': 'Zonas',
  '/reportes': 'Reportes',
  '/sistema': 'Sistema',
};

export function AppShell({ children, userName }: { children: ReactNode; userName: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const connected = useLive((s) => s.connected);
  const unassigned = useLive((s) => s.rides.filter((r) => r.status === 'UNASSIGNED').length);
  const pending = useLive((s) => s.rides.filter((r) => r.status === 'PENDING' || r.status === 'NOTIFIED').length);

  const title = TITLES[`/${location.pathname.split('/')[1] ?? ''}`] ?? TITLES[location.pathname] ?? 'Operación';

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas">
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        pending={pending}
        userName={userName}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={title} />

        <AnimatePresence>
          {!connected ? (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={transition.base}
              className="overflow-hidden px-5"
            >
              <Banner tone="critical" icon={<WifiOff className="size-4" />} className="mt-3">
                Sin conexión con el servidor. Las acciones quedan en espera y se reintentan al volver.
              </Banner>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {unassigned > 0 ? (
          <div className="px-5 pt-3">
            <Banner
              tone="critical"
              icon={<CircleDot className="size-4" />}
              action={
                <NavLink
                  to="/carreras"
                  className="text-caption font-medium underline underline-offset-2"
                >
                  Ver carreras
                </NavLink>
              }
            >
              <span className="font-medium">
                {unassigned} {unassigned === 1 ? 'carrera sin asignar' : 'carreras sin asignar'}
              </span>{' '}
              tras agotar las oleadas.
            </Banner>
          </div>
        ) : null}

        <LineasCaidas />
        <AvisosSueltos />

        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- avisos --- */

/**
 * Una o más líneas de WhatsApp que no atienden. Es un estado, no un aviso:
 * se queda mientras dure y se va sola cuando el monitor la ve volver. La
 * caída en sí suena una vez (`sonarAlarma`), pero lo que hay que resolver
 * tiene que seguir a la vista aunque nadie estuviera mirando en ese momento.
 */
function LineasCaidas() {
  const sesiones = useLive((s) => s.wahaSessions);
  const caidas = sesiones.filter((sesion) => !sesion.connected);
  if (caidas.length === 0) return null;

  const [primera] = caidas;
  return (
    <div className="px-5 pt-3">
      <Banner
        tone="critical"
        icon={<Smartphone className="size-4" />}
        action={
          <NavLink to="/sistema" className="text-caption font-medium underline underline-offset-2">
            Ver líneas
          </NavLink>
        }
      >
        <span className="font-medium">
          {caidas.length === 1
            ? `La línea ${primera!.label} no está atendiendo`
            : `${caidas.length} líneas de WhatsApp no están atendiendo`}
        </span>{' '}
        ({[...new Set(caidas.map((sesion) => WAHA_STATUS_LABEL[sesion.status]))].join(', ')}). Los
        clientes que escriban a {caidas.length === 1 ? 'ese número' : 'esos números'} no reciben
        respuesta.
      </Banner>
    </div>
  );
}

const TONO_AVISO: Record<AlertaRecibida['kind'], StatusTone> = {
  no_driver: 'critical',
  line_down: 'critical',
  line_up: 'positive',
  outbox_stuck: 'warning',
  driver_no_gps: 'warning',
};

/** Una línea que vuelve se anuncia y el aviso se cierra solo. */
const CIERRE_LINEA_RECUPERADA_MS = 15_000;

/**
 * Los avisos del servidor que no tienen ya su propio letrero. La caída de una
 * línea y la carrera sin conductor no salen aquí: suenan, y su estado ya lo
 * pintan «LineasCaidas» y el letrero de carreras sin asignar. Repetirlos
 * apilaría dos letreros rojos para lo mismo.
 */
function AvisosSueltos() {
  const alerts = useLive((s) => s.alerts);
  const visibles = alerts.filter((a) => a.kind !== 'line_down' && a.kind !== 'no_driver');

  useEffect(() => {
    const temporizadores = alerts
      .filter((a) => a.kind === 'line_up')
      .map((a) =>
        window.setTimeout(
          () => actions.dismissAlert(a.id),
          Math.max(0, CIERRE_LINEA_RECUPERADA_MS - (Date.now() - a.at)),
        ),
      );
    return () => temporizadores.forEach((t) => window.clearTimeout(t));
  }, [alerts]);

  if (visibles.length === 0) return null;
  return (
    <div className="space-y-2 px-5 pt-3">
      <AnimatePresence initial={false}>
        {visibles.map((alerta) => (
          <Banner
            key={alerta.id}
            tone={TONO_AVISO[alerta.kind]}
            icon={alerta.kind === 'line_up' ? <Smartphone className="size-4" /> : <CircleDot className="size-4" />}
            action={
              <button
                type="button"
                aria-label="Cerrar aviso"
                onClick={() => actions.dismissAlert(alerta.id)}
                className="rounded p-0.5 opacity-70 hover:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            }
          >
            {alerta.message}{' '}
            <time className="tnum text-caption opacity-80">{formatTime(new Date(alerta.at))}</time>
          </Banner>
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ----------------------------------------------------------- barra lateral --- */

function Sidebar({
  collapsed,
  onToggle,
  pending,
  userName,
}: {
  collapsed: boolean;
  onToggle: () => void;
  pending: number;
  userName: string;
}) {
  const initials = userName
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <motion.aside
      animate={{ width: collapsed ? 60 : 228 }}
      transition={spring.gentle}
      className="flex shrink-0 flex-col border-r border-transparent bg-ink"
    >
      <div
        className={cn(
          'franja-marca flex h-14 items-center gap-2.5 px-3',
          collapsed && 'justify-center px-0',
        )}
      >
        <Logo />
        <AnimatePresence initial={false}>
          {!collapsed ? (
            <motion.div
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              transition={transition.fast}
              className="min-w-0"
            >
              <p className="truncate text-base font-semibold tracking-[-0.01em] text-on-ink">
                Tax Turístico
              </p>
              <p className="truncate text-micro text-on-ink-muted">Panel de oficina</p>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <nav className="flex-1 space-y-0.5 px-2 py-2">
        {NAV.map((item) => (
          <SidebarLink
            key={item.to}
            item={item}
            collapsed={collapsed}
            badge={item.to === '/carreras' && pending > 0 ? pending : undefined}
          />
        ))}
      </nav>

      <div
        className={cn(
          'border-t border-on-ink-muted/25 p-2',
          collapsed && 'flex flex-col items-center',
        )}
      >
        <button
          onClick={onToggle}
          aria-label={collapsed ? 'Expandir menú' : 'Contraer menú'}
          title={collapsed ? 'Expandir menú' : 'Contraer menú'}
          className={cn(
            'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-caption text-on-ink-muted',
            'transition-colors duration-150 ease-[var(--ease-standard)] hover:bg-on-ink/10 hover:text-on-ink',
            collapsed && 'w-8 justify-center px-0',
          )}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          {!collapsed ? <span>Contraer</span> : null}
        </button>

        <div className={cn('mt-1 flex items-center gap-2 rounded-md px-2 py-1.5', collapsed && 'px-0')}>
          <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-micro font-semibold text-on-accent">
            {initials}
          </div>
          {!collapsed ? (
            <div className="min-w-0 flex-1">
              <p className="truncate text-caption font-medium text-on-ink">{userName}</p>
              <div className="flex items-center gap-2">
                <CambiarClave />
                <span aria-hidden="true" className="text-micro text-on-ink-muted">
                  ·
                </span>
                <button
                  onClick={() => {
                    void api.post('/v1/auth/logout').finally(() => window.location.reload());
                  }}
                  className="text-micro text-on-ink-muted transition-colors duration-150 hover:text-on-ink"
                >
                  Salir
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </motion.aside>
  );
}

function SidebarLink({
  item,
  collapsed,
  badge,
}: {
  item: NavItem;
  collapsed: boolean;
  badge?: number;
}) {
  const Icon = item.icon;

  return (
    <NavLink to={item.to} end={item.end} title={collapsed ? item.label : undefined}>
      {({ isActive }) => (
        <span
          className={cn(
            'relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-base',
            'transition-colors duration-150 ease-[var(--ease-standard)]',
            isActive
              ? 'font-bold text-on-accent'
              : 'font-medium text-on-ink hover:bg-on-ink/10',
            collapsed && 'justify-center px-0',
          )}
        >
          {/* Un solo fondo que viaja entre secciones: el cambio se lee como
              movimiento, no como dos parpadeos. */}
          {isActive ? (
            <motion.span
              layoutId="nav-active"
              transition={spring.indicator}
              className="absolute inset-0 rounded-md bg-brand"
            />
          ) : null}
          <Icon
            className={cn('relative size-4 shrink-0', isActive ? 'text-on-accent' : 'text-on-ink-muted')}
          />
          {!collapsed ? <span className="relative truncate">{item.label}</span> : null}
          {!collapsed && badge ? (
            <span
              className={cn(
                'relative ml-auto tnum rounded-full px-1.5 text-micro font-semibold',
                isActive ? 'bg-surface text-brand' : 'bg-on-ink/15 text-on-ink',
              )}
            >
              {badge}
            </span>
          ) : null}
        </span>
      )}
    </NavLink>
  );
}

/**
 * El logo oficial a 38 px sobre un círculo blanco. El archivo mide 128 px,
 * así que sigue nítido en pantallas de densidad 3.
 */
function Logo() {
  return (
    <img
      src={logo}
      alt="Logo Tax Turístico"
      width={38}
      height={38}
      className="size-[38px] shrink-0 rounded-full bg-surface"
    />
  );
}

/* ------------------------------------------------------------ barra superior --- */

function TopBar({ title }: { title: string }) {
  const [now, setNow] = useState(() => new Date());
  const connected = useLive((s) => s.connected);
  const wahaSessions = useLive((s) => s.wahaSessions);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-transparent bg-brand px-5">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="truncate text-title font-semibold text-on-accent">{title}</h1>
        <span className="hidden text-caption text-on-brand-muted sm:inline">
          Paipa · <time className="tnum">{formatTime(now)}</time>
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <div className="hidden items-center gap-1.5 lg:flex">
          {wahaSessions.map((session) => (
            <StatusPill
              key={session.id}
              tone={WAHA_STATUS_TONE[session.status]}
              live={session.status === 'working'}
              inverse
            >
              {session.label} · {WAHA_STATUS_LABEL[session.status]}
            </StatusPill>
          ))}
        </div>

        {/* Sobre el azul: borde y texto blancos, y el punto en el verde que
            se lee sobre fondos oscuros. Si se cae, píldora blanca con rojo. */}
        {connected ? (
          <span className="flex items-center gap-1.5 rounded-md border border-on-accent px-2 py-1 text-micro text-on-accent">
            <LiveDot live className="[--tone-solid:var(--success-on-ink)]" />
            En vivo
          </span>
        ) : (
          <span className="tone-critical flex items-center gap-1.5 rounded-md border border-transparent bg-surface px-2 py-1 text-micro text-[var(--tone-ink)]">
            <LiveDot tone="critical" />
            Reconectando
          </span>
        )}
      </div>
    </header>
  );
}
