import { z } from 'zod';

/**
 * Roles y permisos de la oficina (RBAC, §8.1).
 *
 * Un rol es un nombre con una lista de permisos, y cada usuario del panel
 * tiene uno. Ver la operación —tablero, carreras, flota, mapa, zonas— es la
 * base de cualquier cuenta; los permisos son lo que se puede **cambiar** o
 * lo que se ve aparte (reportes, bitácora).
 *
 * Hay dos roles de base que no se pueden borrar:
 *
 *  - `administrador` tiene todos los permisos, incluidos los que se agreguen
 *    después, y no se edita: si se pudiera, alguien podría dejar la empresa
 *    sin nadie capaz de gestionar usuarios.
 *  - `operador` es con el que se crean las cuentas si no se elige otro. Sus
 *    permisos sí se cambian.
 *
 * El catálogo vive aquí porque la API lo hace cumplir y el panel lo pinta.
 */

export const ROL_ADMINISTRADOR = 'administrador';
export const ROL_OPERADOR = 'operador';

export const AREAS_DE_PERMISO = ['Operación', 'Flota', 'Zonas', 'Reportes', 'Sistema'] as const;
export type AreaDePermiso = (typeof AREAS_DE_PERMISO)[number];

export const PERMISOS = [
  {
    clave: 'carreras.despachar',
    area: 'Operación',
    nombre: 'Relanzar y asignar carreras',
    descripcion: 'Relanzar el despacho de una carrera o asignársela a mano a un conductor.',
  },
  {
    clave: 'carreras.corregir',
    area: 'Operación',
    nombre: 'Corregir carreras',
    descripcion: 'Cambiar la dirección de recogida y el medio de pago.',
  },
  {
    clave: 'carreras.cancelar',
    area: 'Operación',
    nombre: 'Cancelar carreras',
    descripcion: 'Cancelar una carrera en nombre de la oficina.',
  },
  {
    clave: 'clientes.marcar',
    area: 'Operación',
    nombre: 'Marcar clientes de prueba',
    descripcion: 'Para que Reportes deje fuera sus carreras.',
  },
  {
    clave: 'conductores.gestionar',
    area: 'Flota',
    nombre: 'Gestionar conductores',
    descripcion:
      'Dar de alta, activar o desactivar, pago electrónico, cuentas de prueba, PIN nuevo y teléfonos registrados.',
  },
  {
    clave: 'conductores.suspender',
    area: 'Flota',
    nombre: 'Suspender conductores',
    descripcion: 'Suspender por días con un motivo, y levantar la suspensión antes de tiempo.',
  },
  {
    clave: 'zonas.gestionar',
    area: 'Zonas',
    nombre: 'Gestionar zonas y oleadas',
    descripcion: 'Crear zonas y cambiar sus oleadas: cambia a quién se le ofrece cada carrera.',
  },
  {
    clave: 'lugares.gestionar',
    area: 'Zonas',
    nombre: 'Gestionar lugares',
    descripcion: 'Agregar, corregir y quitar lugares del catálogo.',
  },
  {
    clave: 'reportes.ver',
    area: 'Reportes',
    nombre: 'Ver reportes',
    descripcion: 'El tablero de reportes con sus filtros.',
  },
  {
    clave: 'reportes.exportar',
    area: 'Reportes',
    nombre: 'Exportar reportes',
    descripcion: 'Descargar las carreras en Excel o PDF.',
    requiere: 'reportes.ver',
  },
  {
    clave: 'auditoria.ver',
    area: 'Sistema',
    nombre: 'Ver la auditoría',
    descripcion: 'La bitácora de quién hizo qué, y la verificación de la cadena.',
  },
  {
    clave: 'usuarios.gestionar',
    area: 'Sistema',
    nombre: 'Gestionar usuarios',
    descripcion:
      'Dar de alta, desactivar, reiniciar contraseñas y cambiar el rol. Solo hasta sus propios permisos.',
  },
  {
    clave: 'roles.gestionar',
    area: 'Sistema',
    nombre: 'Gestionar roles',
    descripcion: 'Crear roles y cambiar sus permisos. Solo hasta sus propios permisos.',
  },
  {
    clave: 'sistema.tecnico',
    area: 'Sistema',
    nombre: 'Tareas técnicas',
    descripcion:
      'Reintentar avisos a n8n, quitar líneas de WhatsApp y purgar el histórico de GPS. Hoy solo desde la API.',
  },
] as const satisfies readonly {
  clave: string;
  area: AreaDePermiso;
  nombre: string;
  descripcion: string;
  requiere?: string;
}[];

export type Permiso = (typeof PERMISOS)[number]['clave'];

export const CLAVES_DE_PERMISO = PERMISOS.map((p) => p.clave) as Permiso[];

export function esPermiso(valor: string): valor is Permiso {
  return (CLAVES_DE_PERMISO as string[]).includes(valor);
}

/**
 * Lo que podía hacer un operador antes de que hubiera roles editables. La
 * migración siembra el rol `operador` con esto, así que nadie pierde nada al
 * desplegar.
 */
export const PERMISOS_DEL_OPERADOR: Permiso[] = [
  'carreras.despachar',
  'carreras.corregir',
  'carreras.cancelar',
  'clientes.marcar',
  'lugares.gestionar',
  'reportes.ver',
  'reportes.exportar',
];

/**
 * Los permisos efectivos de un rol: el administrador los tiene todos, y a
 * los demás se les quita lo que ya no existe en el catálogo (un permiso
 * retirado en una versión nueva no debe seguir abriendo nada).
 */
export function permisosDelRol(rol: { key: string; permissions: readonly string[] }): Permiso[] {
  if (rol.key === ROL_ADMINISTRADOR) return [...CLAVES_DE_PERMISO];
  return CLAVES_DE_PERMISO.filter((p) => rol.permissions.includes(p));
}

/**
 * Completa los permisos que otro necesita: exportar sin poder abrir Reportes
 * sería un botón inalcanzable. Devuelve el catálogo en su orden.
 */
export function completarPermisos(permisos: readonly string[]): Permiso[] {
  const con = new Set(permisos.filter(esPermiso));
  for (const p of PERMISOS) {
    if ('requiere' in p && con.has(p.clave)) con.add(p.requiere);
  }
  return CLAVES_DE_PERMISO.filter((p) => con.has(p));
}

/** Si `a` no da nada que `b` no tenga. La regla contra subir de nivel. */
export function cabeEn(a: readonly string[], b: readonly string[]): boolean {
  return a.every((p) => b.includes(p));
}

export const rolSchema = z.object({
  name: z.string().trim().min(3, 'Ponle un nombre de al menos 3 letras').max(40),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(z.string()).max(CLAVES_DE_PERMISO.length * 2),
});
export type RolEntrada = z.infer<typeof rolSchema>;

/** «Supervisor nocturno» → `supervisor-nocturno`: la clave que guarda el usuario. */
export function claveDeRol(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
