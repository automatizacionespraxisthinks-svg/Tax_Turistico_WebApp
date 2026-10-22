/**
 * Política de contraseñas de la oficina (§8.1).
 *
 * Vive aquí, compartida, porque el servidor y el panel tienen que juzgar lo
 * mismo: si el panel aceptara algo que el servidor rechaza, el operador
 * escribiría una contraseña válida a sus ojos y recibiría un error sin
 * entender por qué.
 *
 * ## Por qué NO se obligan símbolos ni mayúsculas
 *
 * Es lo que todo el mundo pide y lo que casi todas las guías modernas
 * desaconsejan, incluida la NIST SP 800-63B. Obligar «una mayúscula, un
 * número y un símbolo» no produce contraseñas fuertes: produce `Taxi2026!`,
 * que un atacante prueba de las primeras porque todo el mundo resuelve la
 * regla igual —mayúscula al principio, número y símbolo al final—.
 *
 * Lo que de verdad cuesta de romper es la longitud. `el perro de mi vecino
 * ladra` no tiene un solo símbolo y es órdenes de magnitud más difícil de
 * adivinar que `Taxi2026!`, además de que se recuerda sin apuntarla en un
 * papel pegado al monitor, que es como acaban las contraseñas «seguras».
 *
 * Así que aquí: mínimo largo, nada obligatorio en cuanto a composición, y se
 * rechaza lo que de verdad se adivina —lo relacionado con la persona, con la
 * empresa, y las de siempre—.
 */

export const PASSWORD_MIN_LENGTH = 12;
/** Argon2 cuesta por carácter; sin tope, un cuerpo enorme es una denegación. */
export const PASSWORD_MAX_LENGTH = 128;

/** Las que aparecen en cualquier lista de las más usadas. */
const COMUNES = [
  'password', 'contrasena', 'contraseña', '123456', '12345678', '123456789',
  'qwerty', 'qwertyuiop', 'abc123', 'iloveyou', 'admin', 'administrador',
  'bienvenido', 'welcome', 'letmein', 'monkey', 'dragon', 'football',
  'colombia', 'bogota', 'medellin',
];

/** Palabras que cualquiera probaría primero contra ESTE sistema. */
const DEL_NEGOCIO = ['tax', 'turistico', 'turístico', 'taxituristico', 'paipa', 'boyaca', 'boyacá', 'taxi'];

export interface PasswordVerdict {
  ok: boolean;
  /** Qué le falta, en segunda persona y en orden de importancia. */
  problemas: string[];
  /** 0 a 4, solo informativo: orienta, no bloquea. */
  fuerza: number;
}

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Trozos del nombre y del correo que no deben aparecer en la contraseña. */
function pedazosPersonales(contexto: { email?: string; name?: string }): string[] {
  const pedazos: string[] = [];

  if (contexto.email) {
    const local = contexto.email.split('@')[0] ?? '';
    pedazos.push(...local.split(/[._-]+/));
  }
  if (contexto.name) {
    pedazos.push(...contexto.name.split(/\s+/));
  }

  return pedazos.map(normalizar).filter((p) => p.length >= 4);
}

/** Tres o más iguales seguidos, o una secuencia del teclado o de dígitos. */
function esDemasiadoSimple(limpia: string): boolean {
  if (/^(.)\1+$/.test(limpia)) return true;

  const secuencias = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl'];
  for (const secuencia of secuencias) {
    for (let i = 0; i + 4 <= secuencia.length; i++) {
      const trozo = secuencia.slice(i, i + 4);
      if (limpia.includes(trozo) || limpia.includes([...trozo].reverse().join(''))) return true;
    }
  }
  return false;
}

export function evaluatePassword(
  password: string,
  contexto: { email?: string; name?: string } = {},
): PasswordVerdict {
  const problemas: string[] = [];
  const limpia = normalizar(password);

  if (password.length < PASSWORD_MIN_LENGTH) {
    problemas.push(`Usa al menos ${PASSWORD_MIN_LENGTH} caracteres.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problemas.push(`No puede pasar de ${PASSWORD_MAX_LENGTH} caracteres.`);
  }
  if (password.trim() !== password) {
    problemas.push('No empieces ni termines con espacios: se pierden al copiarla.');
  }

  if (COMUNES.some((c) => limpia.includes(c))) {
    problemas.push('Contiene una palabra de las que se prueban primero.');
  }
  if (DEL_NEGOCIO.some((p) => limpia.includes(p))) {
    problemas.push('No uses palabras relacionadas con la empresa o la ciudad.');
  }
  if (pedazosPersonales(contexto).some((p) => limpia.includes(p))) {
    problemas.push('No uses tu nombre ni tu correo: es lo primero que se intenta.');
  }
  if (esDemasiadoSimple(limpia)) {
    problemas.push('Evita repeticiones y secuencias del teclado.');
  }

  /*
   * La fuerza premia la longitud por encima de la variedad, que es el orden
   * correcto: cada carácter extra multiplica el espacio de búsqueda mucho
   * más que añadir un signo de admiración al final.
   */
  const variedad =
    (/[a-z]/.test(password) ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/\d/.test(password) ? 1 : 0) +
    (/[^a-zA-Z0-9]/.test(password) ? 1 : 0);

  let fuerza = 0;
  if (password.length >= PASSWORD_MIN_LENGTH) fuerza = 1;
  if (password.length >= 16) fuerza = 2;
  if (password.length >= 20) fuerza = 3;
  if (password.length >= 24) fuerza = 4;
  if (fuerza > 0 && variedad >= 3) fuerza = Math.min(4, fuerza + 1);
  if (problemas.length > 0) fuerza = Math.min(fuerza, 1);

  return { ok: problemas.length === 0, problemas, fuerza };
}

export const PASSWORD_STRENGTH_LABEL = [
  'Muy débil',
  'Débil',
  'Aceptable',
  'Buena',
  'Excelente',
] as const;
