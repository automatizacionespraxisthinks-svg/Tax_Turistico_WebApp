import { ApiError, api } from './client';

/**
 * Cola de acciones sin conexión.
 *
 * Señal rural débil (§5, «offline-first»): el conductor marca «llegué» en una
 * vereda sin cobertura y la acción no puede perderse ni bloquear la pantalla.
 * Se guarda, la interfaz avanza, y se reenvía al volver la señal.
 *
 * Solo para las ETAPAS de una carrera que ya es suya: llegué, a bordo,
 * finalicé (17/11/2026). Aceptar una oferta y abrir o cerrar el turno van
 * directo: antes también se encolaban, y un «Aceptar» sin señal llevaba al
 * conductor a buscar a un cliente que el servidor nunca le dio.
 *
 * Persiste en `localStorage` en vez de IndexedDB porque son unas pocas
 * acciones de unos bytes: IndexedDB añadiría una capa asíncrona para guardar
 * lo que cabe en una línea. Si algún día hay que encolar fotos, cambia.
 *
 * Cada acción lleva su clave de idempotencia: si un envío llegó al servidor
 * pero la respuesta se perdió, el reintento no la repite.
 */

const QUEUE_KEY = 'tax.driver.queue';
/** De quién es la sesión, recordado: al abrir sin señal todavía no lo dice la API. */
const OWNER_KEY = 'tax.driver.queue.owner';

export interface QueuedAction {
  id: string;
  path: string;
  body?: unknown;
  queuedAt: number;
  /** El conductor que la hizo: la cola no se le reenvía con el token de otro. */
  owner?: string;
}

/** Una acción que el servidor rechazó al reenviarla: el conductor tiene que saberlo. */
export interface AccionRechazada {
  accion: QueuedAction;
  motivo: string;
}

type Listener = (pending: QueuedAction[]) => void;
type ListenerRechazo = (rechazada: AccionRechazada) => void;

let queue: QueuedAction[] = load();
let flushing = false;
let owner: string | undefined = leerDueno();
const listeners = new Set<Listener>();
const rechazos = new Set<ListenerRechazo>();

function leerDueno(): string | undefined {
  try {
    return window.localStorage.getItem(OWNER_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function load(): QueuedAction[] {
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedAction[]) : [];
  } catch {
    return [];
  }
}

function save(): void {
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Si no se puede guardar, la cola vive en memoria: mejor que nada.
  }
  const propias = pendientes();
  listeners.forEach((listener) => listener(propias));
}

/** Lo pendiente del conductor que tiene la sesión. */
function pendientes(): QueuedAction[] {
  return queue.filter((a) => !a.owner || a.owner === owner);
}

/**
 * Quién tiene la sesión. Con un celular compartido, la cola de uno no se le
 * reenvía al otro: se quedaría rechazada con el token equivocado.
 */
export function setQueueOwner(codigo: string | undefined): void {
  owner = codigo;
  try {
    if (codigo) window.localStorage.setItem(OWNER_KEY, codigo);
    else window.localStorage.removeItem(OWNER_KEY);
  } catch {
    // Sin almacenamiento vale lo de la memoria.
  }
  save();
}

/** Lo que queda del conductor que sale, para que no se mezcle con el que entra. */
export function clearQueueOf(codigo: string): void {
  queue = queue.filter((a) => a.owner !== codigo);
  save();
}

export function onQueueChange(listener: Listener): () => void {
  listeners.add(listener);
  listener(pendientes());
  return () => listeners.delete(listener);
}

export function onQueueRejected(listener: ListenerRechazo): () => void {
  rechazos.add(listener);
  return () => rechazos.delete(listener);
}

export function pendingCount(): number {
  return pendientes().length;
}

/**
 * Envía la acción. Si falla por algo pasajero —sin red, tiempo agotado, el
 * servidor reiniciándose—, la guarda y devuelve `queued`, para que la
 * pantalla avance igual. Un rechazo de verdad —la carrera ya no es suya— se
 * lanza: eso el conductor sí tiene que saberlo.
 */
export async function send(
  path: string,
  body?: unknown,
): Promise<{ status: 'sent'; data: unknown } | { status: 'queued' }> {
  const id = crypto.randomUUID();
  try {
    const data = await api.post(path, body, { 'idempotency-key': id });
    return { status: 'sent', data };
  } catch (error) {
    if (error instanceof ApiError && error.isRetryable) {
      queue = [...queue, { id, path, body, queuedAt: Date.now(), owner }];
      save();
      return { status: 'queued' };
    }
    throw error;
  }
}

/**
 * Reenvía lo pendiente, en orden: un «a bordo» antes que un «finalicé».
 *
 * - Fallo pasajero: se para y se reintenta más tarde.
 * - 401 (sesión en pausa o revocada): se para sin borrar nada; si la oficina
 *   lo habilita, sale cuando vuelva a entrar.
 * - Rechazo del servidor: se descarta —reintentarla eternamente bloquearía la
 *   cola— y se avisa, en vez de quedar solo en la consola.
 */
export async function flush(): Promise<void> {
  if (flushing || pendientes().length === 0) return;
  flushing = true;

  try {
    for (;;) {
      const next = pendientes()[0];
      if (!next) break;
      try {
        await api.post(next.path, next.body, { 'idempotency-key': next.id });
      } catch (error) {
        if (error instanceof ApiError && (error.isRetryable || error.status === 401)) return;
        const motivo = error instanceof ApiError ? error.message : 'El servidor no la aceptó.';
        rechazos.forEach((listener) => listener({ accion: next, motivo }));
      }
      queue = queue.filter((a) => a.id !== next.id);
      save();
    }
  } finally {
    flushing = false;
  }
}

/** Intenta vaciar la cola cuando el navegador dice que hay red otra vez. */
export function watchConnection(): () => void {
  const onOnline = () => void flush();
  window.addEventListener('online', onOnline);

  // `navigator.onLine` miente a menudo (dice «sí» con el wifi del hotel sin
  // salida), así que además se reintenta cada cierto tiempo.
  const timer = window.setInterval(() => void flush(), 20_000);

  return () => {
    window.removeEventListener('online', onOnline);
    window.clearInterval(timer);
  };
}
