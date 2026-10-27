import { api } from './client';

/**
 * Reporte de posición (§6, §9.2).
 *
 * Solo con turno abierto, y a la cadencia que fija la arquitectura: cada 30 s
 * fuera de carrera, cada 10 s en carrera. El muestreo a la base lo decide el
 * servidor; aquí se decide cada cuánto se envía, que es lo que gasta batería
 * y datos del conductor.
 */

export interface PositionWatcher {
  stop: () => void;
  setRideId: (rideId: string | undefined) => void;
  /** Última posición conocida, para adjuntarla a los comandos de la carrera. */
  last: () => { lat: number; lng: number } | undefined;
}

/** Punto de respaldo SOLO en desarrollo, cuando el navegador niega el GPS. */
const DEV_FALLBACK = { lat: 5.7803, lng: -73.1142 };

export function watchPosition(options: {
  onError?: (message: string) => void;
  onSent?: () => void;
  /** Cada lectura del GPS, también las que no toca enviar. */
  onPosition?: (point: { lat: number; lng: number }) => void;
}): PositionWatcher {
  let rideId: string | undefined;
  let lastPoint: { lat: number; lng: number } | undefined;
  let lastSentAt = 0;
  let watchId: number | undefined;
  let fallbackTimer: number | undefined;

  const intervalMs = () => (rideId ? 10_000 : 30_000);

  const report = (lat: number, lng: number, accuracyMeters?: number) => {
    // Se recuerda siempre, aunque toque no enviarla todavía: los comandos de
    // la carrera la necesitan para registrar dónde estaba el conductor.
    lastPoint = { lat, lng };
    options.onPosition?.(lastPoint);

    const now = Date.now();
    if (now - lastSentAt < intervalMs()) return;
    lastSentAt = now;

    void api
      .post('/v1/driver/position', {
        point: { lat, lng },
        accuracyMeters: accuracyMeters ? Math.round(accuracyMeters) : undefined,
        rideId,
      })
      .then(() => options.onSent?.())
      .catch(() => {
        // Una posición perdida no se reintenta: la siguiente llega en
        // segundos y vale más que la vieja. Encolarlas llenaría la cola de
        // datos ya caducados.
      });
  };

  if ('geolocation' in navigator) {
    watchId = navigator.geolocation.watchPosition(
      (position) =>
        report(position.coords.latitude, position.coords.longitude, position.coords.accuracy),
      (error) => {
        options.onError?.(
          error.code === error.PERMISSION_DENIED
            ? 'Sin permiso de ubicación: la oficina no puede ofrecerte carreras.'
            : 'No se pudo leer el GPS.',
        );

        // En desarrollo se reporta un punto fijo para poder probar el
        // despacho sin GPS. En producción no: una posición inventada haría
        // que el despacho ofreciera carreras a quien no está ahí.
        if (import.meta.env.DEV && fallbackTimer === undefined) {
          fallbackTimer = window.setInterval(
            () => report(DEV_FALLBACK.lat, DEV_FALLBACK.lng),
            5_000,
          );
          report(DEV_FALLBACK.lat, DEV_FALLBACK.lng);
        }
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 },
    );
  } else {
    options.onError?.('Este dispositivo no tiene ubicación.');
  }

  return {
    stop: () => {
      if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
      if (fallbackTimer !== undefined) window.clearInterval(fallbackTimer);
    },
    setRideId: (next) => {
      rideId = next;
      // Al entrar en carrera sube la cadencia: se fuerza el próximo envío.
      lastSentAt = 0;
    },
    last: () => lastPoint,
  };
}
