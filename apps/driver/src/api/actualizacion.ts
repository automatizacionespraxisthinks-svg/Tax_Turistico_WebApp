/**
 * Versiones nuevas de la aplicación (17/11/2026).
 *
 * El service worker nuevo se activa solo (`skipWaiting` y `clients.claim` en
 * `sw.ts`), pero la página abierta sigue corriendo el código viejo hasta que
 * se recarga. Con la pantalla encendida todo el turno, eso podía ser días:
 * una corrección del despacho no le llegaba al conductor.
 *
 * Aquí se pregunta por una versión nueva cada media hora y cada vez que la
 * aplicación vuelve al frente, y se avisa cuando el service worker nuevo
 * toma el control. Quien llama decide cuándo recargar: nunca con una oferta
 * o una carrera en pantalla.
 */
export function vigilarActualizaciones(alHaberVersionNueva: () => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};

  // La primera instalación también cambia de controlador; eso no es una
  // versión nueva y recargar ahí sería un parpadeo sin sentido.
  const habiaControlador = Boolean(navigator.serviceWorker.controller);
  const alCambiar = () => {
    if (habiaControlador) alHaberVersionNueva();
  };
  navigator.serviceWorker.addEventListener('controllerchange', alCambiar);

  const revisar = () => {
    void navigator.serviceWorker
      .getRegistration()
      .then((registro) => registro?.update())
      .catch(() => undefined);
  };
  const temporizador = window.setInterval(revisar, 30 * 60_000);
  const alVolver = () => {
    if (document.visibilityState === 'visible') revisar();
  };
  document.addEventListener('visibilitychange', alVolver);

  return () => {
    navigator.serviceWorker.removeEventListener('controllerchange', alCambiar);
    window.clearInterval(temporizador);
    document.removeEventListener('visibilitychange', alVolver);
  };
}
