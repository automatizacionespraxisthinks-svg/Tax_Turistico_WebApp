import { Inject, Injectable, Logger } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { WAHA_STATUS_LABEL, type WahaSessionStatus } from '@tax/shared';
import { DB, type Database } from '../../db/db.module';
import { wahaSessions } from '../../db/schema';
import { loadEnv } from '../../config/env';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { OutboxService } from './outbox.service';
import {
  decidir,
  telefonoDeWaha,
  traducirEstado,
  type Cambio,
  type Consulta,
  type LineaGuardada,
} from './waha-monitor';

export const MONITOR_QUEUE = 'monitor';

/** Por qué se da por caída, dicho para la oficina y no con la palabra de WAHA. */
const MOTIVO_CAIDA: Record<WahaSessionStatus, string> = {
  working: 'conectada',
  starting: 'lleva más de un minuto iniciando',
  scan_qr: 'pide escanear el QR otra vez',
  failed: 'WAHA la reporta como fallida',
  stopped: 'la sesión está detenida en WAHA',
  no_response: 'WAHA no responde',
  missing: 'ya no existe en WAHA',
};
export const REVISAR_LINEAS_JOB = 'revisar-lineas';

/** Lo que el panel necesita saber de la última revisión. */
export interface UltimaRevision {
  at: string;
  /** Si WAHA contestó. Con `false`, `error` dice por qué. */
  ok: boolean;
  error: string | null;
  lineas: number;
  conectadas: number;
  cambios: number;
}

/** Lo que devuelve WAHA en `GET /api/sessions`, solo lo que se usa. */
interface SesionCruda {
  name?: unknown;
  status?: unknown;
  me?: { id?: unknown } | null;
}

/**
 * Vigila las líneas de WhatsApp (§10.4).
 *
 * Cada minuto pregunta a WAHA por sus sesiones, decide qué línea cayó o
 * volvió (`waha-monitor.ts`) y, solo cuando algo cambia de verdad, avisa a
 * la oficina con una alerta sonora y deja un evento para n8n, por si el
 * equipo técnico quiere enterarse por otro canal.
 *
 * Sin `WAHA_URL` no hace nada, y el panel lo dice así en vez de pintar las
 * líneas en verde.
 */
@Injectable()
export class WahaMonitorService {
  private readonly logger = new Logger(WahaMonitorService.name);
  private readonly env = loadEnv();

