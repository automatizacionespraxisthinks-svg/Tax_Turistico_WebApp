import { Controller, Get, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { DB, type Database } from './db/db.module';
import { REDIS } from './redis/redis.module';

/**
 * Salud y métricas (§10.4).
 *
 * Endpoint liviano, sin pila de monitoreo propia: Dokploy recoge los logs, el
 * monitor externo golpea `/health` y el panel pinta su página de estado con
 * `/status`.
 */
@Controller()
export class StatusController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Sonda de vida: barata, sin tocar la base. */
  @Get('health')
  health() {
    return { ok: true, uptimeSeconds: Math.round(process.uptime()) };
  }

  /** Sonda de preparación: comprueba de verdad las dependencias. */
  @Get('ready')
  async ready() {
    const [database, cache] = await Promise.allSettled([
      this.db.execute(sql`select 1`),
      this.redis.ping(),
    ]);

    const ok = database.status === 'fulfilled' && cache.status === 'fulfilled';
    return {
      ok,
      postgres: database.status === 'fulfilled',
      redis: cache.status === 'fulfilled',
    };
  }

  /**
   * Lo que el panel necesita para su página de estado: carreras sin asignar,
   * tiempo a asignación, eventos en cola muerta.
   */
  @Get('status')
  async status() {
    const result = await this.db.execute<{
      unassigned: number;
      active: number;
      dead_events: number;
      p95_assignment: number | null;
    }>(sql`
      select
        (select count(*) from rides where status = 'UNASSIGNED')::int as unassigned,
        (select count(*) from rides
          where status in ('PENDING','NOTIFIED','ASSIGNED','DRIVER_ARRIVED','IN_PROGRESS'))::int as active,
        (select count(*) from outbox_events where status = 'dead')::int as dead_events,
        (select percentile_cont(0.95) within group (order by extract(epoch from assigned_at - created_at))
           from rides
          where assigned_at is not null and created_at >= now() - interval '1 day')::int as p95_assignment
    `);

    const rows = result.rows[0];
    const memory = process.memoryUsage();

    return {
      rides: { unassigned: rows?.unassigned ?? 0, active: rows?.active ?? 0 },
      outbox: { dead: rows?.dead_events ?? 0 },
      slo: { assignmentP95Seconds: rows?.p95_assignment ?? null },
      process: {
        rssMb: Math.round(memory.rss / 1024 / 1024),
        heapMb: Math.round(memory.heapUsed / 1024 / 1024),
        uptimeSeconds: Math.round(process.uptime()),
      },
    };
  }
}
