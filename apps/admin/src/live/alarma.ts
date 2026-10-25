/**
 * Pitido de alerta, generado con WebAudio: sin archivo de sonido que cargar.
 *
 * El navegador no deja sonar nada hasta que la persona toca la página. El
 * contexto de audio se abre con el primer clic o tecla, y desde ahí las
 * alertas suenan aunque la pestaña del panel esté en segundo plano. Antes de
 * ese primer gesto no suena: el aviso queda solo en pantalla.
 */

let contexto: AudioContext | null = null;
/**
 * Cuando WAHA deja de contestar caen las tres líneas en la misma revisión y
 * llegan tres alertas a la vez: tres alarmas encimadas suenan a una más
 * fuerte, no a tres. Una basta para que alguien mire.
 */
const SILENCIO_ENTRE_ALARMAS_MS = 2_000;
let ultimaAlarma = 0;

function desbloquear(): void {
  contexto ??= new AudioContext();
  void contexto.resume();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', desbloquear, { once: true });
  window.addEventListener('keydown', desbloquear, { once: true });
}

/** Tres tonos cortos, alto-bajo-alto: se distingue de cualquier notificación del sistema. */
export function sonarAlarma(): void {
  if (!contexto) return;
  if (Date.now() - ultimaAlarma < SILENCIO_ENTRE_ALARMAS_MS) return;
  ultimaAlarma = Date.now();
  const audio = contexto;
  const inicio = audio.currentTime;

  [880, 660, 880].forEach((frecuencia, i) => {
    const t = inicio + i * 0.22;
    const oscilador = audio.createOscillator();
    const volumen = audio.createGain();
    oscilador.type = 'sine';
    oscilador.frequency.value = frecuencia;
    // Rampa de entrada y salida: un corte en seco suena como un chasquido.
    volumen.gain.setValueAtTime(0.0001, t);
    volumen.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    volumen.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    oscilador.connect(volumen).connect(audio.destination);
    oscilador.start(t);
    oscilador.stop(t + 0.2);
  });
}
