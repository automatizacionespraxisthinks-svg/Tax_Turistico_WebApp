import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import {
  Check,
  Clock,
  Copy,
  KeyRound,
  MessageSquareText,
  ShieldCheck,
  ShieldOff,
  UserCog,
  UserMinus,
  UserPlus,
  UserRoundCheck,
} from 'lucide-react';
import {
  LOGIN_HINT,
  ROL_ADMINISTRADOR,
  ROL_OPERADOR,
  TEMP_PASSWORD_HOURS,
  formatDateTime,
  formatRelative,
  isValidLogin,
  normalizeLogin,
} from '@tax/shared';
import {
  Banner,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Sheet,
  StatusPill,
  transition,
  useToast,
} from '@tax/ui';
import { ApiError, api } from '../api/client';
import { useSesion } from '../api/queries';
import { CodigoDeConfirmacion, SelectorDeRol, type RolAsignable } from './Permisos';

/**
 * Usuarios de la oficina (§8.1). Con «Gestionar usuarios».
 *
 * Desde aquí se da de alta a la gente con un rol —hasta el cupo que fija la
 * API—, se le cambia el rol, se la desactiva cuando deja la oficina y se le
 * genera una contraseña nueva si la olvida. Toda contraseña que sale de aquí
 * es temporal: quien la genera la ve, así que caduca y al entrar hay que
 * cambiarla.
 *
 * Solo se gestiona a quien no tiene más permisos que uno, y dar un rol
 * distinto del de operador pide el código del teléfono. Lo que NO se hace
 * aquí es reiniciar el segundo factor de nadie: junto con la contraseña,
 * permitiría entrar en la cuenta de otro. Eso sigue en el terminal.
 */

interface Usuario {
  id: string;
  email: string;
  name: string;
  role: string;
  roleName: string;
  active: boolean;
  totpEnabled: boolean;
  lastLoginAt: string | null;
  locked: boolean;
  temporaryPassword: { expiresAt: string; expired: boolean } | null;
  /** Si quien mira puede cambiarle el rol, desactivarlo o reiniciarle la clave. */
  gestionable: boolean;
}

interface ListaUsuarios {
  users: Usuario[];
  roles: RolAsignable[];
  /** Usuarios activos que no son administradores, y cuántos caben. */
  cupo: { active: number; max: number };
}

/** Lo que se le entrega a la persona: una sola vez. */
interface ClaveEntregable {
  nombre: string;
  login: string;
  password: string;
  expiresAt: string;
  nueva: boolean;
}

/**
 * El mensaje listo para mandar por WhatsApp. Lleva la dirección del panel
 * porque el operador nuevo no tiene por qué saberla, y los dos pasos que le
 * esperan para que no se asuste cuando le pidan cambiar la contraseña.
 */
function mensajeParaEnviar(clave: ClaveEntregable): string {
  const primerNombre = clave.nombre.split(' ')[0] ?? clave.nombre;
  return [
    clave.nueva
      ? `Hola ${primerNombre}, ya tienes cuenta en el panel de Tax Turístico.`
      : `Hola ${primerNombre}, esta es tu nueva contraseña del panel de Tax Turístico.`,
    '',
    `Entra en: ${window.location.origin}`,
    `Usuario: ${clave.login}`,
    `Contraseña temporal: ${clave.password}`,
    '',
    `Caduca el ${formatDateTime(clave.expiresAt)}. Al entrar te pedirá elegir una contraseña tuya` +
      (clave.nueva
        ? ' y después activar el segundo factor con una aplicación como Google Authenticator en tu teléfono.'
        : '.'),
  ].join('\n');
}

