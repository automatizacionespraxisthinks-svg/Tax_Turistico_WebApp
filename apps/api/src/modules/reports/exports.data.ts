import { sql, type SQL } from 'drizzle-orm';
import { RIDE_STATUS_LABEL, fechasDelRango, textoDelRango, type RideStatus } from '@tax/shared';
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
  pagoElectronico: boolean;
  vehiculo: string;
  cliente: string | null;
  telefono: string;
  conductorId: string | null;
  conductorCodigo: string | null;
  conductor: string | null;
  placa: string | null;
  distanciaKm: number | null;
  /** De crear la carrera a que un conductor la acepte. */
  asignacionSegundos: number | null;
  /** De aceptarla a marcar «Llegué»: lo que esperó el cliente al taxi. */
  llegadaSegundos: number | null;
  /** De «Pasajero a bordo» a finalizar. */
  duracionMinutos: number | null;
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
  /** «22 oct – 28 oct 2026», o «últimos 7 días» en las de *Carreras*. */
  texto: string;
  /** Los días del periodo, en orden; solo cuando se pidió por fechas. */
  dias?: string[];
  filas: FilaCarrera[];
  /** Si había más carreras que `MAX_FILAS` y el archivo va recortado. */
  recortado: boolean;
}

/**
 * Dónde empieza y dónde acaba el periodo.
 *
 * Por fechas, son días de Paipa enteros: del 22 a las 00:00 al 29 a las
 * 00:00, hora de Paipa. La conversión la hace PostgreSQL con la zona horaria,
 * no este proceso con un desfase escrito a mano.
 */
export async function limitesDelPeriodo(db: Database, params: ExportParams): Promise<{ desde: Date; hasta: Date }> {
  if (params.desde && params.hasta) {
    const { rows } = await db.execute<{ desde: Date; hasta: Date }>(sql`
      select (${params.desde}::date)::timestamp at time zone ${ZONA_HORARIA} as desde,
             (${params.hasta}::date + 1)::timestamp at time zone ${ZONA_HORARIA} as hasta
    `);
    return { desde: new Date(rows[0]!.desde), hasta: new Date(rows[0]!.hasta) };
  }
  const hasta = new Date();
  return { desde: new Date(hasta.getTime() - (params.days ?? 7) * 86_400_000), hasta };
}

/**
 * Las condiciones de los filtros, sobre `rides r`, `zones z`, `customers c` y
 * `drivers d` (el conductor de la carrera).
 *
 * Las ofertas se cuentan con las mismas carreras, pero el conductor que
 * importa es el que recibió la oferta, no el que se la llevó: para ellas
 * `deOfertas` deja fuera lo que mira a `d`, y la consulta pone lo suyo.
 */
export function condicionesDelPeriodo(
  params: ExportParams,
  limites: { desde: Date; hasta: Date },
  opciones: { deOfertas?: boolean } = {},
): SQL[] {
  const condiciones: SQL[] = [
    sql`r.created_at >= ${limites.desde.toISOString()}::timestamptz`,
    sql`r.created_at < ${limites.hasta.toISOString()}::timestamptz`,
  ];
  const enLista = (valores: string[]) => sql.join(valores.map((v) => sql`${v}`), sql`, `);

  if (params.statuses?.length) condiciones.push(sql`r.status::text in (${enLista(params.statuses)})`);
  if (params.zoneId) condiciones.push(sql`r.zone_id = ${params.zoneId}::uuid`);
  if (params.zoneIds?.length) condiciones.push(sql`r.zone_id::text in (${enLista(params.zoneIds)})`);
  if (params.zoneKind) condiciones.push(sql`z.kind::text = ${params.zoneKind}`);
  if (params.lines?.length) condiciones.push(sql`r.line in (${enLista(params.lines)})`);
  if (params.query?.trim()) {
    // La misma búsqueda que el panel: código, cliente, teléfono o dirección.
    const aguja = `%${params.query.trim()}%`;
    condiciones.push(
      sql`(r.code ilike ${aguja} or c.name ilike ${aguja} or c.phone ilike ${aguja} or r.pickup_text ilike ${aguja})`,
    );
  }
  if (params.excludeTests) condiciones.push(sql`not c.es_prueba`);

  if (!opciones.deOfertas) {
    if (params.driverId) condiciones.push(sql`r.driver_id = ${params.driverId}::uuid`);
    if (params.excludeTests) condiciones.push(sql`not coalesce(d.es_prueba, false)`);
  }
  return condiciones;
}

