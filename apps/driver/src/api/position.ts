import { api } from './client';

/**
 * Reporte de posición (§6, §9.2).
 *
 * Solo con turno abierto, y a la cadencia que manda la API en `/me`
 * (`POSITION_REPORT_*`, dos segundos por defecto). Esa cadencia es la del
 * mapa de la oficina: cada envío se reparte por el socket en cuanto llega,
 * así que el taxi se mueve en el panel al ritmo que se mande. Aquí no hay
 * número propio, para que cambiarlo en el servidor no deje a la PWA mandando
 * a otro ritmo ni obligue a recompilarla.
 *
 * Lo que se decide aquí es cada cuánto se ENVÍA, que es lo que gasta batería
 * y datos del conductor. Cada cuánto se guarda en la base lo decide el
 * servidor, y no es lo mismo: el panel puede ir a dos segundos sin que el
 * histórico del recorrido crezca por ello.
 */

export interface PositionIntervals {
  /** Segundos entre envíos con una carrera en curso. */
  ride: number;
  /** Segundos entre envíos en espera o en pausa. */
  idle: number;
}

/**
 * Último recurso, para una API que no mande `rules.positionSeconds`. No es
 * «la regla»: la regla vive en el entorno de la API. Esto solo evita que la
 * PWA se quede sin mandar nada si no la recibe.
 */
export const CADENCIA_POR_DEFECTO: PositionIntervals = { ride: 2, idle: 2 };

export interface PositionWatcher {
  stop: () => void;
  setRideId: (rideId: string | undefined) => void;
  /**
   * Manda la última posición ya, sin esperar la cadencia. Se usa al volver a
   * la aplicación: la oficina lleva un rato sin saber nada de ese taxi.
   */
  flush: () => void;
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
  /**
   * La cadencia que dijo la API. Es una función y no un número porque se lee
   * en cada envío: el vigilante se crea al abrir el turno y vive hasta
   * cerrarlo, así que una reconexión que traiga otra cadencia manda desde el
   * envío siguiente sin tener que recrearlo.
   */
  intervals: () => PositionIntervals;
}): PositionWatcher {
  let rideId: string | undefined;
  let lastPoint: { lat: number; lng: number } | undefined;
  let lastAccuracy: number | undefined;
  let lastSentAt = 0;
  let watchId: number | undefined;
  let fallbackTimer: number | undefined;

  const intervalMs = () =>
    (rideId ? options.intervals().ride : options.intervals().idle) * 1000;

  const enviar = (point: { lat: number; lng: number }, accuracyMeters?: number) => {
    lastSentAt = Date.now();

    void api
      .post('/v1/driver/position', {
        point,
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

  const report = (lat: number, lng: number, accuracyMeters?: number) => {
    // Se recuerda siempre, aunque toque no enviarla todavía: los comandos de
    // la carrera la necesitan para registrar dónde estaba el conductor.
    lastPoint = { lat, lng };
    lastAccuracy = accuracyMeters;
    options.onPosition?.(lastPoint);

    if (Date.now() - lastSentAt < intervalMs()) return;
    enviar(lastPoint, accuracyMeters);
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
      // Al entrar en carrera puede cambiar la cadencia: se fuerza el próximo
      // envío para no arrastrar la espera de la anterior.
      lastSentAt = 0;
    },
    flush: () => {
      if (lastPoint) enviar(lastPoint, lastAccuracy);
      // Sin ninguna lectura todavía: que salga sola la primera que llegue.
      else lastSentAt = 0;
    },
    last: () => lastPoint,
  };
}
