import { Lock, ShieldCheck } from 'lucide-react';
import { CLAVES_DE_PERMISO, ROL_ADMINISTRADOR, type Permiso } from '@tax/shared';
import { Field, Input, cn } from '@tax/ui';

/**
 * Piezas compartidas por Usuarios y Roles (RBAC, §8.1).
 */

/** Un rol tal como lo devuelve la lista de usuarios: para elegirlo. */
export interface RolAsignable {
  key: string;
  name: string;
  description: string | null;
  permissions: Permiso[];
  /** Si quien mira puede darlo: no tiene permisos que él no tenga. */
  asignable: boolean;
}

/** «Todos los permisos» o «7 de 14 permisos». */
export function resumenDePermisos(rol: { key: string; permissions: readonly string[] }): string {
  if (rol.key === ROL_ADMINISTRADOR) return 'Todos los permisos';
  const n = rol.permissions.length;
  if (n === 0) return 'Solo ver la operación';
  return `${n} de ${CLAVES_DE_PERMISO.length} permisos`;
}

/**
 * El código de la aplicación de autenticación de quien hace el cambio.
 *
 * Lo pide el servidor para dar poder —un rol o un permiso— aunque la sesión
 * esté abierta: así no basta con sentarse ante un computador desatendido.
 */
export function CodigoDeConfirmacion({
  value,
  onChange,
  onEnter,
  error,
}: {
  value: string;
  onChange: (codigo: string) => void;
  onEnter?: () => void;
  error?: string;
}) {
  return (
    <Field
      label="Código de tu aplicación de autenticación"
      htmlFor="codigo-confirmacion"
      required
      error={error}
      hint="Dar un rol o cambiar permisos se confirma con tu teléfono, aunque ya tengas la sesión abierta."
    >
      <Input
        id="codigo-confirmacion"
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000000"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onKeyDown={(e) => e.key === 'Enter' && value.length === 6 && onEnter?.()}
        className="w-36 font-mono text-title tracking-[0.3em]"
      />
    </Field>
  );
}

/** Los roles como opciones, con lo que dan. Los que no puede dar, apagados y con la razón. */
export function SelectorDeRol({
  roles,
  value,
  onChange,
  actual,
}: {
  roles: RolAsignable[];
  value: string;
  onChange: (key: string) => void;
  /** El rol que ya tiene, para marcarlo. */
  actual?: string;
}) {
  return (
    <div role="radiogroup" aria-label="Rol" className="space-y-2">
      {roles.map((rol) => {
        const elegido = rol.key === value;
        return (
          <button
            key={rol.key}
            type="button"
            role="radio"
            aria-checked={elegido}
            aria-label={rol.name}
            disabled={!rol.asignable}
            title={rol.asignable ? undefined : 'Tiene permisos que tu rol no tiene'}
            onClick={() => onChange(rol.key)}
            className={cn(
              'flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors duration-150 ease-[var(--ease-standard)]',
              elegido
                ? 'border-[var(--brand)] bg-surface-sunk shadow-[inset_3px_0_0_var(--brand)]'
                : 'border-line bg-surface enabled:hover:bg-surface-sunk',
              !rol.asignable && 'cursor-not-allowed opacity-55',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                elegido ? 'border-[var(--brand)]' : 'border-line-strong',
              )}
            >
              {elegido ? <span className="size-2 rounded-full bg-brand" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-base font-medium text-ink">{rol.name}</span>
                {rol.key === actual ? <span className="text-micro text-ink-muted">· rol actual</span> : null}
              </span>
              {rol.description ? (
                <span className="mt-0.5 block text-caption text-ink-secondary">{rol.description}</span>
              ) : null}
              <span className="mt-1 flex items-center gap-1 text-micro text-ink-muted">
                {rol.asignable ? <ShieldCheck className="size-3" /> : <Lock className="size-3" />}
                {rol.asignable ? resumenDePermisos(rol) : `${resumenDePermisos(rol)} · tu rol no los tiene todos`}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
