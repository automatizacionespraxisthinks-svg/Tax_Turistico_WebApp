import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';

/**
 * Reportes.
 *
 * CQRS ligero (§5): consultas de lectura que no tocan las tablas de los otros
 * módulos a través de sus servicios, sino vistas pensadas para leer. Los
 * informes pesados no deben frenar la operación, así que agregan en SQL en vez
 * de traerse las filas al proceso.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Carreras por hora, separando urbano de rural (RF-44). */
  async ridesByHour(days = 1) {
    const result = await this.db.execute<{ hour: string; urbano: number; rural: number }>(sql`
      select to_char(date_trunc('hour', r.created_at), 'HH24') as hour,
             count(*) filter (where z.kind = 'urbano')::int as urbano,
             count(*) filter (where z.kind = 'rural')::int  as rural
        from rides r
        left join zones z on z.id = r.zone_id
       where r.created_at >= now() - make_interval(days => ${days})
       group by 1
       order by 1
    `);
    return result.rows;
  }

  /**
   * Tiempos de asignación: mediana y p95 por día.
   * `percentile_cont` lo resuelve PostgreSQL; traerse las filas para
   * calcularlo en Node sería gastar memoria del contenedor sin motivo.
   */
  async assignmentTimes(days = 7) {
    const result = await this.db.execute<{ day: string; p50: number; p95: number }>(sql`
      select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
             percentile_cont(0.5) within group (order by extract(epoch from assigned_at - created_at))::int as p50,
             percentile_cont(0.95) within group (order by extract(epoch from assigned_at - created_at))::int as p95
        from rides
       where assigned_at is not null
         and created_at >= now() - make_interval(days => ${days})
       group by 1
       order by 1
    `);
    return result.rows;
  }

  /** Demanda por zona en el periodo. */
  async demandByZone(days = 7) {
    const result = await this.db.execute<{ zone: string; kind: string; rides: number }>(sql`
      select z.name as zone, z.kind, count(r.id)::int as rides
        from zones z
        left join rides r on r.zone_id = z.id
             and r.created_at >= now() - make_interval(days => ${days})
       group by z.name, z.kind
       order by rides desc
    `);
    return result.rows;
  }

  /**
   * Porcentaje de carreras resueltas sin intervención humana.
   * Se considera intervenida la que tiene algún cambio de estado hecho por un
   * operador (meta inicial 80 %, §10.1).
   */
  async automationRate(days = 7) {
    const result = await this.db.execute<{ day: string; rate: number }>(sql`
      select to_char(date_trunc('day', r.created_at), 'YYYY-MM-DD') as day,
             (count(*) filter (where h.ride_id is null)::numeric / nullif(count(*), 0))::float as rate
        from rides r
        left join lateral (
          select 1 as ride_id
            from ride_status_history h
           where h.ride_id = r.id and h.actor = 'operator'
           limit 1
        ) h on true
       where r.created_at >= now() - make_interval(days => ${days})
       group by 1
       order by 1
    `);
    return result.rows;
  }
}
