import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  FilaConductorInforme,
  FiltrosDeInforme,
  OpcionesDeInforme,
  TableroInforme,
} from '@tax/shared';
import { diasDelRango } from '@tax/shared';
import { DB, type Database } from '../../db/db.module';
import type { ExportParams } from '../../db/schema';
import { condicionesDelPeriodo, leerPeriodo, resumir, type Periodo, type Resumen } from './exports.data';
import { enPalabras } from './informes.texto';

/** Los filtros del tablero, como los entiende la lectura de carreras. */
export function paramsDeFiltros(f: FiltrosDeInforme): ExportParams {
  return {
    desde: f.desde,
    hasta: f.hasta,
    zoneIds: f.zonas?.length ? f.zonas : undefined,
    zoneKind: f.tipoZona,
    driverId: f.conductor,
    lines: f.lineas?.length ? f.lineas : undefined,
    excludeTests: f.sinPruebas,
  };
}

/** Y al revés: lo que guarda una exportación, de vuelta a filtros del tablero. */
export function filtrosDeParams(p: ExportParams): FiltrosDeInforme {
  return {
    desde: p.desde!,
    hasta: p.hasta!,
    zonas: p.zoneIds,
    tipoZona: p.zoneKind,
    conductor: p.driverId,
    lineas: p.lines,
    sinPruebas: p.excludeTests ?? false,
  };
}

const DIAS_DE_SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

/** Con menos de un cuarto de hora de turno, «carreras por hora» es ruido. */
const HORAS_MINIMAS_PARA_RITMO = 0.25;

const tasa = (parte: number, total: number) => (total > 0 ? parte / total : null);

