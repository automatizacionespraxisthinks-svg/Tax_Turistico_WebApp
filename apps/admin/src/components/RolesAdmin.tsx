import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Lock, Minus, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  AREAS_DE_PERMISO,
  PERMISOS,
  ROL_ADMINISTRADOR,
  completarPermisos,
  type Permiso,
} from '@tax/shared';
import { Banner, Button, Card, CardHeader, Field, Input, Sheet, Skeleton, Switch, cn, useToast } from '@tax/ui';
import { ApiError, api } from '../api/client';
import { useSesion } from '../api/queries';
import { CodigoDeConfirmacion, resumenDePermisos } from './Permisos';

/**
 * Roles y permisos (RBAC, §8.1). Con «Gestionar roles».
 *
 * La tabla dice de un vistazo qué puede cambiar cada rol; cada columna se
 * edita aparte. Ver la operación —tablero, carreras, flota, mapa— es de
 * todos: los permisos son lo que se puede cambiar, y Reportes y Sistema.
 *
 * Las reglas las hace cumplir la API; aquí solo se explican y se evita
 * enseñar lo que va a fallar: nadie da permisos que no tiene, el
 * administrador no se edita, nadie edita su propio rol, y cambiar permisos
 * pide el código del teléfono.
 */

interface Rol {
  key: string;
  name: string;
  description: string | null;
  permissions: Permiso[];
  system: boolean;
  /** Activos con este rol. */
  usuarios: number;
  editable: boolean;
  motivoNoEditable: string | null;
  borrable: boolean;
}

type Editor = { tipo: 'nuevo' } | { tipo: 'editar'; rol: Rol };

