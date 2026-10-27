import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { leerPeriodo, resumir } from './exports.data';

/**
 * Reportes.
 *
 * CQRS ligero (§5): consultas de lectura que no tocan las tablas de los otros
 * módulos a través de sus servicios, sino vistas pensadas para leer. Los
 * informes pesados no deben frenar la operación, así que agregan en SQL en vez
 * de traerse las filas al proceso.
 *
 * Las horas y los días son los de Paipa. La base corre en UTC, y agrupar
 * por la hora UTC ponía las carreras de las 8 de la mañana en las 13: el pico
 * del día salía cinco horas corrido.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Las cifras de arriba de Reportes. Salen de las mismas filas y la misma
   * cuenta que el Excel y el PDF: si la pantalla dijera una cosa y el archivo
   * otra, nadie se fiaría de ninguno.
   */
  async summary(days = 7) {
    const periodo = await leerPeriodo(this.db, { days });
    const r = resumir(periodo.filas);
    return {
      creadas: r.creadas,
      finalizadas: r.finalizadas,
      canceladas: r.canceladas,
      sinAsignar: r.sinAsignar,
      enCurso: r.enCurso,
      horaPico: r.horaPico,
      asignacionP50: r.asignacionP50,
      llegadaP50: r.llegadaP50,
      duracionP50: r.duracionP50,
      kmRecorridos: r.kmRecorridos,
      sinIntervencion: r.sinIntervencion,
      conductores: r.porConductor.length,
    };
  }

  /** Carreras por hora, separando urbano de rural (RF-44). */
  async ridesByHour(days = 1) {
    const result = await this.db.execute<{ hour: string; urbano: number; rural: number }>(sql`
      select to_char(r.created_at at time zone 'America/Bogota', 'HH24') as hour,
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
      select to_char(created_at at time zone 'America/Bogota', 'YYYY-MM-DD') as day,
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
      select to_char(r.created_at at time zone 'America/Bogota', 'YYYY-MM-DD') as day,
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
