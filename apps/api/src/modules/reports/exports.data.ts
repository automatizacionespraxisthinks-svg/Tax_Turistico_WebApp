import { sql, type SQL } from 'drizzle-orm';
import { RIDE_STATUS_LABEL, type RideStatus } from '@tax/shared';
import type { Database } from '../../db/db.module';
import type { ExportParams } from '../../db/schema';

/** Paipa. Colombia no cambia de hora en el año, pero mejor no suponerlo. */
export const ZONA_HORARIA = 'America/Bogota';

/** Tope de filas por archivo: más que esto ya no es un Excel que alguien lea. */
const MAX_FILAS = 50_000;

export interface FilaCarrera {
  codigo: string;
  creada: Date;
  estado: RideStatus;
  estadoTexto: string;
  zona: string | null;
  zonaTipo: string | null;
  recogida: string;
  referencia: string | null;
  destino: string | null;
  pasajeros: number;
  vehiculo: string;
  cliente: string | null;
  telefono: string;
  conductorCodigo: string | null;
  conductor: string | null;
  placa: string | null;
  tarifaEstimada: number;
  tarifaFinal: number | null;
  distanciaKm: number | null;
  asignacionSegundos: number | null;
  linea: string | null;
  intentos: number;
  motivoCancelacion: string | null;
  finalizada: Date | null;
  /** Algún paso lo dio un operador: no la resolvió el agente solo (§10.1). */
  intervenida: boolean;
}

export interface Periodo {
  params: ExportParams;
  desde: Date;
  hasta: Date;
  filas: FilaCarrera[];
  /** Si había más carreras que `MAX_FILAS` y el archivo va recortado. */
  recortado: boolean;
}

/** Las carreras del periodo, con los filtros que traiga la petición. */
export async function leerPeriodo(db: Database, params: ExportParams): Promise<Periodo> {
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - params.days * 86_400_000);

  const filtros: SQL[] = [sql`r.created_at >= ${desde.toISOString()}::timestamptz`];
  if (params.statuses?.length) {
    filtros.push(sql`r.status::text in (${sql.join(params.statuses.map((s) => sql`${s}`), sql`, `)})`);
  }
  if (params.zoneId) filtros.push(sql`r.zone_id = ${params.zoneId}::uuid`);
  if (params.query?.trim()) {
    // La misma búsqueda que el panel: código, cliente, teléfono o dirección.
    const aguja = `%${params.query.trim()}%`;
    filtros.push(
      sql`(r.code ilike ${aguja} or c.name ilike ${aguja} or c.phone ilike ${aguja} or r.pickup_text ilike ${aguja})`,
    );
  }

  const resultado = await db.execute<{
    codigo: string;
    creada: Date;
    estado: RideStatus;
    zona: string | null;
    zona_tipo: string | null;
    recogida: string;
    referencia: string | null;
    destino: string | null;
    pasajeros: number;
    vehiculo: string;
    cliente: string | null;
    telefono: string;
    conductor_codigo: string | null;
    conductor: string | null;
    placa: string | null;
    tarifa_estimada: number;
    tarifa_final: number | null;
    distancia_km: number | null;
    asignacion_s: number | null;
    linea: string | null;
    intentos: number;
    motivo_cancelacion: string | null;
    finalizada: Date | null;
    intervenida: boolean;
  }>(sql`
    select r.code as codigo,
           r.created_at as creada,
           r.status as estado,
           z.name as zona,
           z.kind::text as zona_tipo,
           r.pickup_text as recogida,
           r.pickup_reference as referencia,
           r.dropoff_text as destino,
           r.passengers as pasajeros,
           r.vehicle_type::text as vehiculo,
           c.name as cliente,
           c.phone as telefono,
           d.code as conductor_codigo,
           d.name as conductor,
           v.plate as placa,
           r.fare_estimate as tarifa_estimada,
           r.fare_final as tarifa_final,
           r.distance_km as distancia_km,
           extract(epoch from r.assigned_at - r.created_at)::int as asignacion_s,
           r.line as linea,
           r.intento_despacho as intentos,
           r.cancel_reason as motivo_cancelacion,
           r.finished_at as finalizada,
           exists (
             select 1 from ride_status_history h
              where h.ride_id = r.id and h.actor = 'operator'
           ) as intervenida
      from rides r
      left join zones z on z.id = r.zone_id
      left join customers c on c.id = r.customer_id
      left join drivers d on d.id = r.driver_id
      left join vehicles v on v.id = r.vehicle_id
     where ${sql.join(filtros, sql` and `)}
     order by r.created_at desc
     limit ${MAX_FILAS + 1}
  `);

  const crudas = resultado.rows;
  const recortado = crudas.length > MAX_FILAS;

  return {
    params,
    desde,
    hasta,
    recortado,
    filas: crudas.slice(0, MAX_FILAS).map((f) => ({
      codigo: f.codigo,
      creada: new Date(f.creada),
      estado: f.estado,
      estadoTexto: RIDE_STATUS_LABEL[f.estado] ?? f.estado,
      zona: f.zona,
      zonaTipo: f.zona_tipo,
      recogida: f.recogida,
      referencia: f.referencia,
      destino: f.destino,
      pasajeros: f.pasajeros,
      vehiculo: f.vehiculo,
      cliente: f.cliente,
      telefono: f.telefono,
      conductorCodigo: f.conductor_codigo,
      conductor: f.conductor,
      placa: f.placa,
      tarifaEstimada: f.tarifa_estimada,
      tarifaFinal: f.tarifa_final,
      distanciaKm: f.distancia_km === null ? null : Number(f.distancia_km),
      asignacionSegundos: f.asignacion_s,
      linea: f.linea,
      intentos: f.intentos,
      motivoCancelacion: f.motivo_cancelacion,
      finalizada: f.finalizada ? new Date(f.finalizada) : null,
      intervenida: f.intervenida,
    })),
  };
}

