import { useQuery } from '@tanstack/react-query';
import type { Permiso, Place } from '@tax/shared';
import { api } from './client';

/**
 * Consultas de solo lectura del panel.
 *
 * Las que cambian todo el rato —carreras, conductores— viven en el store en
 * vivo, porque el socket las empuja. Estas otras cambian de tarde en tarde, y
 * TanStack Query las cachea y las revalida sin que haga falta inventar nada.
 */

interface ApiPlace {
  id: string;
  name: string;
  kind: Place['kind'];
  zoneId: string | null;
  lat: number;
  lng: number;
  aliases: string[];
  uses: number;
}

export interface AuditEntry {
  seq: number;
  actorName: string;
  role: string;
  action: string;
  entity: string;
  entityId: string | null;
  ip: string | null;
  at: string;
  prevHash: string;
  hash: string;
}

export function usePlaces() {
  return useQuery({
    queryKey: ['places'],
    queryFn: async (): Promise<Place[]> => {
      const rows = await api.get<ApiPlace[]>('/v1/admin/places');
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        zoneId: row.zoneId ?? '',
        point: { lat: row.lat, lng: row.lng },
        aliases: row.aliases,
        uses: row.uses,
      }));
    },
    staleTime: 5 * 60_000,
  });
}


export function useAuditLog(limit = 50) {
  return useQuery({
    queryKey: ['audit', limit],
    queryFn: () => api.get<AuditEntry[]>(`/v1/audit?limit=${limit}`),
    staleTime: 30_000,
    // La bitácora pide «Ver la auditoría»: sin él llega un 403 y la pantalla
    // lo trata como «sin permiso», no como un fallo.
    retry: false,
  });
}

export function useAuditVerification() {
  return useQuery({
    queryKey: ['audit-verify'],
    queryFn: () => api.get<{ ok: boolean; brokenAtSeq?: number }>('/v1/audit/verify'),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/* ------------------------------------------------------------- sesión --- */

export interface SesionUsuario {
  id: string;
  name: string;
  email: string;
  /** Clave del rol: `administrador`, `operador` o uno creado en el panel. */
  role: string;
  roleName: string;
  permissions: Permiso[];
  totpEnabled: boolean;
}

/**
 * Quién está en sesión, con qué rol y qué permisos.
 *
 * El panel lo usa para no enseñar botones que el servidor va a rechazar. No
 * es la barrera de seguridad —esa está en el guardia de la API, que exige el
 * permiso en cada petición— sino cortesía: enseñar un botón que siempre falla
 * es peor que no enseñarlo.
 */
export function useSesion() {
  return useQuery({
    queryKey: ['sesion'],
    queryFn: () => api.get<{ user: SesionUsuario }>('/v1/auth/me'),
    staleTime: 5 * 60_000,
  });
}

/**
 * `puede('flota.gestionar')`. Mientras la sesión carga, nada: es preferible
 * que un botón aparezca un instante tarde a que aparezca y desaparezca.
 */
export function usePuede(): (permiso: Permiso) => boolean {
  const sesion = useSesion();
  const permisos = sesion.data?.user.permissions;
  return (permiso) => permisos?.includes(permiso) ?? false;
}
