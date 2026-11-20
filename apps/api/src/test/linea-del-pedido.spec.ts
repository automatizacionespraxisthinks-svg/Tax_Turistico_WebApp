import { describe, expect, it } from 'vitest';
import { Logger } from '@nestjs/common';
import { RidesService } from '../modules/rides/rides.service';

/**
 * La línea de WhatsApp de cada carrera (20/11/2026). Antes la API no la
 * recibía ni la guardaba: Reportes no tenía líneas que filtrar y la ficha
 * de la carrera decía «—». n8n puede mandar el nombre de la sesión de WAHA,
 * el número o el nombre del panel; los tres tienen que dar la misma línea.
 */
const LINEAS = [
  { id: 'default', label: '3112575699', phone: '573112575699' },
  { id: 'linea2', label: '3185555550', phone: '573185555550' },
  { id: 'pruebas', label: 'Pruebas', phone: '573000000000' },
];

function servicio(lineas: unknown[] | Error = LINEAS) {
  const s = Object.create(RidesService.prototype) as Record<string, unknown>;
  s.logger = new Logger('prueba');
  s.db = {
    select: () => ({
      from: async () => {
        if (lineas instanceof Error) throw lineas;
        return lineas;
      },
    }),
  };
  return (dicha?: string) =>
    (s as unknown as { lineaRegistrada(d?: string): Promise<string | null> }).lineaRegistrada(dicha);
}

describe('la línea del pedido', () => {
  const linea = servicio();

  it('por el nombre de la sesión de WAHA', async () => {
    expect(await linea('linea2')).toBe('3185555550');
  });

  it('por el número, con o sin +57 y con espacios', async () => {
    expect(await linea('+57 311 257 5699')).toBe('3112575699');
    expect(await linea('3185555550')).toBe('3185555550');
    expect(await linea('573000000000')).toBe('Pruebas');
  });

  it('por el nombre del panel, sin importar mayúsculas', async () => {
    expect(await linea('pruebas')).toBe('Pruebas');
  });

  it('una que no está registrada se guarda tal cual', async () => {
    expect(await linea('Línea nueva')).toBe('Línea nueva');
  });

  it('sin línea, nada', async () => {
    expect(await linea(undefined)).toBeNull();
  });

  it('si la base no responde, se guarda tal cual en vez de fallar', async () => {
    expect(await servicio(new Error('ECONNREFUSED'))('3112575699')).toBe('3112575699');
  });
});
