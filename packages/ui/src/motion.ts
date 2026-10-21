import type { Transition, Variants } from 'motion/react';

/**
 * Vocabulario de movimiento.
 *
 * Toda animación del producto sale de aquí. Si una pantalla necesita un gesto
 * que no está en esta tabla, se agrega aquí primero y se nombra; así el
 * producto entero se mueve con el mismo criterio en vez de acumular
 * transiciones sueltas.
 *
 * Reglas:
 *  - Cinco duraciones, cuatro curvas. Nada entre medias.
 *  - Entrar es más lento que salir: aparecer se nota, desaparecer no estorba.
 *  - Solo se animan `opacity` y `transform` (compositor), nunca `width`,
 *    `top` o `height` en bucles.
 *  - El movimiento informa: dirección y distancia dicen de dónde viene algo.
 */

/** Duraciones en segundos (la librería las usa así); en CSS son --mo-*. */
export const duration = {
  instant: 0.09,
  fast: 0.15,
  base: 0.24,
  slow: 0.38,
  deliberate: 0.56,
} as const;

/** Curvas, idénticas a las variables --ease-* de tokens.css. */
export const ease = {
  standard: [0.2, 0, 0, 1],
  entrance: [0.05, 0.7, 0.1, 1],
  exit: [0.3, 0, 0.8, 0.15],
  soft: [0.4, 0, 0.2, 1],
} as const;

/** Resortes para lo que responde al dedo o al puntero. */
export const spring = {
  /** Controles pequeños: botones, interruptores, marcadores. */
  snappy: { type: 'spring', stiffness: 560, damping: 34, mass: 0.7 },
  /** Paneles y tarjetas. */
  gentle: { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 },
  /** Indicador de navegación que sigue al elemento activo. */
  indicator: { type: 'spring', stiffness: 420, damping: 38, mass: 0.8 },
} satisfies Record<string, Transition>;

export const transition = {
  fast: { duration: duration.fast, ease: ease.standard },
  base: { duration: duration.base, ease: ease.standard },
  enter: { duration: duration.base, ease: ease.entrance },
  exit: { duration: duration.fast, ease: ease.exit },
  panel: { duration: duration.slow, ease: ease.entrance },
  notice: { duration: duration.deliberate, ease: ease.standard },
} satisfies Record<string, Transition>;

/* -------------------------------------------------------------- variantes --- */

/** Aparición neutra: para texto y contenido que no tiene origen espacial. */
export const fade: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: transition.enter },
  exit: { opacity: 0, transition: transition.exit },
};

/** Entrada estándar: sube 6 px. Tarjetas, filas, bloques de una página. */
export const rise: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: transition.enter },
  exit: { opacity: 0, y: -4, transition: transition.exit },
};

/** Entrada de diálogos y menús: nacen desde su propio centro. */
export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.97 },
  visible: { opacity: 1, scale: 1, transition: transition.enter },
  exit: { opacity: 0, scale: 0.98, transition: transition.exit },
};

/** Hoja lateral: entra desde el borde derecho. */
export const sheetRight: Variants = {
  hidden: { x: '100%' },
  visible: { x: 0, transition: transition.panel },
  exit: { x: '100%', transition: { duration: duration.base, ease: ease.exit } },
};

/** Hoja inferior: para la PWA del conductor. */
export const sheetBottom: Variants = {
  hidden: { y: '100%' },
  visible: { y: 0, transition: transition.panel },
  exit: { y: '100%', transition: { duration: duration.base, ease: ease.exit } },
};

/** Velo que acompaña a cualquier capa modal. */
export const scrim: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: duration.base, ease: ease.standard } },
  exit: { opacity: 0, transition: { duration: duration.fast, ease: ease.exit } },
};

/**
 * Listas: el contenedor escalona a sus hijos.
 * 28 ms es suficiente para leer el orden sin que la lista se sienta lenta;
 * el tope evita que una lista larga tarde segundos en terminar de entrar.
 */
const STAGGER_NORMAL: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.028, delayChildren: 0.02 } },
};

const STAGGER_FAST: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.012, delayChildren: 0.02 } },
};

/** Igual que arriba: dos objetos estables, no uno nuevo por render. */
export const staggerList = (count = 0): Variants =>
  count > 14 ? STAGGER_FAST : STAGGER_NORMAL;

export const staggerItem: Variants = rise;

/**
 * Transición entre rutas del panel: cruce corto con un desplazamiento mínimo.
 * Nada de deslizamientos largos; la navegación debe sentirse instantánea.
 */
export const routeTransition: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: duration.base, ease: ease.entrance } },
  exit: { opacity: 0, y: -6, transition: { duration: duration.fast, ease: ease.exit } },
};

/**
 * Pantallas del conductor: la dirección sigue el avance de la carrera.
 * Adelante entra por la derecha; retroceder entra por la izquierda.
 *
 * Las dos variantes se construyen UNA vez y se reutilizan. Devolver un objeto
 * nuevo en cada render rompe `AnimatePresence`: mientras el componente se
 * vuelve a pintar —y en la PWA lo hace sin parar, por el GPS, los avisos y el
 * contador—, la animación de salida se reinicia, nunca termina y la pantalla
 * siguiente no llega a montarse. El estado cambia pero el conductor ve la
 * pantalla anterior.
 */
const buildScreenTransition = (direction: 1 | -1): Variants => ({
  hidden: { opacity: 0, x: direction * 28 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: duration.slow, ease: ease.entrance },
  },
  exit: {
    opacity: 0,
    x: direction * -28,
    transition: { duration: duration.base, ease: ease.exit },
  },
});

const SCREEN_FORWARD = buildScreenTransition(1);
const SCREEN_BACK = buildScreenTransition(-1);

export const screenTransition = (direction: 1 | -1): Variants =>
  direction === 1 ? SCREEN_FORWARD : SCREEN_BACK;

/** Realimentación de pulsación para controles grandes. */
export const pressable = {
  whileHover: { y: -1 },
  whileTap: { scale: 0.985 },
  transition: spring.snappy,
} as const;

/** Lo mismo, sin desplazamiento, para botones de ancho completo. */
export const pressableFlat = {
  whileTap: { scale: 0.99 },
  transition: spring.snappy,
} as const;
