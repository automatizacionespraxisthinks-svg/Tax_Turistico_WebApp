/**
 * Cliente HTTP de la PWA del conductor.
 *
 * El token va al portador y se guarda en el almacenamiento local, no en una
 * cookie: la aplicación puede estar instalada y conviene que el token viva
 * con ella, revocable desde la oficina si se pierde el celular (§8.1).
 *
 * Toda llamada que cambie algo pasa por `enqueue`, que la reintenta al volver
 * la señal. En vereda la conexión se cae a mitad de carrera y el conductor no
 * puede quedarse esperando a que vuelva para marcar que llegó.
 */

export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';

const TOKEN_KEY = 'tax.driver.token';
const INSTALL_KEY = 'tax.driver.install';

/**
 * Identificador de esta instalación, estable entre accesos.
 *
 * Sin él, cada vez que el conductor vuelve a entrar el servidor registra un
 * dispositivo nuevo, y como los avisos se mandan a todos los dispositivos
 * vivos, la misma oferta le llegaría repetida. No es una credencial: no
 * abre nada por sí solo, solo dice «soy la misma instalación de siempre».
 */
export function installId(): string | undefined {
  try {
    const saved = window.localStorage.getItem(INSTALL_KEY);
    if (saved) return saved;
    const fresh = crypto.randomUUID();
    window.localStorage.setItem(INSTALL_KEY, fresh);
    return fresh;
  } catch {
    // Sin almacenamiento no hay identidad estable que valga; el servidor
    // registra el dispositivo como hasta ahora.
    return undefined;
  }
}

export function storedToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Modo privado o almacenamiento bloqueado: la sesión dura lo que la
    // pestaña, que es peor pero no impide trabajar.
  }
}

export interface ProblemDocument {
  title: string;
  status: number;
  code: string;
  detail?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(problem: ProblemDocument) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.code = problem.code;
  }

  /** Fallo de red, no del servidor: la acción se puede reintentar tal cual. */
  get isOffline(): boolean {
    return this.code === 'NETWORK';
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body) headers['content-type'] = 'application/json';

  if (options.auth !== false) {
    const token = storedToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (cause) {
    throw new ApiError({
      title: 'Sin conexión',
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
      title: problem?.title ?? response.statusText,
      status: problem?.status ?? response.status,
      code: problem?.code ?? 'INTERNAL',
      detail: problem?.detail,
    });
  }

  return payload as T;
}

/**
 * Una imagen protegida, como la foto del lugar. Un `<img src>` no puede
 * mandar el token del conductor, así que se pide aquí y se pinta desde el
 * blob.
 */
async function imagen(path: string): Promise<Blob> {
  const token = storedToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new ApiError({ title: response.statusText, status: response.status, code: 'NOT_FOUND' });
  }
  return response.blob();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  imagen,
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** Sin token: el acceso es lo que lo obtiene. */
  login: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body, auth: false }),
};