export function RolesAdmin() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<Rol[]>('/v1/admin/roles'),
  });

  const lista = roles.data ?? [];

  return (
    <>
      <Card className="space-y-4">
        <CardHeader
          title="Roles y permisos"
          subtitle="Qué puede cambiar cada rol. Ver la operación —tablero, carreras, flota y mapa— es de todos."
          actions={
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="size-4" />}
              onClick={() => setEditor({ tipo: 'nuevo' })}
            >
              Nuevo rol
            </Button>
          }
        />

        {roles.isLoading ? (
          <Skeleton className="h-96" />
        ) : (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[640px] border-separate border-spacing-0 text-left">
              <thead>
                <tr>
                  <th className="sm:sticky sm:left-0 sm:z-10 w-[42%] border-b border-line bg-surface px-4 pb-3 align-bottom text-micro font-medium uppercase tracking-[0.06em] text-ink-muted sm:pl-0">
                    Permiso
                  </th>
                  {lista.map((rol) => (
                    <th key={rol.key} className="border-b border-line px-2 pb-3 text-center align-bottom">
                      <CabeceraDeRol rol={rol} onEditar={() => setEditor({ tipo: 'editar', rol })} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {AREAS_DE_PERMISO.map((area) => (
                  <AreaDeTabla key={area} area={area} roles={lista} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <ul className="grid gap-x-6 gap-y-1.5 rounded-md border border-line p-3 text-caption text-ink-secondary sm:grid-cols-2">
          <li>Nadie puede dar permisos que su propio rol no tiene.</li>
          <li>El administrador tiene todos, también los que se agreguen después, y no se edita.</li>
          <li>Nadie edita su propio rol: otra persona tiene que cambiarlo.</li>
          <li>Cambiar permisos pide el código de tu aplicación de autenticación.</li>
        </ul>
      </Card>

      <Sheet
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.tipo === 'editar' ? `Rol ${editor.rol.name}` : 'Nuevo rol'}
        subtitle={
          editor?.tipo === 'editar'
            ? editor.rol.usuarios === 0
              ? 'Nadie activo lo tiene'
              : editor.rol.usuarios === 1
                ? '1 persona activa lo tiene'
                : `${editor.rol.usuarios} personas activas lo tienen`
            : 'Elige solo lo que ese puesto necesita cambiar.'
        }
        width="lg"
      >
        {editor ? (
          <EditorDeRol
            key={editor.tipo === 'editar' ? editor.rol.key : 'nuevo'}
            rol={editor.tipo === 'editar' ? editor.rol : undefined}
            onListo={() => setEditor(null)}
          />
        ) : null}
      </Sheet>
    </>
  );
}

function CabeceraDeRol({ rol, onEditar }: { rol: Rol; onEditar: () => void }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-base font-semibold text-ink">{rol.name}</span>
      <span className="text-micro font-normal text-ink-muted">
        {rol.usuarios === 0 ? 'Nadie' : rol.usuarios === 1 ? '1 persona' : `${rol.usuarios} personas`}
      </span>
      {rol.editable ? (
        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={onEditar}>
          Editar
        </Button>
      ) : (
        <span
          className="flex h-8 items-center gap-1 text-micro font-normal text-ink-muted"
          title={rol.motivoNoEditable ?? undefined}
        >
          <Lock className="size-3" />
          {rol.key === ROL_ADMINISTRADOR ? 'Todos' : 'Sin acceso'}
        </span>
      )}
    </div>
  );
}

function AreaDeTabla({ area, roles }: { area: string; roles: Rol[] }) {
  const permisos = PERMISOS.filter((p) => p.area === area);
  return (
    <>
      <tr>
        <th
          colSpan={roles.length + 1}
          className="bg-surface sm:sticky sm:left-0 px-4 pb-1.5 pt-4 text-micro font-semibold uppercase tracking-[0.06em] text-ink-muted sm:pl-0"
        >
          {area}
        </th>
      </tr>
      {permisos.map((permiso) => (
        <tr key={permiso.clave} className="group">
          <td className="sm:sticky sm:left-0 sm:z-10 border-b border-line bg-surface px-4 py-2 group-hover:bg-surface-sunk sm:pl-0">
            <p className="text-base text-ink">{permiso.nombre}</p>
            <p className="text-micro text-ink-muted">{permiso.descripcion}</p>
          </td>
          {roles.map((rol) => {
            const tiene = rol.permissions.includes(permiso.clave);
            return (
              <td key={rol.key} className="border-b border-line px-2 py-2 text-center group-hover:bg-surface-sunk">
                {tiene ? (
                  <span className="tone-positive inline-flex size-6 items-center justify-center rounded-full bg-[var(--tone-bg)] text-[var(--tone-ink)]">
                    <Check className="size-3.5" aria-label="Sí" />
                  </span>
                ) : (
                  <Minus className="mx-auto size-3.5 text-ink-muted/50" aria-label="No" />
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

/** Crear un rol o editar uno. Sin `rol`, es nuevo. */
function EditorDeRol({ rol, onListo }: { rol?: Rol; onListo: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const mios = useSesion().data?.user.permissions ?? [];

  const [nombre, setNombre] = useState(rol?.name ?? '');
  const [descripcion, setDescripcion] = useState(rol?.description ?? '');
  const [permisos, setPermisos] = useState<Permiso[]>(rol?.permissions ?? []);
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState<string>();
  const [confirmarBorrado, setConfirmarBorrado] = useState(false);

  useEffect(() => {
    if (!confirmarBorrado) return;
    const t = window.setTimeout(() => setConfirmarBorrado(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmarBorrado]);

  const cambianPermisos = !rol || [...permisos].sort().join() !== [...rol.permissions].sort().join();
  const nombreValido = nombre.trim().length >= 3;
  const puedeGuardar = nombreValido && (!cambianPermisos || codigo.length === 6);

  /** Exportar sin poder abrir Reportes sería un botón inalcanzable. */
  const alternar = (clave: Permiso, encender: boolean) => {
    setPermisos((actuales) => {
      if (encender) return completarPermisos([...actuales, clave]);
      const sinEste = actuales.filter((p) => p !== clave);
      // Quitar uno que otro necesita quita también al otro.
      return sinEste.filter((p) => {
        const def = PERMISOS.find((d) => d.clave === p);
        return !(def && 'requiere' in def && def.requiere === clave);
      });
    });
  };

  const guardar = useMutation({
    mutationFn: () => {
      const cuerpo = {
        name: nombre.trim(),
        description: descripcion.trim(),
        permissions: permisos,
        ...(cambianPermisos ? { codigo } : {}),
      };
      return rol ? api.patch(`/v1/admin/roles/${rol.key}`, cuerpo) : api.post('/v1/admin/roles', cuerpo);
    },
    onSuccess: async () => {
      toast.push({
        tone: 'positive',
        title: rol ? 'Rol guardado' : 'Rol creado',
        description: rol
          ? 'Quien lo tenga ve el cambio desde su siguiente acción, sin volver a entrar.'
          : 'Ya se puede dar desde Usuarios.',
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['roles'] }),
        qc.invalidateQueries({ queryKey: ['usuarios'] }),
      ]);
      onListo();
    },
    onError: (causa: unknown) => {
      setCodigo('');
      setError(causa instanceof ApiError ? causa.message : 'No se pudo guardar. Inténtalo de nuevo.');
    },
  });

  const borrar = useMutation({
    mutationFn: () => api.del(`/v1/admin/roles/${rol!.key}`),
    onSuccess: async () => {
      toast.push({ tone: 'positive', title: `Rol ${rol!.name} borrado` });
      await qc.invalidateQueries({ queryKey: ['roles'] });
      onListo();
    },
    onError: (causa: unknown) =>
      setError(causa instanceof ApiError ? causa.message : 'No se pudo borrar. Inténtalo de nuevo.'),
  });

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Nombre"
          htmlFor="rol-nombre"
          required
          hint={rol?.system ? 'Los roles de base no se renombran.' : undefined}
        >
          <Input
            id="rol-nombre"
            autoComplete="off"
            placeholder="Supervisor nocturno"
            maxLength={40}
            disabled={rol?.system}
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
          />
        </Field>
        <Field label="Para qué es" htmlFor="rol-descripcion">
          <Input
            id="rol-descripcion"
            autoComplete="off"
            placeholder="Turno de la noche: despacha y suspende."
            maxLength={200}
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
          />
        </Field>
      </div>

      <div className="space-y-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-base font-semibold text-ink">Permisos</p>
          <p className="text-caption text-ink-muted">{resumenDePermisos({ key: rol?.key ?? '', permissions: permisos })}</p>
        </div>

        {AREAS_DE_PERMISO.map((area) => (
          <fieldset key={area} className="space-y-1">
            <legend className="mb-1 text-micro font-semibold uppercase tracking-[0.06em] text-ink-muted">{area}</legend>
            {PERMISOS.filter((p) => p.area === area).map((permiso) => {
              const loTengo = mios.includes(permiso.clave);
              const encendido = permisos.includes(permiso.clave);
              return (
                <div
                  key={permiso.clave}
                  className={cn('rounded-md border border-line px-3 py-2.5', encendido && 'bg-surface-sunk')}
                >
                  <Switch
                    checked={encendido}
                    disabled={!loTengo}
                    onChange={(v) => alternar(permiso.clave, v)}
                    label={permiso.nombre}
                  />
                  {/* Alineado con el texto del interruptor: riel de 36 px más 10 de separación. */}
                  <p className="mt-0.5 pl-[46px] text-micro text-ink-muted">
                    {permiso.descripcion}
                    {'requiere' in permiso ? ' Incluye ver reportes.' : ''}
                  </p>
                  {!loTengo ? (
                    <p className="mt-0.5 flex items-center gap-1 pl-[46px] text-micro text-ink-muted">
                      <Lock className="size-3" /> Tu rol no lo tiene: no lo puedes dar.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
        ))}
      </div>

      {cambianPermisos ? (
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

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="lg"
          className="flex-1"
          disabled={!puedeGuardar}
          loading={guardar.isPending}
          onClick={() => guardar.mutate()}
        >
          {rol ? 'Guardar cambios' : 'Crear rol'}
        </Button>
        {rol?.borrable ? (
          <Button
            size="lg"
            variant={confirmarBorrado ? 'danger' : 'ghost'}
            icon={<Trash2 className="size-4" />}
            loading={borrar.isPending}
            onClick={() => (confirmarBorrado ? borrar.mutate() : setConfirmarBorrado(true))}
          >
            {confirmarBorrado ? '¿Borrar el rol?' : 'Borrar'}
          </Button>
        ) : null}
      </div>
      {rol && !rol.system && !rol.borrable ? (
        <p className="text-micro text-ink-muted">
          Para borrarlo, primero cámbiale el rol a quien lo tenga, incluidas las cuentas desactivadas.
        </p>
      ) : null}
    </div>
  );
}
