import { precacheAndRoute } from 'workbox-precaching';

/**
 * Service worker de la PWA del conductor.
 *
 * Hace dos cosas: guardar la aplicación para que abra sin conexión, y recibir
 * los avisos de Web Push (ADR-07). Esto último es la razón de escribirlo a
 * mano en vez de dejar que Workbox lo genere: el service worker generado no
 * admite manejadores propios, y sin un `push` aquí el teléfono no se entera
 * de nada con la aplicación cerrada.
 */

/*
 * Los tipos del entorno de worker chocan con los del DOM si se cargan juntos,
 * así que se declara solo lo que se usa. Es poco y está acotado.
 */
interface ServiceWorkerScope {
  addEventListener(type: string, listener: (event: never) => void): void;
  registration: {
    showNotification(title: string, options?: NotificationOptions): Promise<void>;
    getNotifications(filter?: { tag?: string }): Promise<{ tag: string; close(): void }[]>;
  };
  clients: {
    matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<
      { url: string; focused: boolean; focus(): Promise<unknown>; navigate(url: string): Promise<unknown> }[]
    >;
    openWindow(url: string): Promise<unknown>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
}

interface ExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface PushEvent extends ExtendableEvent {
  data: { json(): unknown; text(): string } | null;
}

interface NotificationClickEvent extends ExtendableEvent {
  notification: { data?: { rideId?: string }; tag: string; close(): void };
}

const worker = self as unknown as ServiceWorkerScope;

/** Archivos de la aplicación, inyectados por vite-plugin-pwa al compilar. */
precacheAndRoute(self.__WB_MANIFEST);

worker.addEventListener('install', (() => {
  // La versión nueva entra sin esperar a que el conductor cierre todo: una
  // corrección en el despacho no puede quedarse esperando días.
  void worker.skipWaiting();
}) as never);

worker.addEventListener('activate', ((event: ExtendableEvent) => {
  event.waitUntil(worker.clients.claim());
}) as never);

interface Aviso {
  tipo: 'oferta' | 'oferta_retirada';
  rideId: string;
  titulo?: string;
  cuerpo?: string;
  /** Desde el segundo intento: la carrera ya dio una vuelta sin conductor. */
  urgente?: boolean;
  /** Acuse de recibo (21/11/2026): se devuelve a la API apenas llega. */
  ack?: { offerId: string; firma: string };
}

/** La API: la misma que usa la aplicación (VITE_API_BASE). */
const API_BASE: string = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';

/**
 * Le dice a la API que el aviso llegó a este teléfono. Es lo que permite al
 * panel distinguir «le llegó» de «se envió y no sabemos»; si no confirma, la
 * API lo reenvía. Nunca frena el aviso: va en paralelo y sus fallos se
 * ignoran.
 */
function confirmar(aviso: Aviso): Promise<unknown> {
  if (!aviso.ack) return Promise.resolve();
  return fetch(`${API_BASE}/v1/driver/push/recibido`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(aviso.ack),
  }).catch(() => undefined);
}

worker.addEventListener('push', ((event: PushEvent) => {
  if (!event.data) return;

  let aviso: Aviso;
  try {
    aviso = event.data.json() as Aviso;
  } catch {
    return;
  }

  if (aviso.tipo === 'oferta_retirada') {
    /*
     * Otro conductor la tomó: se cambia el aviso de la pantalla bloqueada por
     * uno discreto, con el mismo identificador. No basta con cerrarlo: Safari
     * (iPhone) le quita el permiso de avisos a la página que recibe pushes
     * sin mostrar nada, y desde entonces no le llegaría ninguna carrera.
     */
    event.waitUntil(
      worker.registration.showNotification('Carrera ya tomada', {
        body: 'Otro conductor la aceptó.',
        tag: aviso.rideId,
        renotify: false,
        silent: true,
        requireInteraction: false,
        data: { rideId: aviso.rideId },
        icon: '/icon-192.png',
        badge: '/badge-96.png',
      } as NotificationOptions),
    );
    return;
  }

  event.waitUntil(
    Promise.all([
      worker.registration.showNotification(aviso.titulo ?? 'Nueva carrera', {
        body: aviso.cuerpo ?? 'Toca para verla',
        // Mismo identificador que la carrera: un aviso nuevo de la misma
        // carrera sustituye al anterior en vez de apilarse.
        tag: aviso.rideId,
        renotify: true,
        // La ventana de la oleada son 45 segundos: el aviso tiene que quedarse
        // en pantalla hasta que el conductor lo atienda.
        requireInteraction: true,
        silent: false,
        // Urgente: vibración larga e insistente, para que se note en el bolsillo.
        vibrate: aviso.urgente ? [600, 200, 600, 200, 600, 200, 1200] : [300, 150, 300],
        data: { rideId: aviso.rideId },
        icon: '/icon-192.png',
        // Android solo mira la forma del icono pequeño de la barra de avisos.
        badge: '/badge-96.png',
      } as NotificationOptions),
      confirmar(aviso),
    ]),
  );
}) as never);

worker.addEventListener('notificationclick', ((event: NotificationClickEvent) => {
  event.notification.close();

  event.waitUntil(
    worker.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(async (windows) => {
        // Si la aplicación ya está abierta se trae al frente; abrir una
        // segunda ventana dejaría dos sesiones compitiendo por el socket.
        const open = windows[0];
        if (open) {
          await open.focus();
          return;
        }
        await worker.clients.openWindow('/');
      }),
  );
}) as never);

declare global {
  interface WindowOrWorkerGlobalScope {
    __WB_MANIFEST: { url: string; revision: string | null }[];
  }
}