function ClaveUnaVez({ clave, onCerrar }: { clave: ClaveEntregable; onCerrar: () => void }) {
  const [copiado, setCopiado] = useState<'clave' | 'mensaje' | null>(null);

  const copiar = async (que: 'clave' | 'mensaje') => {
    try {
      await navigator.clipboard.writeText(que === 'clave' ? clave.password : mensajeParaEnviar(clave));
      setCopiado(que);
      setTimeout(() => setCopiado(null), 2000);
    } catch {
      // Sin permiso de portapapeles queda leerla de la pantalla.
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
        Esta contraseña no se vuelve a mostrar. Entrégasela a {clave.nombre} por un canal privado.
      </Banner>

      <dl className="space-y-3 rounded-lg border border-line bg-surface-sunk p-5">
        <div>
          <dt className="text-caption text-ink-muted">Usuario</dt>
          <dd className="mt-0.5 select-all break-all font-mono text-base font-medium text-ink">
            {clave.login}
          </dd>
        </div>
        <div>
          <dt className="text-caption text-ink-muted">Contraseña temporal</dt>
          <dd className="mt-0.5 select-all break-all font-mono text-title font-semibold text-ink">
            {clave.password}
          </dd>
        </div>
        <div className="flex items-center gap-1.5 text-caption text-ink-muted">
          <Clock className="size-3.5" />
          Caduca el {formatDateTime(clave.expiresAt)}, a las {TEMP_PASSWORD_HOURS} horas.
        </div>
      </dl>

      <Banner tone="info">
        Al entrar tendrá que cambiarla por una suya
        {clave.nueva
          ? ', y después activar el segundo factor con su teléfono.'
          : '. Su segundo factor no se toca, y sus sesiones abiertas quedaron cerradas.'}
      </Banner>

      <div className="flex flex-wrap gap-2">
        <Button
          className="flex-1"
          icon={copiado === 'mensaje' ? <Check className="size-4" /> : <MessageSquareText className="size-4" />}
          onClick={() => void copiar('mensaje')}
        >
          {copiado === 'mensaje' ? 'Mensaje copiado' : 'Copiar mensaje'}
        </Button>
        <Button
          className="flex-1"
          icon={copiado === 'clave' ? <Check className="size-4" /> : <Copy className="size-4" />}
          onClick={() => void copiar('clave')}
        >
          {copiado === 'clave' ? 'Copiada' : 'Copiar solo la clave'}
        </Button>
      </div>

      <Button variant="primary" size="lg" className="w-full" onClick={onCerrar}>
        Ya la entregué
      </Button>
    </motion.div>
  );
}

function NuevoUsuario({
  roles,
  onCreado,
  cupoLleno,
}: {
  roles: RolAsignable[];
  onCreado: (clave: ClaveEntregable) => void;
  cupoLleno: boolean;
}) {
  const [nombre, setNombre] = useState('');
  const [login, setLogin] = useState('');
  const [rol, setRol] = useState<string>(ROL_OPERADOR);
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState<string>();
  const qc = useQueryClient();

  const loginValido = isValidLogin(login);
  // Con el rol de operador, como siempre; con otro, se confirma con el teléfono.
  const pideCodigo = rol !== ROL_OPERADOR;
  // Los administradores no ocupan cupo.
  const sinCupo = cupoLleno && rol !== ROL_ADMINISTRADOR;
  const puedeCrear =
    nombre.trim().length >= 3 && loginValido && !sinCupo && (!pideCodigo || codigo.length === 6);

  const crear = useMutation({
    mutationFn: () =>
      api.post<{ login: string; password: string; expiresAt: string }>('/v1/admin/users', {
        name: nombre.trim(),
        login,
        role: rol,
        ...(pideCodigo ? { codigo } : {}),
      }),
    onSuccess: async (r) => {
      onCreado({ nombre: nombre.trim(), login: r.login, password: r.password, expiresAt: r.expiresAt, nueva: true });
      await qc.invalidateQueries({ queryKey: ['usuarios'] });
    },
    onError: (causa: unknown) => {
      setCodigo('');
      setError(causa instanceof ApiError ? causa.message : 'No se pudo crear. Inténtalo de nuevo.');
    },
  });

  return (
    <div className="space-y-4">
      <Field label="Nombre y apellido" htmlFor="nombre" required>
        <Input
          id="nombre"
          autoComplete="off"
          placeholder="Marcela Ruiz"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
        />
      </Field>

      <Field
        label="Usuario"
        htmlFor="login"
        required
        hint={LOGIN_HINT}
        error={login && !loginValido ? 'Así no sirve para entrar.' : undefined}
      >
        <Input
          id="login"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="marcela.ruiz"
          value={login}
          onChange={(e) => setLogin(normalizeLogin(e.target.value))}
          className="font-mono"
        />
      </Field>

      <div className="space-y-1.5">
        <p className="text-caption font-medium text-ink">Rol</p>
        <SelectorDeRol
          roles={roles}
          value={rol}
          onChange={(key) => {
            setRol(key);
            setError(undefined);
          }}
        />
      </div>

      {sinCupo ? (
        <Banner tone="info" icon={<UserMinus className="size-4" />}>
          El cupo está lleno. Desactiva a alguien que ya no esté en la oficina, o da el rol de
          administrador, que no ocupa cupo.
        </Banner>
      ) : null}

      {pideCodigo ? (
        <CodigoDeConfirmacion
          value={codigo}
          onChange={(c) => {
            setCodigo(c);
            setError(undefined);
          }}
          onEnter={() => puedeCrear && crear.mutate()}
        />
      ) : null}

      <ul className="space-y-1.5 rounded-md border border-line p-3 text-caption text-ink-secondary">
        <li>
          Recibirás una contraseña temporal que se muestra una sola vez y caduca a las{' '}
          {TEMP_PASSWORD_HOURS} horas.
        </li>
        <li>Al entrar, le pedirá cambiarla y después activar el segundo factor.</li>
      </ul>

      {error ? <Banner tone="critical">{error}</Banner> : null}

      <Button
        variant="primary"
        size="lg"
        className="w-full"
        icon={<UserPlus className="size-4" />}
        disabled={!puedeCrear}
        loading={crear.isPending}
        onClick={() => crear.mutate()}
      >
        Crear usuario
      </Button>
    </div>
  );
}

/** Cambia el rol de alguien. Siempre con el código del teléfono de quien lo cambia. */
function CambiarRol({
  usuario,
  roles,
  onListo,
}: {
  usuario: Usuario;
  roles: RolAsignable[];
  onListo: () => void;
}) {
  const [rol, setRol] = useState(usuario.role);
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState<string>();
  const qc = useQueryClient();
  const toast = useToast();

  const elegido = roles.find((r) => r.key === rol);
  const puedeGuardar = rol !== usuario.role && codigo.length === 6;

  const guardar = useMutation({
    mutationFn: () => api.patch(`/v1/admin/users/${usuario.id}/role`, { role: rol, codigo }),
    onSuccess: async () => {
      toast.push({
        tone: 'positive',
        title: `${usuario.name} ahora es ${elegido?.name ?? rol}`,
        description: 'Vale desde su siguiente acción en el panel, sin volver a entrar.',
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['usuarios'] }),
        qc.invalidateQueries({ queryKey: ['roles'] }),
      ]);
      onListo();
    },
    onError: (causa: unknown) => {
      setCodigo('');
      setError(causa instanceof ApiError ? causa.message : 'No se pudo cambiar. Inténtalo de nuevo.');
    },
  });

  return (
    <div className="space-y-4">
      <SelectorDeRol
        roles={roles}
        value={rol}
        actual={usuario.role}
        onChange={(key) => {
          setRol(key);
          setError(undefined);
        }}
      />

      {rol !== usuario.role ? (
        <CodigoDeConfirmacion
          value={codigo}
          onChange={(c) => {
            setCodigo(c);
            setError(undefined);
          }}
          onEnter={() => puedeGuardar && guardar.mutate()}
        />
      ) : null}

      {error ? <Banner tone="critical">{error}</Banner> : null}

      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={!puedeGuardar}
        loading={guardar.isPending}
        onClick={() => guardar.mutate()}
      >
        {rol === usuario.role ? 'Elige otro rol' : `Cambiar a ${elegido?.name ?? rol}`}
      </Button>
    </div>
  );
}

