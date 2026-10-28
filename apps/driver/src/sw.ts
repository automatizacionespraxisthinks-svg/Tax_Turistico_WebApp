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
  expiraEn?: string;
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
    // Otro conductor la tomó: se quita de la pantalla bloqueada en vez de
    // dejar ahí una carrera que ya no puede aceptar.
    event.waitUntil(
      worker.registration
        .getNotifications({ tag: aviso.rideId })
        .then((notifications) => notifications.forEach((notification) => notification.close())),
    );
    return;
  }

  event.waitUntil(
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
      data: { rideId: aviso.rideId },
      icon: '/icon-192.png',
      // Android solo mira la forma del icono pequeño de la barra de avisos.
      badge: '/badge-96.png',
    } as NotificationOptions),
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