/* --------------------------------------------------------- agregados --- */

/** Lo que se cobró: la tarifa final si la hay, si no la que se le dijo al cliente. */
export const facturado = (f: FilaCarrera) => f.tarifaFinal ?? f.tarifaEstimada;

function percentil(valores: number[], p: number): number | null {
  if (valores.length === 0) return null;
  const orden = [...valores].sort((a, b) => a - b);
  // Interpolación lineal, igual que `percentile_cont` de PostgreSQL.
  const pos = (orden.length - 1) * p;
  const bajo = Math.floor(pos);
  const alto = Math.ceil(pos);
  return Math.round(orden[bajo]! + (orden[alto]! - orden[bajo]!) * (pos - bajo));
}

export interface Resumen {
  creadas: number;
  finalizadas: number;
  canceladas: number;
  sinAsignar: number;
  enCurso: number;
  facturado: number;
  tarifaMedia: number | null;
  kmRecorridos: number;
  asignacionP50: number | null;
  asignacionP95: number | null;
  sinIntervencion: number | null;
  porZona: { zona: string; tipo: string; carreras: number; finalizadas: number; canceladas: number; facturado: number }[];
  porConductor: { codigo: string; nombre: string; finalizadas: number; facturado: number; km: number }[];
  porHora: { hora: string; carreras: number }[];
  porDia: { dia: string; carreras: number; finalizadas: number; p50: number | null; p95: number | null }[];
}

const horaLocal = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA_HORARIA, hour: '2-digit', hourCycle: 'h23' });
const diaLocal = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * Todo lo que cuentan el Excel y el PDF, sacado de las mismas filas: si el
 * resumen dijera 40 finalizadas y la hoja de carreras tuviera 41, nadie se
 * fiaría de ninguno de los dos.
 */