/** Estado de la contraseña temporal, para no esperar a alguien que no puede entrar. */
function PildoraTemporal({ temporal }: { temporal: NonNullable<Usuario['temporaryPassword']> }) {
  if (temporal.expired) {
    return (
      <StatusPill tone="critical" dot={false}>
        <Clock className="size-3" /> clave temporal caducada
      </StatusPill>
    );
  }
  return (
    <StatusPill tone="warning" dot={false}>
      <Clock className="size-3" /> clave temporal sin cambiar
    </StatusPill>
  );
}

export function UsuariosAdmin() {
  type Panel =
    | { tipo: 'nuevo' }
    | { tipo: 'reiniciar'; usuario: Usuario }
    | { tipo: 'rol'; usuario: Usuario };
  const [panel, setPanel] = useState<Panel | null>(null);
  const [clave, setClave] = useState<ClaveEntregable | null>(null);
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const sesion = useSesion();

  const usuarios = useQuery({
    queryKey: ['usuarios'],
    queryFn: () => api.get<ListaUsuarios>('/v1/admin/users'),
  });

  // La confirmación de «Desactivar» se deshace sola si nadie la pulsa.
  useEffect(() => {
    if (!confirmando) return;
    const t = window.setTimeout(() => setConfirmando(null), 4000);
    return () => window.clearTimeout(t);
  }, [confirmando]);

  const reiniciar = useMutation({
    mutationFn: (u: Usuario) =>
      api.post<{ email: string; password: string; expiresAt: string }>(`/v1/admin/users/${u.id}/password`),
    onSuccess: async (r, u) => {
      setClave({ nombre: u.name, login: r.email, password: r.password, expiresAt: r.expiresAt, nueva: false });
      await qc.invalidateQueries({ queryKey: ['usuarios'] });
    },
    onError: () => toast.push({ tone: 'critical', title: 'No se pudo reiniciar la contraseña' }),
  });

  const cambiarEstado = useMutation({
    mutationFn: (v: { usuario: Usuario; active: boolean }) =>
      api.patch(`/v1/admin/users/${v.usuario.id}`, { active: v.active }),
    onSuccess: async (_, v) => {
      setConfirmando(null);
      toast.push({
        tone: 'positive',
        title: v.active ? 'Usuario reactivado' : 'Usuario desactivado',
        description: v.active
          ? `${v.usuario.name} puede volver a entrar.`
          : `${v.usuario.name} ya no puede entrar y sus sesiones se cerraron.`,
      });
      await qc.invalidateQueries({ queryKey: ['usuarios'] });
    },
    onError: (causa: unknown) =>
      toast.push({
        tone: 'critical',
        title: 'No se pudo cambiar',
        description: causa instanceof ApiError ? causa.message : undefined,
      }),
  });

  const cupo = usuarios.data?.cupo;
  const cupoLleno = cupo ? cupo.active >= cupo.max : false;
  const roles = usuarios.data?.roles ?? [];

  const cerrarPanel = () => {
    setPanel(null);
    setClave(null);
  };

  return (
    <>
      <Card className="space-y-3">
        <CardHeader
          title="Usuarios de la oficina"
          subtitle={
            cupo
              ? `${cupo.active} de ${cupo.max} cupos en uso (los administradores no ocupan cupo). La contraseña no se puede consultar: si alguien la olvida, se genera otra.`
              : 'La contraseña no se puede consultar: solo existe su hash. Si alguien la olvida, se genera otra.'
          }
          actions={
            <Button
              variant="primary"
              size="sm"
              icon={<UserPlus className="size-4" />}
              disabled={!cupo}
              onClick={() => setPanel({ tipo: 'nuevo' })}
            >
              Nuevo usuario
            </Button>
          }
        />

        {cupoLleno && cupo ? (
          <Banner tone="info" icon={<UserMinus className="size-4" />}>
            Ya hay {cupo.active} usuarios activos sin contar administradores, el máximo. Para dar de
            alta a otro, desactiva a alguien que ya no esté en la oficina.
          </Banner>
        ) : null}

        <div className="space-y-2">
          {usuarios.isLoading ? (
            <p className="text-caption text-ink-muted">Cargando…</p>
          ) : (
            (usuarios.data?.users ?? []).map((u) => {
              const esYo = u.id === sesion.data?.user.id;
              const gestionable = u.gestionable;
              return (
                <div
                  key={u.id}
                  className={`flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-3 ${u.active ? '' : 'opacity-60'}`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-base font-medium text-ink">{u.name}</p>
                    <p className="truncate font-mono text-micro text-ink-muted">{u.email}</p>
                    <p className="mt-1 text-micro text-ink-muted">
                      {u.lastLoginAt ? `Último acceso ${formatRelative(u.lastLoginAt)}` : 'Nunca ha entrado'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill
                      tone={u.role === ROL_ADMINISTRADOR ? 'info' : u.role === ROL_OPERADOR ? 'neutral' : 'accent'}
                    >
                      {u.roleName}
                    </StatusPill>

                    {!u.active ? (
                      <StatusPill tone="neutral" dot={false}>
                        desactivado
                      </StatusPill>
                    ) : u.temporaryPassword ? (
                      <PildoraTemporal temporal={u.temporaryPassword} />
                    ) : (
                      // El 2FA se enseña porque es lo que decide si esa persona
                      // puede usar el panel: sin él, el servidor no la deja pasar.
                      <StatusPill tone={u.totpEnabled ? 'positive' : 'warning'}>
                        {u.totpEnabled ? (
                          <>
                            <ShieldCheck className="size-3" /> 2FA
                          </>
                        ) : (
                          <>
                            <ShieldOff className="size-3" /> sin 2FA
                          </>
                        )}
                      </StatusPill>
                    )}

                    {u.locked ? <StatusPill tone="critical">bloqueado</StatusPill> : null}

                    {gestionable && u.active ? (
                      <Button
                        size="sm"
                        icon={<UserCog className="size-4" />}
                        onClick={() => setPanel({ tipo: 'rol', usuario: u })}
                      >
                        Cambiar rol
                      </Button>
                    ) : null}

                    {(gestionable || esYo) && u.active ? (
                      <Button
                        size="sm"
                        icon={<KeyRound className="size-4" />}
                        onClick={() => setPanel({ tipo: 'reiniciar', usuario: u })}
                      >
                        Reiniciar contraseña
                      </Button>
                    ) : null}

                    {gestionable && u.active ? (
                      <Button
                        size="sm"
                        variant={confirmando === u.id ? 'danger' : 'ghost'}
                        icon={<UserMinus className="size-4" />}
                        loading={cambiarEstado.isPending && cambiarEstado.variables?.usuario.id === u.id}
                        onClick={() =>
                          confirmando === u.id
                            ? cambiarEstado.mutate({ usuario: u, active: false })
                            : setConfirmando(u.id)
                        }
                      >
                        {confirmando === u.id ? '¿Desactivar?' : 'Desactivar'}
                      </Button>
                    ) : null}

                    {gestionable && !u.active ? (
                      <Button
                        size="sm"
                        icon={<UserRoundCheck className="size-4" />}
                        disabled={cupoLleno && u.role !== ROL_ADMINISTRADOR}
                        title={cupoLleno && u.role !== ROL_ADMINISTRADOR ? 'El cupo está lleno' : undefined}
                        loading={cambiarEstado.isPending && cambiarEstado.variables?.usuario.id === u.id}
                        onClick={() => cambiarEstado.mutate({ usuario: u, active: true })}
                      >
                        Reactivar
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <p className="text-micro text-ink-muted">
          Solo puedes gestionar a quien no tenga más permisos que tú, y nadie se cambia el rol a sí
          mismo. Reiniciar un segundo factor perdido se hace desde el terminal del servidor: junto con
          la contraseña, permitiría entrar en la cuenta de otro.
        </p>
      </Card>

      <Sheet
        open={panel !== null}
        // Con la contraseña a la vista no se cierra por accidente: no se
        // vuelve a mostrar.
        onClose={clave ? () => undefined : cerrarPanel}
        title={
          clave
            ? clave.nueva
              ? 'Usuario creado'
              : 'Contraseña reiniciada'
            : panel?.tipo === 'nuevo'
              ? 'Nuevo usuario'
              : panel?.tipo === 'rol'
                ? `Rol de ${panel.usuario.name}`
                : 'Reiniciar contraseña'
        }
        subtitle={
          clave
            ? clave.nombre
            : panel?.tipo === 'reiniciar' || panel?.tipo === 'rol'
              ? panel.usuario.email
              : undefined
        }
      >
        {clave ? (
          <ClaveUnaVez
            clave={clave}
            onCerrar={() => {
              toast.push({ tone: 'positive', title: clave.nueva ? 'Usuario creado' : 'Contraseña reiniciada' });
              cerrarPanel();
            }}
          />
        ) : panel?.tipo === 'nuevo' ? (
          <NuevoUsuario roles={roles} onCreado={setClave} cupoLleno={cupoLleno} />
        ) : panel?.tipo === 'rol' ? (
          <CambiarRol usuario={panel.usuario} roles={roles} onListo={cerrarPanel} />
        ) : panel?.tipo === 'reiniciar' ? (
          <div className="space-y-4">
            <p className="text-base text-ink-secondary">
              Se generará una contraseña temporal para{' '}
              <strong className="text-ink">{panel.usuario.name}</strong> y se mostrará una sola vez.
            </p>

            <ul className="space-y-2 rounded-md border border-line p-3 text-base text-ink-secondary">
              <li>Sus sesiones abiertas se cerrarán.</li>
              <li>Al entrar tendrá que cambiarla por una suya.</li>
              <li>
                Su segundo factor {panel.usuario.totpEnabled ? 'sigue activo' : 'sigue sin activarse'}:
                no se toca desde aquí.
              </li>
              <li>La contraseña anterior deja de servir de inmediato.</li>
            </ul>

            <Button
              variant="primary"
              size="lg"
              className="w-full"
              loading={reiniciar.isPending}
              onClick={() => reiniciar.mutate(panel.usuario)}
            >
              Generar contraseña temporal
            </Button>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}
