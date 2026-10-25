import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ConflictException, Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { formatRelative, type ServiceCheck, type SystemChecks } from '@tax/shared';
import { DB, type Database } from './db/db.module';
import { REDIS } from './redis/redis.module';
import { loadEnv } from './config/env';
import { SessionGuard } from './modules/identity/guards';
import { WahaMonitorService } from './modules/integrations/waha-monitor.service';

/** Más que esto sin respuesta y el servicio cuenta como caído. */
const TIEMPO_LIMITE_MS = 3_000;
/** Un evento que lleva más que esto sin entregarse ya no es un reintento suelto. */
const ATASCO_OUTBOX_MS = 5 * 60_000;
/** El monitor revisa cada minuto; tres sin revisar es que se paró. */
const MONITOR_PARADO_MS = 3 * 60_000;
/** Rotación trimestral de la clave de la integración (§8.2). */
const ROTACION_CLAVE_DIAS = 90;

/**
 * Comprobaciones de la página de estado (§10.4), solo para la oficina.
 *
 * Va aparte de `/status` porque aquel es público —lo golpea el monitor
 * externo— y esto dice versiones, nombres de bases y de claves, que no
 * tienen por qué estar a la vista de cualquiera.
 *
 * Cada consulta comprueba de verdad: nada sale de una caché ni de un texto
 * fijo. Una comprobación que falla no tumba a las demás: se marca con fallo
 * y las otras siguen.
 */
