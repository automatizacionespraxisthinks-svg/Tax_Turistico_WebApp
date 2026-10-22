/**
 * Instalación de la PWA en el teléfono.
 *
 * Los dos sistemas lo hacen de forma distinta y hay que tratarlos distinto:
 *
 * - **Android**: Chrome dispara `beforeinstallprompt` cuando considera que la
 *   aplicación es instalable, y se puede abrir el diálogo nativo con un botón.
 *   Para que ese evento llegue, el manifiesto necesita iconos PNG de 192 y
 *   512; con solo SVG no se dispara nunca.
 *
 * - **iOS**: no existe nada programático. El usuario tiene que ir a Compartir
 *   y «Añadir a pantalla de inicio», así que lo único que se puede hacer es
 *   explicárselo bien. Y no es opcional: en iOS, Web Push **solo** funciona si
 *   la aplicación está instalada (iOS 16.4+). Un conductor en iPhone que no la
 *   instale no recibirá ofertas con el teléfono bloqueado.
 */

export type EstadoInstalacion =
  /** Ya está en la pantalla de inicio: no hay nada que ofrecer. */
  | 'instalada'
  /** Android con el diálogo nativo disponible. */
  | 'puede-instalarse'
  /** iOS: hay que explicarle los pasos, no hay botón posible. */
  | 'manual-ios'
  /** Navegador de escritorio o sin soporte: no se insiste. */
  | 'no-aplica';

export function esIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS se hace pasar por Mac; los puntos táctiles lo delatan.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function instalada(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/**
 * El evento de Chrome llega una sola vez y muy pronto, antes de que ninguna
 * pantalla esté montada. Se captura aquí, al cargar el módulo, y se guarda:
 * si se esperara a montar un componente, ya habría pasado.
 */
interface PromptInstalacion extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let guardado: PromptInstalacion | null = null;
const suscriptores = new Set<() => void>();

function avisar(): void {
  for (const f of suscriptores) f();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (evento) => {
    // Sin esto, Chrome muestra su propia barra y perdemos el control del
    // momento: conviene pedirlo cuando el conductor entiende para qué sirve.
    evento.preventDefault();
    guardado = evento as PromptInstalacion;
    avisar();
  });

  window.addEventListener('appinstalled', () => {
    guardado = null;
    avisar();
  });
}

export function suscribirInstalacion(f: () => void): () => void {
  suscriptores.add(f);
  return () => suscriptores.delete(f);
}

export function estadoInstalacion(): EstadoInstalacion {
  if (instalada()) return 'instalada';
  if (guardado) return 'puede-instalarse';
  if (esIOS()) return 'manual-ios';
  return 'no-aplica';
}

/**
 * Abre el diálogo nativo de Android. Devuelve si el conductor aceptó.
 *
 * El evento solo se puede usar una vez; si lo rechaza, Chrome no lo vuelve a
 * ofrecer en un buen rato y no hay forma de forzarlo.
 */
export async function pedirInstalacion(): Promise<boolean> {
  if (!guardado) return false;

  const evento = guardado;
  guardado = null;
  avisar();

  await evento.prompt();
  const { outcome } = await evento.userChoice;
  return outcome === 'accepted';
}
