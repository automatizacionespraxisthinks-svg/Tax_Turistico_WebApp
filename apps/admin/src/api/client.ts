/**
 * Cliente HTTP del panel.
 *
 * La sesión va en una cookie HttpOnly, así que el navegador la manda solo si
 * se pide `credentials: 'include'`; el token nunca pasa por JavaScript y un
 * XSS no puede llevárselo.
 *
 * Los errores llegan en formato RFC 9457 con un `code` estable: la interfaz
 * ramifica por ese código, nunca por el texto, que puede cambiar.
 */

export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: { path: string; message: string }[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: ProblemDocument;

  constructor(problem: ProblemDocument) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.code = problem.code;
    this.problem = problem;
  }

  /** La sesión caducó o nunca existió: el panel debe volver al acceso. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers: options.body ? { 'content-type': 'application/json' } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (cause) {
    // Fallo de red: la API no responde. Se distingue de un error de la API
    // porque la oficina necesita saber si el problema es el servidor o su
    // propia conexión.
    throw new ApiError({
      type: 'about:blank',
      title: 'Sin conexión con el servidor',
      status: 0,
      code: 'NETWORK',
      detail: cause instanceof Error ? cause.message : undefined,
    });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const problem = payload as Partial<ProblemDocument> | null;
    throw new ApiError({
      type: problem?.type ?? 'about:blank',
      title: problem?.title ?? response.statusText,
      status: problem?.status ?? response.status,
      code: problem?.code ?? 'INTERNAL',
      detail: problem?.detail,
      errors: problem?.errors,
    });
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
};
