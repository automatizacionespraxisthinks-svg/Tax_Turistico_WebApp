import type { WahaSessionStatus } from '@tax/shared';

/**
 * Lo que decide el monitor de líneas, sin red ni base de datos.
 *
 * Está aparte para poder probar cada transición —caída, recuperación, un
 * reinicio de WAHA, WAHA que no contesta— sin montar un WAHA de verdad.
 */

export interface LineaGuardada {
  id: string;
  label: string;
  phone: string | null;
  status: WahaSessionStatus;
  connected: boolean;
  statusSince: Date | null;
}

export interface SesionWaha {
  name: string;
  status: WahaSessionStatus;
  phone: string | null;
}

export type Consulta = { ok: true; sesiones: SesionWaha[] } | { ok: false; error: string };

export interface Cambio {
  id: string;
  label: string;
  phone: string | null;
  tipo: 'caida' | 'recuperada';
  status: WahaSessionStatus;
}

/** Sin duda posible: la línea no está atendiendo. */
const CAIDA_SEGURA = new Set<WahaSessionStatus>(['failed', 'stopped', 'scan_qr', 'missing']);

/**
 * Pueden durar un instante. Un reinicio de WAHA pasa por `starting` y, si
 * coincide con la revisión, WAHA no contesta. Alertar a la primera
 * generaría una caída y una vuelta cada vez que alguien reinicia WAHA, y a
 * la tercera falsa alarma nadie mira la verdadera.
 */
const CAIDA_DUDOSA = new Set<WahaSessionStatus>(['starting', 'no_response']);

/** Traduce el estado de WAHA. Uno que no conozcamos cuenta como caído. */
export function traducirEstado(estadoWaha: string): WahaSessionStatus {
  switch (estadoWaha) {
    case 'WORKING':
      return 'working';
    case 'STARTING':
      return 'starting';
    case 'SCAN_QR_CODE':
      return 'scan_qr';
    case 'STOPPED':
      return 'stopped';
    case 'FAILED':
      return 'failed';
    default:
      // Mejor una alerta de más que una línea muerta pintada en verde.
      return 'failed';
  }
}

/** `573001234567@c.us` → `+573001234567`. */
export function telefonoDeWaha(id: string | null | undefined): string | null {
  const digitos = id?.split('@')[0]?.replace(/\D/g, '');
  return digitos ? `+${digitos}` : null;
}

export function decidir(
  previas: LineaGuardada[],
  consulta: Consulta,
  ahora: Date,
): { filas: LineaGuardada[]; cambios: Cambio[] } {
  const porId = new Map(previas.map((linea) => [linea.id, linea]));
  const observadas = new Map<string, { status: WahaSessionStatus; phone: string | null }>();

  if (consulta.ok) {
    for (const sesion of consulta.sesiones) {
      observadas.set(sesion.name, { status: sesion.status, phone: sesion.phone });
    }
    // Una línea que conocíamos y WAHA ya no lista: la borraron o se perdió.
    for (const linea of previas) {
      if (!observadas.has(linea.id)) observadas.set(linea.id, { status: 'missing', phone: linea.phone });
    }
  } else {
    // WAHA no contesta: no se sabe nada de ninguna, así que todas quedan
    // en duda. Si a la siguiente sigue igual, ya no es un instante.
    for (const linea of previas) observadas.set(linea.id, { status: 'no_response', phone: linea.phone });
  }

  const filas: LineaGuardada[] = [];
  const cambios: Cambio[] = [];

  for (const [id, observada] of observadas) {
    const previa = porId.get(id);
    const phone = observada.phone ?? previa?.phone ?? null;
    const label = previa?.label ?? id;

    /*
     * La primera vez que se ve una línea se anota tal como está, sin
     * alertar: no es una caída ni una vuelta, es una línea nueva. Si nace
     * pidiendo el QR, el panel lo muestra; no hace falta una alarma.
     */
    if (!previa) {
      filas.push({
        id,
        label,
        phone,
        status: observada.status,
        connected: observada.status === 'working',
        statusSince: ahora,
      });
      continue;
    }

    let connected = previa.connected;
    if (observada.status === 'working') connected = true;
    else if (CAIDA_SEGURA.has(observada.status)) connected = false;
    else if (CAIDA_DUDOSA.has(observada.status) && CAIDA_DUDOSA.has(previa.status)) connected = false;

    const cambia = connected !== previa.connected;
    filas.push({
      id,
      label,
      phone,
      status: observada.status,
      connected,
      statusSince: cambia ? ahora : (previa.statusSince ?? ahora),
    });
    if (cambia) {
      cambios.push({ id, label, phone, tipo: connected ? 'recuperada' : 'caida', status: observada.status });
    }
  }

  return { filas: sinTelefonosRepetidos(filas), cambios };
}

/**
 * El teléfono es único en la tabla. Si una sesión se recrea en WAHA con otro
 * nombre y el mismo número, la vieja queda como `missing` con ese número y
 * la nueva no podría guardarse: la revisión entera fallaría por una línea
 * que ya ni existe. El número se le queda a la que está viva.
 */
function sinTelefonosRepetidos(filas: LineaGuardada[]): LineaGuardada[] {
  const dueño = new Map<string, LineaGuardada>();
  for (const fila of filas) {
    if (!fila.phone) continue;
    const actual = dueño.get(fila.phone);
    if (!actual || (actual.status === 'missing' && fila.status !== 'missing')) dueño.set(fila.phone, fila);
  }
  return filas.map((fila) =>
    fila.phone && dueño.get(fila.phone) !== fila ? { ...fila, phone: null } : fila,
  );
}
