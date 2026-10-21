import { clsx, type ClassValue } from 'clsx';

/** Une clases condicionales. Sin merge de Tailwind: el orden lo decide quien llama. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
