import { ApiError, api } from './client';

/**
 * Cola de acciones sin conexión.
 *
 * Señal rural débil (§5, «offline-first»): el conductor marca «llegué» en una
 * vereda sin cobertura y la acción no puede perderse ni bloquear la pantalla.
 * Se guarda, la interfaz avanza, y se reenvía al volver la señal.
 *
 * Persiste en `localStorage` en vez de IndexedDB porque son unas pocas
 * acciones de unos bytes: IndexedDB añadiría una capa asíncrona para guardar
 * lo que cabe en una línea. Si algún día hay que encolar fotos, cambia.
 *
 * Las acciones son idempotentes del lado de la API —marcar dos veces que se
 * llegó no rompe nada, la máquina de estados rechaza la segunda—, así que
 * reintentar es seguro.
 */

const QUEUE_KEY = 'tax.driver.queue';

export interface QueuedAction {
  id: string;
  path: string;
  body?: unknown;
  queuedAt: number;
}

type Listener = (pending: QueuedAction[]) => void;

let queue: QueuedAction[] = load();
let flushing = false;
const listeners = new Set<Listener>();

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
  listeners.forEach((listener) => listener(queue));
}

export function onQueueChange(listener: Listener): () => void {
  listeners.add(listener);
  listener(queue);
  return () => listeners.delete(listener);
}

export function pendingCount(): number {
  return queue.length;
}

/**
 * Envía la acción. Si falla por red, la guarda y devuelve `queued`, para que
 * la pantalla avance igual. Cualquier otro error —la carrera ya no es suya,
 * la oferta venció— se lanza: eso el conductor sí tiene que saberlo.
 */
export async function send(
  path: string,
  body?: unknown,
): Promise<{ status: 'sent'; data: unknown } | { status: 'queued' }> {
  try {
    const data = await api.post(path, body);
    return { status: 'sent', data };
  } catch (error) {
    if (error instanceof ApiError && error.isOffline) {
      queue = [...queue, { id: crypto.randomUUID(), path, body, queuedAt: Date.now() }];
      save();
      return { status: 'queued' };
    }
    throw error;
  }
}

/** Reenvía lo pendiente, en orden: un «a bordo» antes que un «finalicé». */
export async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;

  try {
    while (queue.length > 0) {
      const next = queue[0]!;
      try {
        await api.post(next.path, next.body);
      } catch (error) {
        // Sigue sin haber red: se deja para el próximo intento.
        if (error instanceof ApiError && error.isOffline) return;
        // El servidor la rechazó. Reintentarla eternamente bloquearía la cola
        // entera, así que se descarta y se sigue con la siguiente.
        console.warn('Acción descartada por el servidor', next.path, error);
      }
      queue = queue.slice(1);
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
