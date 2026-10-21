import { api } from './client';

/**
 * Suscripción a Web Push (ADR-07).
 *
 * Es el respaldo del socket: mientras la aplicación está abierta las ofertas
 * llegan por socket en milisegundos; esto es lo que despierta el teléfono
 * cuando está bloqueado o la aplicación cerrada. La oleada 1 dura 45
 * segundos, así que sin esto un conductor con el celular en el bolsillo se
 * queda fuera.
 */

export type PushState =
  | 'activo'
  | 'sin-permiso'
  | 'denegado'
  | 'requiere-instalar'
  | 'no-soportado';

/**
 * En iOS el push solo existe si la PWA está instalada en la pantalla de
 * inicio (iOS 16.4+). Desde Safari como web normal no hay `PushManager`, y
 * conviene decirlo con esas palabras en vez de «no soportado»: la solución
 * es instalarla, no cambiar de teléfono.
 */
function esIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function instalada(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function pushSupport(): PushState {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    return esIOS() && !instalada() ? 'requiere-instalar' : 'no-soportado';
  }
  if (!('PushManager' in window)) {
    return esIOS() && !instalada() ? 'requiere-instalar' : 'no-soportado';
  }

  if (Notification.permission === 'granted') return 'activo';
  if (Notification.permission === 'denied') return 'denegado';
  return 'sin-permiso';
}

/**
 * La clave VAPID viaja en base64url y el navegador la quiere en bytes.
 * Se reserva el búfer explícitamente para que el tipo sea `ArrayBuffer` y no
 * el `ArrayBufferLike` que `applicationServerKey` rechaza.
 */
function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Pide permiso y registra el teléfono.
 *
 * Se llama al abrir el turno, no al abrir la aplicación: pedir permiso de
 * notificaciones nada más entrar es la forma más rápida de que lo denieguen
 * para siempre, y denegado no se puede volver a preguntar desde la web.
 */
export async function enablePush(): Promise<PushState> {
  const support = pushSupport();
  if (support === 'no-soportado' || support === 'requiere-instalar' || support === 'denegado') {
    return support;
  }

  const { publicKey, enabled } = await api.get<{ publicKey: string | null; enabled: boolean }>(
    '/v1/driver/push/key',
  );

  // El servidor no tiene claves VAPID configuradas: no se molesta al
  // conductor con un permiso que no serviría de nada.
  if (!enabled || !publicKey) return 'no-soportado';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denegado' : 'sin-permiso';

  const registration = await navigator.serviceWorker.ready;

  // Si ya había una suscripción se reutiliza: volver a suscribirse genera un
  // endpoint nuevo y deja el anterior muerto en la base.
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      // Obligatorio en Chrome: no se admiten avisos silenciosos sin mostrar
      // nada al usuario.
      userVisibleOnly: true,
      applicationServerKey: keyToBytes(publicKey),
    }));

  await api.post('/v1/driver/push/subscribe', subscription.toJSON());
  return 'activo';
}

/** Al cerrar el turno el teléfono deja de recibir ofertas. */
export async function disablePush(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // Si el navegador no deja desuscribir, al menos el servidor deja de
    // tener a dónde enviar.
  }

  await api.delete('/v1/driver/push/subscribe').catch(() => undefined);
}
