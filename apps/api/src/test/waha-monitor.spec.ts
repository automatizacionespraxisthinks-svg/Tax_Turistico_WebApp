import { describe, expect, it } from 'vitest';
import {
  decidir,
  telefonoDeWaha,
  traducirEstado,
  type Consulta,
  type LineaGuardada,
} from '../modules/integrations/waha-monitor';

/**
 * Cuándo una línea de WhatsApp se da por caída, y cuándo no.
 *
 * Lo difícil no es detectar una caída, sino no inventarla: un reinicio de
 * WAHA dura segundos y pasa por STARTING, y si coincide con la revisión WAHA
 * no contesta. Alertar a la primera generaría una caída y una vuelta cada vez
 * que alguien reinicia WAHA, y a la tercera falsa alarma nadie mira la de
 * verdad. Estas pruebas fijan las dos mitades: que lo real salte en el acto,
 * y que lo pasajero no salte nunca.
 */

const T0 = new Date('2026-10-25T10:00:00Z');
const T1 = new Date('2026-10-25T10:01:00Z');
const T2 = new Date('2026-10-25T10:02:00Z');

const conectada = (id = 'linea-1', phone: string | null = '+573001110000'): LineaGuardada => ({
  id,
  label: id,
  phone,
  status: 'working',
  connected: true,
  statusSince: T0,
});

const waha = (...sesiones: { name: string; status: string; phone?: string | null }[]): Consulta => ({
  ok: true,
  sesiones: sesiones.map((s) => ({
    name: s.name,
    status: traducirEstado(s.status),
    phone: s.phone ?? null,
  })),
});
const wahaMudo: Consulta = { ok: false, error: 'ECONNREFUSED' };

/** Encadena revisiones como haría el monitor minuto a minuto. */
function revisiones(inicial: LineaGuardada[], ...consultas: Consulta[]) {
  let filas = inicial;
  const todos: ReturnType<typeof decidir>['cambios'] = [];
  consultas.forEach((consulta, i) => {
    const r = decidir(filas, consulta, new Date(T1.getTime() + i * 60_000));
    filas = r.filas;
    todos.push(...r.cambios);
  });
  return { filas, cambios: todos };
}