export function textoDelPeriodo(params: ExportParams): string {
  if (params.desde && params.hasta) return textoDelRango(params.desde, params.hasta);
  const dias = params.days ?? 7;
  return dias === 1 ? 'últimas 24 horas' : `últimos ${dias} días`;
}

/** Las carreras del periodo, con los filtros que traiga la petición. */
export async function leerPeriodo(db: Database, params: ExportParams): Promise<Periodo> {
  const limites = await limitesDelPeriodo(db, params);
  const condiciones = condicionesDelPeriodo(params, limites);

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
    pago_electronico: boolean;
    vehiculo: string;
    cliente: string | null;
    telefono: string;
    conductor_id: string | null;
    conductor_codigo: string | null;
    conductor: string | null;
    placa: string | null;
    distancia_km: number | null;
    asignacion_s: number | null;
    llegada_s: number | null;
    duracion_s: number | null;
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
           r.pago_electronico,
           r.vehicle_type::text as vehiculo,
           c.name as cliente,
           c.phone as telefono,
           d.id as conductor_id,
           d.code as conductor_codigo,
           d.name as conductor,
           v.plate as placa,
           r.distance_km as distancia_km,
           extract(epoch from r.assigned_at - r.created_at)::int as asignacion_s,
           extract(epoch from r.arrived_at - r.assigned_at)::int as llegada_s,
           extract(epoch from r.finished_at - r.started_at)::int as duracion_s,
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
     where ${sql.join(condiciones, sql` and `)}
     order by r.created_at desc
     limit ${MAX_FILAS + 1}
  `);

  const crudas = resultado.rows;
  const recortado = crudas.length > MAX_FILAS;

  return {
    params,
    ...limites,
    texto: textoDelPeriodo(params),
    dias: params.desde && params.hasta ? fechasDelRango(params.desde, params.hasta) : undefined,
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
      pagoElectronico: f.pago_electronico,
      vehiculo: f.vehiculo,
      cliente: f.cliente,
      telefono: f.telefono,
      conductorId: f.conductor_id,
      conductorCodigo: f.conductor_codigo,
      conductor: f.conductor,
      placa: f.placa,
      distanciaKm: f.distancia_km === null ? null : Number(f.distancia_km),
      asignacionSegundos: f.asignacion_s,
      llegadaSegundos: f.llegada_s,
      // Solo las que de verdad terminaron con el pasajero: una cancelada a
      // bordo no tiene una duración que signifique nada.
      duracionMinutos: f.estado === 'COMPLETED' && f.duracion_s !== null ? Math.round(f.duracion_s / 60) : null,
      linea: f.linea,
      intentos: f.intentos,
      motivoCancelacion: f.motivo_cancelacion,
      finalizada: f.finalizada ? new Date(f.finalizada) : null,
      intervenida: f.intervenida,
    })),
  };
}

/* --------------------------------------------------------- agregados --- */

export function percentil(valores: number[], p: number): number | null {
  if (valores.length === 0) return null;
  const orden = [...valores].sort((a, b) => a - b);
  // Interpolación lineal, igual que `percentile_cont` de PostgreSQL.
  const pos = (orden.length - 1) * p;
  const bajo = Math.floor(pos);
  const alto = Math.ceil(pos);
  return Math.round(orden[bajo]! + (orden[alto]! - orden[bajo]!) * (pos - bajo));
}

const ABIERTA = (estado: RideStatus) => !['COMPLETED', 'CANCELLED', 'UNASSIGNED'].includes(estado);

export interface ResumenConductor {
  id: string;
  codigo: string;
  nombre: string;
  asignadas: number;
  finalizadas: number;
  canceladas: number;
  km: number;
  duracionP50: number | null;
  llegadaP50: number | null;
}

export interface Resumen {
  creadas: number;
  finalizadas: number;
  canceladas: number;
  sinAsignar: number;
  enCurso: number;
  kmRecorridos: number;
  asignacionP50: number | null;
  asignacionP95: number | null;
  /** Mediana, en segundos, de aceptar a llegar al punto. */
  llegadaP50: number | null;
  llegadaP95: number | null;
  /** Mediana, en minutos, de las carreras finalizadas. */
  duracionP50: number | null;
  sinIntervencion: number | null;
  /** La hora con más carreras: el pico del periodo. */
  horaPico: { hora: string; carreras: number } | null;
  porZona: { zona: string; tipo: string; carreras: number; finalizadas: number; canceladas: number }[];
  porConductor: ResumenConductor[];
  porHora: { hora: string; carreras: number; urbano: number; rural: number }[];
  porDia: {
    dia: string;
    carreras: number;
    finalizadas: number;
    canceladas: number;
    sinAsignar: number;
    abiertas: number;
    p50: number | null;
    p95: number | null;
    llegadaP50: number | null;
    sinIntervencion: number | null;
  }[];
  /** Siete filas, de lunes a domingo, de 24 horas cada una. */
  calor: number[][];
  porLinea: { linea: string; carreras: number; finalizadas: number; sinIntervencion: number | null }[];
  cancelaciones: { motivo: string; carreras: number }[];
}

const horaLocal = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA_HORARIA, hour: '2-digit', hourCycle: 'h23' });
const diaLocal = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit' });
const diaDeSemana = new Intl.DateTimeFormat('en-US', { timeZone: ZONA_HORARIA, weekday: 'short' });
const LUNES_PRIMERO = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const SIN_LINEA = 'Sin línea';
export const SIN_MOTIVO = 'Sin motivo escrito';

/**
 * Todo lo que cuentan el tablero, el Excel y el PDF, sacado de las mismas
 * filas: si el resumen dijera 40 finalizadas y la hoja de carreras tuviera
 * 41, nadie se fiaría de ninguno de los dos.
 *
 * `dias` son los días del periodo: con ellos, un día sin carreras sale en
 * cero en vez de desaparecer de la gráfica.
 */
export function resumir(filas: FilaCarrera[], dias?: string[]): Resumen {
  const finalizadas = filas.filter((f) => f.estado === 'COMPLETED');
  const asignaciones = filas.flatMap((f) => (f.asignacionSegundos === null ? [] : [f.asignacionSegundos]));
  const llegadas = filas.flatMap((f) => (f.llegadaSegundos === null ? [] : [f.llegadaSegundos]));
  const duraciones = filas.flatMap((f) => (f.duracionMinutos === null ? [] : [f.duracionMinutos]));

  const porZona = new Map<string, Resumen['porZona'][number]>();
  const porConductor = new Map<string, ResumenConductor & { duraciones: number[]; llegadas: number[] }>();
  const porHora = new Map<string, { carreras: number; urbano: number; rural: number }>();
  const porDia = new Map<
    string,
    {
      carreras: number;
      finalizadas: number;
      canceladas: number;
      sinAsignar: number;
      abiertas: number;
      intervenidas: number;
      asignaciones: number[];
      llegadas: number[];
    }
  >();
  const porLinea = new Map<string, { carreras: number; finalizadas: number; intervenidas: number }>();
  const cancelaciones = new Map<string, number>();
  const calor = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

  const nuevoDia = () => ({
    carreras: 0,
    finalizadas: 0,
    canceladas: 0,
    sinAsignar: 0,
    abiertas: 0,
    intervenidas: 0,
    asignaciones: [] as number[],
    llegadas: [] as number[],
  });
  for (const dia of dias ?? []) porDia.set(dia, nuevoDia());

  for (const f of filas) {
    const zona = f.zona ?? 'Sin zona';
    const z = porZona.get(zona) ?? { zona, tipo: f.zonaTipo ?? '—', carreras: 0, finalizadas: 0, canceladas: 0 };
    z.carreras += 1;
    if (f.estado === 'COMPLETED') z.finalizadas += 1;
    if (f.estado === 'CANCELLED') z.canceladas += 1;
    porZona.set(zona, z);

    if (f.conductorId) {
      const c = porConductor.get(f.conductorId) ?? {
        id: f.conductorId,
        codigo: f.conductorCodigo ?? '',
        nombre: f.conductor ?? '',
        asignadas: 0,
        finalizadas: 0,
        canceladas: 0,
        km: 0,
        duracionP50: null,
        llegadaP50: null,
        duraciones: [],
        llegadas: [],
      };
      c.asignadas += 1;
      if (f.estado === 'COMPLETED') {
        c.finalizadas += 1;
        c.km += f.distanciaKm ?? 0;
      }
      if (f.estado === 'CANCELLED') c.canceladas += 1;
      if (f.duracionMinutos !== null) c.duraciones.push(f.duracionMinutos);
      if (f.llegadaSegundos !== null) c.llegadas.push(f.llegadaSegundos);
      porConductor.set(f.conductorId, c);
    }

    const hora = horaLocal.format(f.creada).padStart(2, '0');
    const h = porHora.get(hora) ?? { carreras: 0, urbano: 0, rural: 0 };
    h.carreras += 1;
    if (f.zonaTipo === 'rural') h.rural += 1;
    if (f.zonaTipo === 'urbano') h.urbano += 1;
    porHora.set(hora, h);

    const semana = LUNES_PRIMERO.indexOf(diaDeSemana.format(f.creada));
    if (semana >= 0) calor[semana]![Number(hora)]! += 1;

    const dia = diaLocal.format(f.creada);
    const d = porDia.get(dia) ?? nuevoDia();
    d.carreras += 1;
    if (f.estado === 'COMPLETED') d.finalizadas += 1;
    if (f.estado === 'CANCELLED') d.canceladas += 1;
    if (f.estado === 'UNASSIGNED') d.sinAsignar += 1;
    if (ABIERTA(f.estado)) d.abiertas += 1;
    if (f.intervenida) d.intervenidas += 1;
    if (f.asignacionSegundos !== null) d.asignaciones.push(f.asignacionSegundos);
    if (f.llegadaSegundos !== null) d.llegadas.push(f.llegadaSegundos);
    porDia.set(dia, d);

    const linea = f.linea ?? SIN_LINEA;
    const l = porLinea.get(linea) ?? { carreras: 0, finalizadas: 0, intervenidas: 0 };
    l.carreras += 1;
    if (f.estado === 'COMPLETED') l.finalizadas += 1;
    if (f.intervenida) l.intervenidas += 1;
    porLinea.set(linea, l);

    if (f.estado === 'CANCELLED') {
      const motivo = f.motivoCancelacion?.trim() || SIN_MOTIVO;
      cancelaciones.set(motivo, (cancelaciones.get(motivo) ?? 0) + 1);
    }
  }

  const horas = Array.from({ length: 24 }, (_, i) => {
    const hora = String(i).padStart(2, '0');
    return { hora, ...(porHora.get(hora) ?? { carreras: 0, urbano: 0, rural: 0 }) };
  });
  const pico = horas.reduce<Resumen['horaPico']>(
    (max, h) => (h.carreras > (max?.carreras ?? 0) ? { hora: h.hora, carreras: h.carreras } : max),
    null,
  );

  return {
    creadas: filas.length,
    finalizadas: finalizadas.length,
    canceladas: filas.filter((f) => f.estado === 'CANCELLED').length,
    sinAsignar: filas.filter((f) => f.estado === 'UNASSIGNED').length,
    enCurso: filas.filter((f) => ABIERTA(f.estado)).length,
    kmRecorridos: Math.round(finalizadas.reduce((s, f) => s + (f.distanciaKm ?? 0), 0) * 10) / 10,
    asignacionP50: percentil(asignaciones, 0.5),
    asignacionP95: percentil(asignaciones, 0.95),
    llegadaP50: percentil(llegadas, 0.5),
    llegadaP95: percentil(llegadas, 0.95),
    duracionP50: percentil(duraciones, 0.5),
    sinIntervencion: filas.length ? filas.filter((f) => !f.intervenida).length / filas.length : null,
    horaPico: pico,
    porZona: [...porZona.values()].sort((a, b) => b.carreras - a.carreras),
    porConductor: [...porConductor.values()]
      .map(({ duraciones: ds, llegadas: ls, ...c }) => ({
        ...c,
        km: Math.round(c.km * 10) / 10,
        duracionP50: percentil(ds, 0.5),
        llegadaP50: percentil(ls, 0.5),
      }))
      .sort((a, b) => b.finalizadas - a.finalizadas || b.asignadas - a.asignadas),
    porHora: horas,
    porDia: [...porDia.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dia, d]) => ({
        dia,
        carreras: d.carreras,
        finalizadas: d.finalizadas,
        canceladas: d.canceladas,
        sinAsignar: d.sinAsignar,
        abiertas: d.abiertas,
        p50: percentil(d.asignaciones, 0.5),
        p95: percentil(d.asignaciones, 0.95),
        llegadaP50: percentil(d.llegadas, 0.5),
        sinIntervencion: d.carreras ? (d.carreras - d.intervenidas) / d.carreras : null,
      })),
    calor,
    porLinea: [...porLinea.entries()]
      .map(([linea, l]) => ({
        linea,
        carreras: l.carreras,
        finalizadas: l.finalizadas,
        sinIntervencion: l.carreras ? (l.carreras - l.intervenidas) / l.carreras : null,
      }))
      .sort((a, b) => b.carreras - a.carreras),
    cancelaciones: [...cancelaciones.entries()]
      .map(([motivo, carreras]) => ({ motivo, carreras }))
      .sort((a, b) => b.carreras - a.carreras),
  };
}

/* ------------------------------------------------------------ textos --- */

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