/**
 * Reportes.
 *
 * CQRS ligero (§5): consultas de lectura que no pasan por los servicios de
 * los otros módulos. El tablero se cuenta con las mismas filas y la misma
 * función que el Excel y el PDF: si la pantalla dijera una cosa y el archivo
 * otra, nadie se fiaría de ninguno.
 *
 * Las horas y los días son los de Paipa. La base corre en UTC, y agrupar
 * por la hora UTC ponía las carreras de las 8 de la mañana en las 13: el pico
 * del día salía cinco horas corrido.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Lo que se puede elegir en cada filtro. */
  async opciones(): Promise<OpcionesDeInforme> {
    const [zonas, conductores, lineas] = await Promise.all([
      this.db.execute<{ id: string; nombre: string; tipo: 'urbano' | 'rural' }>(sql`
        select id, name as nombre, kind::text as tipo from zones where active order by kind, name
      `),
      this.db.execute<{ id: string; codigo: string; nombre: string; es_prueba: boolean; activo: boolean }>(sql`
        select id, code as codigo, name as nombre, es_prueba, active as activo
          from drivers
         order by length(code), code
      `),
      // Las que han tenido carreras: una línea que nunca recibió un pedido no
      // tiene nada que filtrar.
      this.db.execute<{ linea: string }>(sql`
        select distinct line as linea from rides where line is not null order by 1
      `),
    ]);
    return {
      zonas: zonas.rows,
      conductores: conductores.rows.map((c) => ({
        id: c.id,
        codigo: c.codigo,
        nombre: c.nombre,
        esPrueba: c.es_prueba,
        activo: c.activo,
      })),
      lineas: lineas.rows.map((l) => l.linea),
    };
  }

  async tablero(f: FiltrosDeInforme): Promise<TableroInforme> {
    return (await this.tableroConPeriodo(f)).tablero;
  }

  /**
   * El tablero y las filas de las que salió. La exportación aprovecha las
   * filas para la hoja de carreras, sin volver a leerlas.
   */
  async tableroConPeriodo(f: FiltrosDeInforme): Promise<{ tablero: TableroInforme; periodo: Periodo }> {
    const params = paramsDeFiltros(f);
    // Los conductores siempre se comparan contra todos: con uno elegido, la
    // tabla sigue mostrando al resto para ver dónde queda él.
    const paramsDelGrupo: ExportParams = { ...params, driverId: undefined };

    const [periodo, periodoDelGrupo] = await Promise.all([
      leerPeriodo(this.db, params),
      f.conductor ? leerPeriodo(this.db, paramsDelGrupo) : Promise.resolve(null),
    ]);
    const r = resumir(periodo.filas, periodo.dias);
    const grupo = periodoDelGrupo ? resumir(periodoDelGrupo.filas, periodoDelGrupo.dias) : r;

    const conductores = await this.filasDeConductores(paramsDelGrupo, periodo, grupo);
    const individual = f.conductor ? await this.individual(f.conductor, periodo, conductores, grupo) : null;

    const tablero: TableroInforme = {
      periodo: { desde: f.desde, hasta: f.hasta, dias: diasDelRango(f.desde, f.hasta) },
      recortado: periodo.recortado || Boolean(periodoDelGrupo?.recortado),
      enPalabras: enPalabras(
        r,
        f,
        individual
          ? {
              nombre: individual.fila.nombre,
              codigo: individual.fila.codigo,
              ofertas: individual.fila.ofertas,
              tasaAceptacion: individual.fila.tasaAceptacion,
              grupo: { tasaAceptacion: individual.grupo.tasaAceptacion, llegadaP50: individual.grupo.llegadaP50 },
            }
          : undefined,
      ),
      cifras: {
        creadas: r.creadas,
        finalizadas: r.finalizadas,
        canceladas: r.canceladas,
        sinAsignar: r.sinAsignar,
        enCurso: r.enCurso,
        tasaCancelacion: tasa(r.canceladas, r.creadas),
        asignacionP50: r.asignacionP50,
        asignacionP95: r.asignacionP95,
        llegadaP50: r.llegadaP50,
        llegadaP95: r.llegadaP95,
        duracionP50: r.duracionP50,
        kmRecorridos: r.kmRecorridos,
        sinIntervencion: r.sinIntervencion,
        horaPico: r.horaPico,
        conductores: r.porConductor.length,
      },
      porDia: r.porDia.map((d) => ({
        dia: d.dia,
        carreras: d.carreras,
        finalizadas: d.finalizadas,
        canceladas: d.canceladas,
        sinAsignar: d.sinAsignar,
        abiertas: d.abiertas,
        asignacionP50: d.p50,
        asignacionP95: d.p95,
        llegadaP50: d.llegadaP50,
        sinIntervencion: d.sinIntervencion,
      })),
      porHora: r.porHora.map((h) => ({ hora: h.hora, urbano: h.urbano, rural: h.rural, total: h.carreras })),
      calor: { dias: DIAS_DE_SEMANA, valores: r.calor },
      porZona: r.porZona,
      porLinea: r.porLinea,
      cancelaciones: r.cancelaciones,
      conductores,
      individual,
    };
    return { tablero, periodo };
  }

  /**
   * Una fila por conductor: lo que hizo con las carreras, cómo respondió a
   * las ofertas y cuántas horas tuvo el turno abierto.
   *
   * Las ofertas se cuentan sobre las mismas carreras del tablero; los turnos
   * no saben de zonas ni de líneas, así que son las horas del periodo, sin más.
   */
  private async filasDeConductores(
    params: ExportParams,
    limites: { desde: Date; hasta: Date },
    grupo: Resumen,
  ): Promise<FilaConductorInforme[]> {
    const condicionesDeOfertas = condicionesDelPeriodo(params, limites, { deOfertas: true });
    if (params.excludeTests) condicionesDeOfertas.push(sql`not od.es_prueba`);
    const desde = limites.desde.toISOString();
    const hasta = limites.hasta.toISOString();

    const [ofertas, turnos] = await Promise.all([
      this.db.execute<{ id: string; ofertas: number; aceptadas: number; rechazadas: number; vencidas: number }>(sql`
        select o.driver_id as id,
               count(*)::int as ofertas,
               count(*) filter (where o.response = 'accepted')::int as aceptadas,
               count(*) filter (where o.response = 'rejected')::int as rechazadas,
               count(*) filter (
                 where o.response = 'expired' or (o.response = 'pending' and o.expires_at < now())
               )::int as vencidas
          from ride_offers o
          join rides r on r.id = o.ride_id
          join drivers od on od.id = o.driver_id
          left join zones z on z.id = r.zone_id
          left join customers c on c.id = r.customer_id
         where ${sql.join(condicionesDeOfertas, sql` and `)}
         group by o.driver_id
      `),
      this.db.execute<{ id: string; horas: number }>(sql`
        select s.driver_id as id,
               sum(extract(epoch from
                 least(coalesce(s.ended_at, now()), ${hasta}::timestamptz)
                 - greatest(s.started_at, ${desde}::timestamptz)
               ))::float / 3600 as horas
          from driver_shifts s
          join drivers sd on sd.id = s.driver_id
         where s.started_at < ${hasta}::timestamptz
           and coalesce(s.ended_at, now()) > ${desde}::timestamptz
           ${params.excludeTests ? sql`and not sd.es_prueba` : sql``}
         group by s.driver_id
      `),
    ]);

    const porId = new Map(grupo.porConductor.map((c) => [c.id, c]));
    const ofertasPorId = new Map(ofertas.rows.map((o) => [o.id, o]));
    const horasPorId = new Map(turnos.rows.map((t) => [t.id, Math.max(0, Number(t.horas))]));
    const ids = [...new Set([...porId.keys(), ...ofertasPorId.keys(), ...horasPorId.keys()])];
    if (ids.length === 0) return [];

    const conductores = await this.db.execute<{ id: string; codigo: string; nombre: string; es_prueba: boolean }>(sql`
      select id, code as codigo, name as nombre, es_prueba
        from drivers
       where id::text in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    `);

    return conductores.rows
      .map((d): FilaConductorInforme => {
        const c = porId.get(d.id);
        const o = ofertasPorId.get(d.id);
        const horas = horasPorId.get(d.id) ?? 0;
        const finalizadas = c?.finalizadas ?? 0;
        const respondidas = (o?.aceptadas ?? 0) + (o?.rechazadas ?? 0) + (o?.vencidas ?? 0);
        return {
          id: d.id,
          codigo: d.codigo,
          nombre: d.nombre,
          esPrueba: d.es_prueba,
          asignadas: c?.asignadas ?? 0,
          finalizadas,
          canceladas: c?.canceladas ?? 0,
          ofertas: o?.ofertas ?? 0,
          aceptadas: o?.aceptadas ?? 0,
          rechazadas: o?.rechazadas ?? 0,
          vencidas: o?.vencidas ?? 0,
          tasaAceptacion: tasa(o?.aceptadas ?? 0, respondidas),
          llegadaP50: c?.llegadaP50 ?? null,
          duracionP50: c?.duracionP50 ?? null,
          km: c?.km ?? 0,
          horasTurno: Math.round(horas * 10) / 10,
          carrerasPorHora: horas >= HORAS_MINIMAS_PARA_RITMO ? Math.round((finalizadas / horas) * 100) / 100 : null,
        };
      })
      .sort(
        (a, b) =>
          b.finalizadas - a.finalizadas ||
          b.asignadas - a.asignadas ||
          b.ofertas - a.ofertas ||
          a.codigo.localeCompare(b.codigo, 'es', { numeric: true }),
      );
  }

  /** El conductor elegido, frente al resto del grupo con los mismos filtros. */
  private async individual(
    conductorId: string,
    limites: { desde: Date; hasta: Date },
    conductores: FilaConductorInforme[],
    grupo: Resumen,
  ): Promise<TableroInforme['individual']> {
    const [placas, datos] = await Promise.all([
      this.db.execute<{ placa: string }>(sql`
        select distinct v.plate as placa
          from driver_shifts s
          join vehicles v on v.id = s.vehicle_id
         where s.driver_id = ${conductorId}::uuid
           and s.started_at < ${limites.hasta.toISOString()}::timestamptz
           and coalesce(s.ended_at, now()) > ${limites.desde.toISOString()}::timestamptz
         order by 1
      `),
      this.db.execute<{ codigo: string; nombre: string; es_prueba: boolean }>(sql`
        select code as codigo, name as nombre, es_prueba from drivers where id = ${conductorId}::uuid
      `),
    ]);
    const d = datos.rows[0];
    if (!d) return null;

    const fila: FilaConductorInforme = conductores.find((c) => c.id === conductorId) ?? {
      id: conductorId,
      codigo: d.codigo,
      nombre: d.nombre,
      esPrueba: d.es_prueba,
      asignadas: 0,
      finalizadas: 0,
      canceladas: 0,
      ofertas: 0,
      aceptadas: 0,
      rechazadas: 0,
      vencidas: 0,
      tasaAceptacion: null,
      llegadaP50: null,
      duracionP50: null,
      km: 0,
      horasTurno: 0,
      carrerasPorHora: null,
    };

    const activos = conductores.filter((c) => c.asignadas > 0);
    const aceptadas = conductores.reduce((s, c) => s + c.aceptadas, 0);
    const respondidas = conductores.reduce((s, c) => s + c.aceptadas + c.rechazadas + c.vencidas, 0);
    const horas = conductores.reduce((s, c) => s + c.horasTurno, 0);

    return {
      fila,
      placas: placas.rows.map((p) => p.placa),
      grupo: {
        conductores: activos.length,
        finalizadasPorConductor: activos.length ? Math.round((grupo.finalizadas / activos.length) * 10) / 10 : null,
        tasaAceptacion: tasa(aceptadas, respondidas),
        llegadaP50: grupo.llegadaP50,
        duracionP50: grupo.duracionP50,
        carrerasPorHora: horas >= HORAS_MINIMAS_PARA_RITMO ? Math.round((grupo.finalizadas / horas) * 100) / 100 : null,
      },
    };
  }
}
