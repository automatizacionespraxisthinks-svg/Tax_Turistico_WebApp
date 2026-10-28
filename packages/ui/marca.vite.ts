import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Colores de marca para la configuración de Vite.
 *
 * El `theme-color` del HTML y los colores del manifiesto de la PWA no pueden
 * leer variables CSS, pero tampoco deben repetir un hexadecimal: los colores
 * solo viven en `tokens.css` (HU-UI-01). Así que se leen de ahí al compilar.
 *
 * Va fuera de `src` porque usa Node: solo lo cargan los `vite.config.ts`.
 */

const TOKENS = fileURLToPath(new URL('./src/styles/tokens.css', import.meta.url));

/** El valor hexadecimal de un color de la paleta, p. ej. `colorDeMarca('--ink')`. */
export function colorDeMarca(nombre: string): string {
  const css = readFileSync(TOKENS, 'utf8');
  const hallado = new RegExp(`${nombre}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(css);
  if (!hallado) throw new Error(`No encuentro el color ${nombre} en tokens.css`);
  return hallado[1]!;
}

/** Plugin que cambia `%COLOR_TEMA%` del `index.html` por ese color. */
export function colorDeTema(nombre: string) {
  return {
    name: 'color-de-tema',
    transformIndexHtml: (html: string) => html.replaceAll('%COLOR_TEMA%', colorDeMarca(nombre)),
  };
}
