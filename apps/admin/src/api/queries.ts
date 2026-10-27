import { useQuery } from '@tanstack/react-query';
import type { Place, SystemChecks } from '@tax/shared';
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
    // La bitácora es de administradores: un operador recibe 403 y la pantalla
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

/* ------------------------------------------------------------- reportes */

export function useRidesByHour(days = 1) {
  return useQuery({
    queryKey: ['reports', 'rides-by-hour', days],
    queryFn: () =>
      api.get<{ hour: string; urbano: number; rural: number }[]>(
        `/v1/reports/rides-by-hour?days=${days}`,
      ),
    staleTime: 60_000,
  });
}

export function useAssignmentTimes(days = 7) {
  return useQuery({
    queryKey: ['reports', 'assignment-times', days],
    queryFn: () =>
      api.get<{ day: string; p50: number; p95: number }[]>(
        `/v1/reports/assignment-times?days=${days}`,
      ),
    staleTime: 60_000,
  });
}

export function useDemandByZone(days = 7) {
  return useQuery({
    queryKey: ['reports', 'demand-by-zone', days],
    queryFn: () =>
      api.get<{ zone: string; kind: string; rides: number }[]>(
        `/v1/reports/demand-by-zone?days=${days}`,
      ),
    staleTime: 60_000,
  });
}

export function useAutomationRate(days = 7) {
  return useQuery({
    queryKey: ['reports', 'automation-rate', days],
    queryFn: () =>
      api.get<{ day: string; rate: number }[]>(`/v1/reports/automation-rate?days=${days}`),
    staleTime: 60_000,
  });
}

/** Las cifras de arriba de Reportes, contadas igual que el Excel y el PDF. */
export interface ResumenOperacion {
  creadas: number;
  finalizadas: number;
  canceladas: number;
  sinAsignar: number;
  enCurso: number;
  horaPico: { hora: string; carreras: number } | null;
  asignacionP50: number | null;
  llegadaP50: number | null;
  duracionP50: number | null;
  kmRecorridos: number;
  sinIntervencion: number | null;
  conductores: number;
}

export function useReportSummary(days = 7) {
  return useQuery({
    queryKey: ['reports', 'summary', days],
    queryFn: () => api.get<ResumenOperacion>(`/v1/reports/summary?days=${days}`),
    staleTime: 60_000,
  });
}

export function useSystemStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: () =>
      api.get<{
        rides: { unassigned: number; active: number };
        outbox: { dead: number };
        slo: { assignmentP95Seconds: number | null };
        process: { rssMb: number; heapMb: number; uptimeSeconds: number };
      }>('/status'),
    refetchInterval: 15_000,
  });
}

/**
 * Las comprobaciones reales de cada servicio. Solo para la oficina: dice
 * versiones y nombres que `/status`, que es público, no enseña.
 */
export function useSystemChecks() {
  return useQuery({
    queryKey: ['system-checks'],
    queryFn: () => api.get<SystemChecks>('/v1/admin/system'),
    refetchInterval: 15_000,
  });
}


/* ------------------------------------------------------------- sesión --- */

export interface SesionUsuario {
  id: string;
  name: string;
  email: string;
  role: 'administrador' | 'operador';
  totpEnabled: boolean;
}

/**
 * Quién está en sesión y con qué rol.
 *
 * El panel lo usa para no enseñar botones que el servidor va a rechazar. No
 * es la barrera de seguridad —esa está en el guardia de la API, que exige
 * `administrador`— sino cortesía: enseñar un botón que siempre falla es peor
 * que no enseñarlo.
 */
export function useSesion() {
  return useQuery({
    queryKey: ['sesion'],
    queryFn: () => api.get<{ user: SesionUsuario }>('/v1/auth/me'),
    staleTime: 5 * 60_000,
  });
}