describe('el monitor de líneas', () => {
  describe('lo que tiene que saltar en el acto', () => {
    it.each([
      ['FAILED', 'failed'],
      ['STOPPED', 'stopped'],
      ['SCAN_QR_CODE', 'scan_qr'],
    ])('una línea conectada que pasa a %s se da por caída', (estado, esperado) => {
      const { cambios, filas } = decidir([conectada()], waha({ name: 'linea-1', status: estado }), T1);
      expect(cambios).toEqual([
        expect.objectContaining({ id: 'linea-1', tipo: 'caida', status: esperado }),
      ]);
      expect(filas[0]!.connected).toBe(false);
    });

    it('una línea que desaparece de WAHA se da por caída', () => {
      const { cambios } = decidir([conectada()], waha(), T1);
      expect(cambios).toEqual([expect.objectContaining({ tipo: 'caida', status: 'missing' })]);
    });

    it('un estado que no conocemos cuenta como caída, no como verde', () => {
      expect(traducirEstado('ALGO_NUEVO_DE_WAHA')).toBe('failed');
      const { cambios } = decidir([conectada()], waha({ name: 'linea-1', status: 'ALGO_NUEVO' }), T1);
      expect(cambios).toHaveLength(1);
    });

    it('una línea caída que vuelve a WORKING se da por recuperada', () => {
      const caida = { ...conectada(), status: 'failed' as const, connected: false };
      const { cambios } = decidir([caida], waha({ name: 'linea-1', status: 'WORKING' }), T1);
      expect(cambios).toEqual([expect.objectContaining({ tipo: 'recuperada', status: 'working' })]);
    });
  });

  describe('lo que no tiene que saltar', () => {
    it('un reinicio de WAHA (STARTING una vez y vuelta) no alerta nada', () => {
      const { cambios, filas } = revisiones(
        [conectada()],
        waha({ name: 'linea-1', status: 'STARTING' }),
        waha({ name: 'linea-1', status: 'WORKING' }),
      );
      expect(cambios).toEqual([]);
      expect(filas[0]!.connected).toBe(true);
    });

    it('WAHA sin contestar una sola vez no tumba ninguna línea', () => {
      const { cambios } = revisiones(
        [conectada('a'), conectada('b', '+573002220000')],
        wahaMudo,
        waha({ name: 'a', status: 'WORKING' }, { name: 'b', status: 'WORKING' }),
      );
      expect(cambios).toEqual([]);
    });

    it('una línea nueva no alerta, aunque nazca pidiendo el QR', () => {
      const { cambios, filas } = decidir([], waha({ name: 'nueva', status: 'SCAN_QR_CODE' }), T1);
      expect(cambios).toEqual([]);
      expect(filas[0]).toMatchObject({ id: 'nueva', status: 'scan_qr', connected: false });
    });

    it('una línea ya caída que cambia de motivo no vuelve a alertar', () => {
      const { cambios } = revisiones(
        [conectada()],
        waha({ name: 'linea-1', status: 'FAILED' }),
        waha({ name: 'linea-1', status: 'SCAN_QR_CODE' }),
        waha({ name: 'linea-1', status: 'STOPPED' }),
      );
      expect(cambios.map((c) => c.tipo)).toEqual(['caida']);
    });
  });

  describe('lo dudoso, a la segunda', () => {
    it('STARTING dos revisiones seguidas ya no es un reinicio: caída', () => {
      const { cambios } = revisiones(
        [conectada()],
        waha({ name: 'linea-1', status: 'STARTING' }),
        waha({ name: 'linea-1', status: 'STARTING' }),
      );
      expect(cambios).toEqual([expect.objectContaining({ tipo: 'caida', status: 'starting' })]);
    });

    it('WAHA sin contestar dos veces seguidas: caen todas las que estaban arriba', () => {
      const { cambios } = revisiones(
        [conectada('a'), conectada('b', '+573002220000')],
        wahaMudo,
        wahaMudo,
      );
      expect(cambios.map((c) => [c.id, c.tipo, c.status])).toEqual([
        ['a', 'caida', 'no_response'],
        ['b', 'caida', 'no_response'],
      ]);
    });
  });

  describe('lo que se guarda', () => {
    it('«desde cuándo» solo se mueve cuando cambia el estado de verdad', () => {
      const primera = decidir([conectada()], waha({ name: 'linea-1', status: 'WORKING' }), T1);
      expect(primera.filas[0]!.statusSince).toEqual(T0);

      const caida = decidir(primera.filas, waha({ name: 'linea-1', status: 'FAILED' }), T2);
      expect(caida.filas[0]!.statusSince).toEqual(T2);
    });

    it('sin WAHA respondiendo se conserva el teléfono que ya se sabía', () => {
      const { filas } = decidir([conectada()], wahaMudo, T1);
      expect(filas[0]!.phone).toBe('+573001110000');
    });

    it('una sesión recreada con el mismo número se queda el número, no la vieja', () => {
      // La vieja ya no está en WAHA; la nueva tiene su número. Si las dos lo
      // conservaran, el índice único tumbaría la revisión entera.
      const { filas } = decidir(
        [conectada('vieja', '+573001110000')],
        waha({ name: 'nueva', status: 'WORKING', phone: '+573001110000' }),
        T1,
      );
      const porId = Object.fromEntries(filas.map((f) => [f.id, f.phone]));
      expect(porId).toEqual({ nueva: '+573001110000', vieja: null });
    });

    it('el número sale del identificador de WhatsApp', () => {
      expect(telefonoDeWaha('573001234567@c.us')).toBe('+573001234567');
      expect(telefonoDeWaha(undefined)).toBeNull();
      expect(telefonoDeWaha('')).toBeNull();
    });
  });
});
