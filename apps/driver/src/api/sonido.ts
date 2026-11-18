/**
 * Sonido de oferta (17/11/2026).
 *
 * La pantalla de espera dice «te avisamos con sonido y vibración», y con la
 * aplicación abierta no sonaba nada: solo vibraba, y en iPhone ni eso. Este
 * es un timbre corto hecho con Web Audio, sin archivo que descargar ni
 * precachear.
 *
 * Los navegadores no dejan sonar nada hasta que la persona toca la página una
 * vez. Por eso el contexto de audio se prepara con el primer toque (entrar,
 * iniciar turno) y la oferta, que llega sin toque, ya lo encuentra abierto.
 */

let contexto: AudioContext | undefined;

function abrir(): AudioContext | undefined {
  try {
    contexto ??= new AudioContext();
    if (contexto.state === 'suspended') void contexto.resume();
    return contexto;
  } catch {
    return undefined;
  }
}

/** Deja el audio listo con el primer toque en cualquier parte de la página. */
export function prepararSonido(): () => void {
  const alTocar = () => {
    abrir();
    window.removeEventListener('pointerdown', alTocar);
  };
  window.addEventListener('pointerdown', alTocar);
  return () => window.removeEventListener('pointerdown', alTocar);
}

/** Tres tonos ascendentes, cortos y fuertes: distinto de una notificación cualquiera. */
export function sonarOferta(): void {
  const ctx = abrir();
  if (!ctx || ctx.state !== 'running') return;
  const inicio = ctx.currentTime + 0.02;
  [880, 1175, 1480].forEach((frecuencia, i) => {
    const oscilador = ctx.createOscillator();
    const volumen = ctx.createGain();
    oscilador.type = 'square';
    oscilador.frequency.value = frecuencia;
    const t = inicio + i * 0.18;
    volumen.gain.setValueAtTime(0.0001, t);
    volumen.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    volumen.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    oscilador.connect(volumen).connect(ctx.destination);
    oscilador.start(t);
    oscilador.stop(t + 0.17);
  });
}