  private ultima: UltimaRevision | null = null;
  private enCurso: Promise<UltimaRevision> | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeGateway,
  ) {}

  get configurado(): boolean {
    return Boolean(this.env.WAHA_URL);
  }

  /** Nula hasta la primera revisión desde que arrancó la API. */
  ultimaRevision(): UltimaRevision | null {
    return this.ultima;
  }

  /**
   * Revisa ahora. Si ya hay una revisión en marcha —la del minuto y el botón
   * del panel a la vez— se espera a esa en vez de lanzar otra: dos a la vez
   * leerían el mismo estado previo y alertarían dos veces de la misma caída.
   */
  revisar(): Promise<UltimaRevision> {
    if (!this.configurado) throw new Error('WAHA_URL no está configurada');
    this.enCurso ??= this.hacerRevision().finally(() => {
      this.enCurso = null;
    });
    return this.enCurso;
  }

  private async hacerRevision(): Promise<UltimaRevision> {
    const ahora = new Date();
    const consulta = await this.consultarWaha();

    const previas: LineaGuardada[] = (await this.db.select().from(wahaSessions)).map((fila) => ({
      id: fila.id,
      label: fila.label,
      phone: fila.phone,
      status: fila.status as WahaSessionStatus,
      connected: fila.connected,
      statusSince: fila.statusSince,
    }));

    const { filas, cambios } = decidir(previas, consulta, ahora);
    const eventIds: string[] = [];

    if (filas.length > 0) {
      await this.db.transaction(async (tx) => {
        /*
         * El teléfono es único. Si un número pasa de una línea a otra, al
         * escribirlas una a una habría un instante con el número repetido y
         * la base rechazaría la revisión entera. Se sueltan primero los que
         * cambian de dueño y luego se escribe todo.
         */
        const porId = new Map(previas.map((linea) => [linea.id, linea]));
        const sueltan = filas
          .filter((fila) => porId.has(fila.id) && porId.get(fila.id)!.phone !== fila.phone)
          .map((fila) => fila.id);
        if (sueltan.length > 0) {
          await tx.update(wahaSessions).set({ phone: null }).where(inArray(wahaSessions.id, sueltan));
        }

        for (const fila of filas) {
          const valores = {
            phone: fila.phone,
            status: fila.status,
            connected: fila.connected,
            statusSince: fila.statusSince,
            lastCheckAt: ahora,
          };
          await tx
            .insert(wahaSessions)
            .values({ id: fila.id, label: fila.label, ...valores })
            // La etiqueta no se toca: si alguien la cambia en la base, se respeta.
            .onConflictDoUpdate({ target: wahaSessions.id, set: valores });
        }

        for (const cambio of cambios) {
          eventIds.push(
            await this.outbox.enqueue(tx, {
              type: cambio.tipo === 'caida' ? 'waha.line_down' : 'waha.line_up',
              payload: {
                lineId: cambio.id,
                label: cambio.label,
                phone: cambio.phone,
                status: cambio.status,
                statusLabel: WAHA_STATUS_LABEL[cambio.status],
                message: this.mensaje(cambio, consulta),
              },
            }),
          );
        }
      });
    }

    // Fuera de la transacción, igual que el resto del outbox: si se avisara
    // dentro, n8n o el panel podrían enterarse de algo que luego no se guardó.
    if (eventIds.length > 0) await this.outbox.notify(eventIds);
    for (const cambio of cambios) {
      this.realtime.alertOffice({
        kind: cambio.tipo === 'caida' ? 'line_down' : 'line_up',
        lineId: cambio.id,
        message: this.mensaje(cambio, consulta),
      });
      const registro = { linea: cambio.id, estado: cambio.status };
      if (cambio.tipo === 'caida') this.logger.warn(registro, 'Línea de WhatsApp caída');
      else this.logger.log(registro, 'Línea de WhatsApp recuperada');
    }

    if (!consulta.ok) this.logger.warn({ err: consulta.error }, 'WAHA no contesta');

    this.ultima = {
      at: ahora.toISOString(),
      ok: consulta.ok,
      error: consulta.ok ? null : consulta.error,
      lineas: filas.length,
      conectadas: filas.filter((fila) => fila.connected).length,
      cambios: cambios.length,
    };
    return this.ultima;
  }

  /** Lo que se lee en el panel y llega a n8n, en una frase. */
  private mensaje(cambio: Cambio, consulta: Consulta): string {
    const linea = cambio.phone ? `«${cambio.label}» (${cambio.phone})` : `«${cambio.label}»`;
    if (cambio.tipo === 'recuperada') return `La línea ${linea} volvió a funcionar`;
    const motivo = consulta.ok ? MOTIVO_CAIDA[cambio.status] : `WAHA no responde (${consulta.error})`;
    return `Se cayó la línea ${linea}: ${motivo}`;
  }

  /**
   * El código QR de una línea que pide vincularse, para escanearlo desde el
   * panel sin entrar a WAHA. WAHA solo lo da mientras la sesión está en
   * SCAN_QR_CODE, y cambia cada pocos segundos: se pide justo al abrirlo.
   */
  async codigoQr(linea: string): Promise<{ ok: true; imagen: string } | { ok: false; error: string }> {
    if (!this.configurado) return { ok: false, error: 'Falta WAHA_URL en la API' };
    const url = new URL(`/api/${encodeURIComponent(linea)}/auth/qr?format=image`, this.env.WAHA_URL);
    try {
      const respuesta = await fetch(url, { headers: this.cabeceras(), signal: AbortSignal.timeout(8_000) });
      if (!respuesta.ok) {
        const detalle = await respuesta.text().catch(() => '');
        const mensaje = /"message"\s*:\s*"([^"]+)"/.exec(detalle)?.[1];
        return { ok: false, error: mensaje ?? `WAHA contestó HTTP ${respuesta.status}` };
      }
      // Según la versión, WAHA lo manda como imagen o como JSON con base64.
      const tipo = respuesta.headers.get('content-type') ?? '';
      if (tipo.startsWith('image/')) {
        const base64 = Buffer.from(await respuesta.arrayBuffer()).toString('base64');
        return { ok: true, imagen: `data:${tipo.split(';')[0]};base64,${base64}` };
      }
      const cuerpo = (await respuesta.json()) as { mimetype?: string; data?: string };
      if (!cuerpo.data) return { ok: false, error: 'WAHA no devolvió la imagen' };
      return { ok: true, imagen: `data:${cuerpo.mimetype ?? 'image/png'};base64,${cuerpo.data}` };
    } catch (error) {
      return { ok: false, error: describirFallo(error) };
    }
  }

  private cabeceras(): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.env.WAHA_API_KEY) headers['x-api-key'] = this.env.WAHA_API_KEY;
    return headers;
  }

  private async consultarWaha(): Promise<Consulta> {
    const url = new URL('/api/sessions?all=true', this.env.WAHA_URL);
    const headers = this.cabeceras();

    try {
      // Corto a propósito: un WAHA colgado es un WAHA que no atiende.
      const respuesta = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
      if (respuesta.status === 401 || respuesta.status === 403) {
        return { ok: false, error: `rechazó la clave (HTTP ${respuesta.status}); revisa WAHA_API_KEY` };
      }
      if (!respuesta.ok) return { ok: false, error: `HTTP ${respuesta.status}` };

      const cuerpo = (await respuesta.json()) as unknown;
      if (!Array.isArray(cuerpo)) return { ok: false, error: 'respuesta inesperada de WAHA' };

      const sesiones = (cuerpo as SesionCruda[])
        .filter((sesion) => typeof sesion.name === 'string' && sesion.name)
        .map((sesion) => ({
          name: sesion.name as string,
          status: traducirEstado(String(sesion.status ?? '')),
          phone: telefonoDeWaha(typeof sesion.me?.id === 'string' ? sesion.me.id : null),
        }));
      return { ok: true, sesiones };
    } catch (error) {
      return { ok: false, error: describirFallo(error) };
    }
  }
}

/**
 * Por qué no se pudo hablar con WAHA, en palabras. `fetch` dice solo «fetch
 * failed», y con la conexión rechazada la causa llega sin mensaje: lo útil
 * está en el código del error.
 */
function describirFallo(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'TimeoutError') return 'no contestó a tiempo';
  const causa = error.cause as (Error & { code?: string }) | undefined;
  switch (causa?.code) {
    case 'ECONNREFUSED':
      return 'conexión rechazada: WAHA está apagado o WAHA_URL apunta a otro puerto';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'no se encuentra el servidor de WAHA_URL';
    case 'ECONNRESET':
      return 'WAHA cortó la conexión';
    default:
      return causa?.code ?? (causa?.message || error.message);
  }
}
