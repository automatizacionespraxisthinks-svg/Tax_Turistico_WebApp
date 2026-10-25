/**
 * Usuario de acceso a la oficina (§8.1).
 *
 * Puede ser un correo o un nombre de usuario corto (`marcela.ruiz`): no todo
 * operador tiene un correo de la empresa, y pedirle uno personal para entrar
 * al panel es darle a la empresa un dato que no necesita. Vive en la columna
 * `users.email`, que por historia se llama así.
 *
 * Panel y API validan con estas mismas funciones: si divergieran, el panel
 * aceptaría un usuario que el servidor rechaza sin explicar por qué.
 */

/** Letras, números, punto, guion y guion bajo; de 3 a 32, sin empezar ni acabar en signo. */
const NOMBRE_DE_USUARIO = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Sin espacios y en minúsculas: `Marcela.Ruiz ` y `marcela.ruiz` son la misma cuenta. */
export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

export function isValidLogin(login: string): boolean {
  const limpio = normalizeLogin(login);
  return CORREO.test(limpio) || NOMBRE_DE_USUARIO.test(limpio);
}

export const LOGIN_HINT =
  'Un correo, o un nombre de usuario de 3 a 32 letras o números (se admiten . - _), sin espacios ni tildes.';

/**
 * Cuánto vale una contraseña que generó otra persona: al crear la cuenta o al
 * reiniciarla. Tres días dan para mandarla por WhatsApp y que el operador
 * entre cuando pueda; más, y una contraseña olvidada en un chat sigue
 * abriendo la puerta.
 */
export const TEMP_PASSWORD_HOURS = 72;