export function resumir(filas: FilaCarrera[]): Resumen {
  const finalizadas = filas.filter((f) => f.estado === 'COMPLETED');
  const asignaciones = filas.flatMap((f) => (f.asignacionSegundos === null ? [] : [f.asignacionSegundos]));
  const totalFacturado = finalizadas.reduce((s, f) => s + facturado(f), 0);

  const porZona = new Map<string, Resumen['porZona'][number]>();
  const porConductor = new Map<string, Resumen['porConductor'][number]>();
  const porHora = new Map<string, number>();
  const porDia = new Map<string, { carreras: number; finalizadas: number; asignaciones: number[] }>();

  for (const f of filas) {
    const zona = f.zona ?? 'Sin zona';
    const z = porZona.get(zona) ?? { zona, tipo: f.zonaTipo ?? '—', carreras: 0, finalizadas: 0, canceladas: 0, facturado: 0 };
    z.carreras += 1;
    if (f.estado === 'COMPLETED') {
      z.finalizadas += 1;
      z.facturado += facturado(f);
    }
    if (f.estado === 'CANCELLED') z.canceladas += 1;
    porZona.set(zona, z);

    if (f.estado === 'COMPLETED' && f.conductorCodigo) {
      const c = porConductor.get(f.conductorCodigo) ?? {
        codigo: f.conductorCodigo,
        nombre: f.conductor ?? '',
        finalizadas: 0,
        facturado: 0,
        km: 0,
      };
      c.finalizadas += 1;
      c.facturado += facturado(f);
      c.km += f.distanciaKm ?? 0;
      porConductor.set(f.conductorCodigo, c);
    }

    const hora = horaLocal.format(f.creada).padStart(2, '0');
    porHora.set(hora, (porHora.get(hora) ?? 0) + 1);

    const dia = diaLocal.format(f.creada);
    const d = porDia.get(dia) ?? { carreras: 0, finalizadas: 0, asignaciones: [] };
    d.carreras += 1;
    if (f.estado === 'COMPLETED') d.finalizadas += 1;
    if (f.asignacionSegundos !== null) d.asignaciones.push(f.asignacionSegundos);
    porDia.set(dia, d);
  }

  return {
    creadas: filas.length,
    finalizadas: finalizadas.length,
    canceladas: filas.filter((f) => f.estado === 'CANCELLED').length,
    sinAsignar: filas.filter((f) => f.estado === 'UNASSIGNED').length,
    enCurso: filas.filter((f) => !['COMPLETED', 'CANCELLED', 'UNASSIGNED'].includes(f.estado)).length,
    facturado: totalFacturado,
    tarifaMedia: finalizadas.length ? Math.round(totalFacturado / finalizadas.length) : null,
    kmRecorridos: Math.round(finalizadas.reduce((s, f) => s + (f.distanciaKm ?? 0), 0) * 10) / 10,
    asignacionP50: percentil(asignaciones, 0.5),
    asignacionP95: percentil(asignaciones, 0.95),
    sinIntervencion: filas.length ? filas.filter((f) => !f.intervenida).length / filas.length : null,
    porZona: [...porZona.values()].sort((a, b) => b.carreras - a.carreras),
    porConductor: [...porConductor.values()].sort((a, b) => b.facturado - a.facturado),
    porHora: Array.from({ length: 24 }, (_, h) => {
      const hora = String(h).padStart(2, '0');
      return { hora, carreras: porHora.get(hora) ?? 0 };
    }),
    porDia: [...porDia.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dia, d]) => ({
        dia,
        carreras: d.carreras,
        finalizadas: d.finalizadas,
        p50: percentil(d.asignaciones, 0.5),
        p95: percentil(d.asignaciones, 0.95),
      })),
  };
}

/* ------------------------------------------------------------ textos --- */

export function nombreDelPeriodo(days: number): string {
  return days === 1 ? 'últimas 24 horas' : `últimos ${days} días`;
}

const fechaHora = new Intl.DateTimeFormat('es-CO', {
  timeZone: ZONA_HORARIA,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export const formatoFechaHora = (d: Date) => fechaHora.format(d);

/**
 * La misma hora, pero con la de Paipa en los campos UTC. Excel no sabe de
 * zonas horarias: muestra la hora UTC de la fecha tal cual, y una carrera de
 * las 7 de la mañana saldría a las 12.
 */
export function paraExcel(d: Date): Date {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: ZONA_HORARIA,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return new Date(
    Date.UTC(
      Number(partes.year),
      Number(partes.month) - 1,
      Number(partes.day),
      Number(partes.hour),
      Number(partes.minute),
      Number(partes.second),
    ),
  );
}