@Controller('v1/admin/system')
@UseGuards(SessionGuard)
export class SystemController {
  private readonly env = loadEnv();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly monitor: WahaMonitorService,
  ) {}

  @Get()
  async checks(): Promise<SystemChecks> {
    const services = await Promise.all([
      this.postgres(),
      this.redisCheck(),
      this.n8n(),
      this.whatsapp(),
      this.claveDeApi(),
    ]);

    const memoria = process.memoryUsage();
    const limite = limiteDeMemoria();
    return {
      checkedAt: new Date().toISOString(),
      services,
      memory: {
        rssMb: Math.round(memoria.rss / 1024 / 1024),
        heapMb: Math.round(memoria.heapUsed / 1024 / 1024),
        limitMb: limite === null ? null : Math.round(limite / 1024 / 1024),
      },
    };
  }

  /** Revisa las líneas ya, sin esperar al minuto. Es el «Actualizar» del panel. */
  @Post('whatsapp/revisar')
  @HttpCode(200)
  async revisarLineas() {
    if (!this.monitor.configurado) {
      throw new ConflictException('Falta WAHA_URL en la API: el monitor de líneas está apagado');
    }
    return this.monitor.revisar();
  }

  /* ---------------------------------------------------------- servicios */

  private async postgres(): Promise<ServiceCheck> {
    const inicio = performance.now();
    try {
      const resultado = await conTiempo(
        this.db.execute<{ version: string; base: string }>(
          sql`select current_setting('server_version') as version, current_database() as base`,
        ),
      );
      const ms = Math.round(performance.now() - inicio);
      const fila = resultado.rows[0];
      // `18.6 (Debian 18.6-1.pgdg13+1)` → `18.6`
      const version = fila?.version.split(' ')[0] ?? '';
      return {
        id: 'postgres',
        name: `PostgreSQL ${version}`.trim(),
        state: ms > 500 ? 'aviso' : 'ok',
        detail: `base ${fila?.base ?? '?'} · contestó en ${ms} ms${ms > 500 ? ', lenta' : ''}`,
        latencyMs: ms,
      };
    } catch (error) {
      return { id: 'postgres', name: 'PostgreSQL', state: 'fallo', detail: `no contesta: ${motivo(error)}` };
    }
  }

  private async redisCheck(): Promise<ServiceCheck> {
    const base = new URL(this.env.REDIS_URL).pathname.slice(1) || '0';
    const inicio = performance.now();
    try {
      // Con la conexión caída, ioredis encola el comando y espera para
      // siempre: sin tiempo límite, esta página se colgaría justo cuando
      // más falta hace.
      await conTiempo(this.redis.ping());
      const ms = Math.round(performance.now() - inicio);
      const info = await conTiempo(this.redis.info('server'));
      const version = /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? '';
      return {
        id: 'redis',
        name: `Redis ${version}`.trim(),
        state: ms > 200 ? 'aviso' : 'ok',
        detail: `base ${base}, prefijo ${this.env.REDIS_PREFIX} · contestó en ${ms} ms`,
        latencyMs: ms,
      };
    } catch (error) {
      return { id: 'redis', name: 'Redis', state: 'fallo', detail: `no contesta: ${motivo(error)}` };
    }
  }

  /**
   * Los webhooks no se pueden probar sin mandar uno, así que se mira lo que
   * de verdad pasa con los que se mandan: si salen, si se atascan, si mueren.
   */
  private async n8n(): Promise<ServiceCheck> {
    const nombre = 'Webhooks de n8n';
    try {
      const resultado = await conTiempo(
        this.db.execute<{
          pendientes: number;
          reintentando: number;
          muertos: number;
          mas_antiguo: Date | null;
          ultimo_entregado: Date | null;
          ultimo_error: string | null;
        }>(sql`
          select
            count(*) filter (where status in ('pending', 'delivering'))::int as pendientes,
            count(*) filter (where status = 'pending' and attempts > 0)::int as reintentando,
            count(*) filter (where status = 'dead')::int as muertos,
            min(created_at) filter (where status in ('pending', 'delivering')) as mas_antiguo,
            max(delivered_at) as ultimo_entregado,
            (select last_error from outbox_events
              where last_error is not null and status <> 'delivered'
              order by created_at desc limit 1) as ultimo_error
          from outbox_events
        `),
      );
      const fila = resultado.rows[0]!;
      const masAntiguo = fila.mas_antiguo ? new Date(fila.mas_antiguo) : null;
      const entregado = fila.ultimo_entregado
        ? `último entregado ${formatRelative(new Date(fila.ultimo_entregado))}`
        : 'ninguno entregado todavía';
      const error = fila.ultimo_error ? ` · último error: ${fila.ultimo_error.slice(0, 120)}` : '';

      if (!this.env.N8N_WEBHOOK_URL || !this.env.N8N_WEBHOOK_SECRET) {
        return {
          id: 'n8n',
          name: nombre,
          state: 'apagado',
          detail: `sin N8N_WEBHOOK_URL: no sale ningún evento, ${fila.pendientes} esperando`,
        };
      }
      if (masAntiguo && Date.now() - masAntiguo.getTime() > ATASCO_OUTBOX_MS) {
        return {
          id: 'n8n',
          name: nombre,
          state: 'fallo',
          detail: `${fila.pendientes} sin entregar, el más antiguo de ${formatRelative(masAntiguo)}${error}`,
        };
      }
      if (fila.muertos > 0 || fila.reintentando > 0) {
        const partes = [
          fila.muertos > 0 ? `${fila.muertos} en cola muerta` : null,
          fila.reintentando > 0 ? `${fila.reintentando} reintentando` : null,
        ].filter(Boolean);
        return { id: 'n8n', name: nombre, state: 'aviso', detail: `${partes.join(', ')} · ${entregado}${error}` };
      }
      return { id: 'n8n', name: nombre, state: 'ok', detail: `${entregado}, sin nada en cola` };
    } catch (error) {
      return { id: 'n8n', name: nombre, state: 'fallo', detail: `no se pudo leer la cola: ${motivo(error)}` };
    }
  }

  private async whatsapp(): Promise<ServiceCheck> {
    const nombre = 'WhatsApp (WAHA)';
    if (!this.monitor.configurado) {
      return {
        id: 'whatsapp',
        name: nombre,
        state: 'apagado',
        detail: 'sin WAHA_URL: nadie está revisando las líneas',
      };
    }

    const ultima = this.monitor.ultimaRevision();
    if (!ultima) {
      return { id: 'whatsapp', name: nombre, state: 'aviso', detail: 'aún sin revisar desde que arrancó la API' };
    }
    const cuando = formatRelative(ultima.at);
    if (Date.now() - new Date(ultima.at).getTime() > MONITOR_PARADO_MS) {
      return {
        id: 'whatsapp',
        name: nombre,
        state: 'fallo',
        detail: `la última revisión fue ${cuando}: el monitor no está corriendo`,
      };
    }
    if (!ultima.ok) {
      return { id: 'whatsapp', name: nombre, state: 'fallo', detail: `WAHA no responde: ${ultima.error} · ${cuando}` };
    }
    if (ultima.lineas === 0) {
      return { id: 'whatsapp', name: nombre, state: 'aviso', detail: `WAHA no tiene ninguna sesión · ${cuando}` };
    }
    const conectadas = `${ultima.conectadas} de ${ultima.lineas} ${ultima.lineas === 1 ? 'línea conectada' : 'líneas conectadas'}`;
    return {
      id: 'whatsapp',
      name: nombre,
      state: ultima.conectadas < ultima.lineas ? 'aviso' : 'ok',
      detail: `${conectadas} · revisado ${cuando}`,
    };
  }

  /**
   * La clave con la que n8n crea carreras. Se toma la última usada entre las
   * activas con permiso de escritura: es la que está en el flujo.
   */
  private async claveDeApi(): Promise<ServiceCheck> {
    const nombre = 'Clave de API de la integración';
    try {
      const resultado = await conTiempo(
        this.db.execute<{ name: string; prefix: string; created_at: Date; last_used_at: Date | null }>(sql`
          select name, prefix, created_at, last_used_at
            from api_keys
           where revoked_at is null
             and (expires_at is null or expires_at > now())
             and scopes @> '["rides:write"]'::jsonb
           order by last_used_at desc nulls last, created_at desc
        `),
      );
      const [clave, ...otras] = resultado.rows;
      if (!clave) {
        return {
          id: 'api_key',
          name: nombre,
          state: 'fallo',
          detail: 'no hay ninguna clave activa que pueda crear carreras: n8n no puede crear ninguna',
        };
      }

      const dias = Math.floor((Date.now() - new Date(clave.created_at).getTime()) / 86_400_000);
      const uso = clave.last_used_at ? `último uso ${formatRelative(new Date(clave.last_used_at))}` : 'nunca usada';
      const mas = otras.length > 0 ? ` · y ${otras.length} más activa${otras.length === 1 ? '' : 's'}` : '';
      const detalle = `«${clave.name}» (${clave.prefix}…) · creada hace ${dias} ${dias === 1 ? 'día' : 'días'} · ${uso}${mas}`;

      if (dias > ROTACION_CLAVE_DIAS) {
        return { id: 'api_key', name: nombre, state: 'aviso', detail: `${detalle} · toca rotarla (cada ${ROTACION_CLAVE_DIAS} días)` };
      }
      return { id: 'api_key', name: nombre, state: clave.last_used_at ? 'ok' : 'aviso', detail: detalle };
    } catch (error) {
      return { id: 'api_key', name: nombre, state: 'fallo', detail: `no se pudo leer: ${motivo(error)}` };
    }
  }
}

function conTiempo<T>(promesa: Promise<T>): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  const limite = new Promise<never>((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error(`sin respuesta en ${TIEMPO_LIMITE_MS / 1000} s`)), TIEMPO_LIMITE_MS);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

function motivo(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * El límite de memoria del contenedor, leído del cgroup (v2, y v1 por si
 * acaso). Fuera de un contenedor, o sin límite fijado, no hay: nulo, y el
 * panel lo dice en vez de inventarse uno.
 */
function limiteDeMemoria(): number | null {
  for (const ruta of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const valor = readFileSync(ruta, 'utf8').trim();
      const bytes = Number(valor);
      // «max» en v2, o un número absurdo en v1: los dos quieren decir sin límite.
      return Number.isFinite(bytes) && bytes > 0 && bytes < 2 ** 50 ? bytes : null;
    } catch {
      // Esa ruta no existe aquí; se prueba la siguiente.
    }
  }
  return null;
}
