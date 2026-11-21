/**
 * Datos del cliente que llegan por WhatsApp (21/11/2026).
 *
 * Pasó en producción: una carrera se creó con la recogida «disponible» y otra
 * a nombre de «Dd». El agente usaba lo que hubiera, aunque no sirviera para
 * nada al conductor ni a la oficina. Estas reglas deciden cuándo un dato no
 * sirve; el flujo de n8n usa las mismas (copiadas en su nodo) para preguntar
 * solo lo que falta, y la API las aplica como red final.
 */

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Lo que no es un nombre aunque venga en el campo del nombre. */
const NO_NOMBRES = new Set([
  'usuario', 'user', 'cliente', 'client', 'whatsapp', 'null', 'undefined', 'test', 'prueba',
  'sin nombre', 'sinnombre', 'desconocido', 'anonimo', 'nn', 'xx', 'xxx', 'ok', 'hola', 'yo', 'contacto',
]);

/**
 * Si un nombre sirve para reconocer al cliente: al menos una palabra de tres
 * letras o más con alguna vocal, que no sea todo la misma letra ni una de las
 * palabras de relleno. «Maja🌺», «Daya ~» y «Alexander Acho» sirven; «Dd»,
 * «.», «+57 318…» y «Usuario» no.
 */
export function nombreClaro(nombre: string | null | undefined): boolean {
  const limpio = sinTildes(String(nombre ?? ''))
    .toLowerCase()
    .replace(/[^a-zñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpio || NO_NOMBRES.has(limpio)) return false;
  return limpio
    .split(' ')
    .some((w) => w.length >= 3 && /[aeiou]/.test(w) && !/^(.)\1+$/.test(w) && !NO_NOMBRES.has(w));
}

/**
 * Palabras que no ubican nada: lo que el cliente responde a otra pregunta
 * («disponible», «efectivo», «sí») o lo que el flujo pone cuando no hay
 * dirección. Una recogida hecha solo de esto no es una dirección.
 */
const RELLENO = new Set(
  (
    'disponible disponibles aqui aca alla ahi ya si no ok okay listo bueno bien efectivo transferencia nequi daviplata ' +
    'pago pagar taxi taxis un una el la lo los las mi mis su sus de del en por favor porfa gracias hola buenas buenos ' +
    'dias tardes noches servicio ubicacion direccion casa mismo misma mismos igual donde estoy esta estamos punto ' +
    'indicado cliente compartida whatsapp espero pendiente necesito necesita quiero urgente rapido ya mismo sin'
  ).split(' '),
);

/**
 * Si el texto de recogida, sin ubicación compartida, no dice dónde es.
 * «disponible», «aquí», «mi casa» o «Punto indicado por el cliente» → true;
 * «detrás del Zue», «Calle 25 #18-40», «terminal» → false.
 */
export function recogidaSinSentido(texto: string | null | undefined): boolean {
  const palabras = sinTildes(String(texto ?? ''))
    .toLowerCase()
    .replace(/[^a-z0-9ñ#\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (palabras.length === 0) return true;
  // Un número suelto («25», «#18») puede ser parte de una dirección: cuenta.
  return palabras.every((w) => RELLENO.has(w));
}
