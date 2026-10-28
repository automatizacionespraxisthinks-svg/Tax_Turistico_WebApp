import { z } from 'zod';

/**
 * Reportes: los filtros del tablero y lo que devuelve la API.
 *
 * Los comparten la API, que los valida y calcula, y el panel, que los guarda
 * en la dirección de la página: así un tablero filtrado se puede recargar o
 * pasar a otra persona de la oficina y se ve igual.
 */

/**
 * Las metas de la operación. Las tres salen de la empresa: conseguir taxi en
 * un minuto, llegar al cliente en diez y que el asistente resuelva solo ocho
 * de cada diez pedidos (§10.1).
 */
export const METAS = {
  asignacionSegundos: 60,
  llegadaMinutos: 10,
  sinIntervencion: 0.8,
} as const;

/**
 * El periodo más largo que se puede pedir. Con el volumen de Paipa son unas
 * decenas de miles de carreras, que la API cuenta en memoria sin apuro; un año
 * entero ya no.
 */
export const MAX_DIAS_INFORME = 93;

/** Paipa. Colombia no cambia de hora en el año, pero mejor no suponerlo. */
export const ZONA_HORARIA_PAIPA = 'America/Bogota';

export const PERIODOS_RAPIDOS = ['hoy', 'ayer', '7d', '30d', 'mes', 'mes_pasado'] as const;
export type PeriodoRapido = (typeof PERIODOS_RAPIDOS)[number];

export const ETIQUETA_PERIODO: Record<PeriodoRapido, string> = {
  hoy: 'Hoy',
  ayer: 'Ayer',
  '7d': '7 días',
  '30d': '30 días',
  mes: 'Este mes',
  mes_pasado: 'Mes pasado',
};

/* ----------------------------------------------------------------- fechas --- */

const formatoDia = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_HORARIA_PAIPA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** El día de hoy en Paipa: `2026-10-28`. */
export function hoyEnPaipa(ahora = new Date()): string {
  return formatoDia.format(ahora);
}

/** El día en Paipa de un instante cualquiera. */
export function diaEnPaipa(instante: Date): string {
  return formatoDia.format(instante);
}

/** Suma días a una fecha `AAAA-MM-DD`, sin pasar por la hora local del equipo. */
export function sumarDias(fecha: string, dias: number): string {
  const [a, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(a!, m! - 1, d! + dias)).toISOString().slice(0, 10);
}

/** Días del periodo, contando los dos extremos: del 22 al 28 son 7. */
export function diasDelRango(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Cada fecha del periodo, en orden, para que un día sin carreras salga en cero. */
export function fechasDelRango(desde: string, hasta: string): string[] {
  return Array.from({ length: Math.max(0, diasDelRango(desde, hasta)) }, (_, i) => sumarDias(desde, i));
}

export function rangoDePeriodo(periodo: PeriodoRapido, hoy = hoyEnPaipa()): { desde: string; hasta: string } {
  const primeroDelMes = `${hoy.slice(0, 7)}-01`;
  switch (periodo) {
    case 'hoy':
      return { desde: hoy, hasta: hoy };
    case 'ayer':
      return { desde: sumarDias(hoy, -1), hasta: sumarDias(hoy, -1) };
    case '7d':
      return { desde: sumarDias(hoy, -6), hasta: hoy };
    case '30d':
      return { desde: sumarDias(hoy, -29), hasta: hoy };
    case 'mes':
      return { desde: primeroDelMes, hasta: hoy };
    case 'mes_pasado': {
      const ultimoDelAnterior = sumarDias(primeroDelMes, -1);
      return { desde: `${ultimoDelAnterior.slice(0, 7)}-01`, hasta: ultimoDelAnterior };
    }
  }
}

/** El periodo rápido que corresponde a un rango, si alguno coincide. */
export function periodoDelRango(desde: string, hasta: string, hoy = hoyEnPaipa()): PeriodoRapido | null {
  return (
    PERIODOS_RAPIDOS.find((p) => {
      const r = rangoDePeriodo(p, hoy);
      return r.desde === desde && r.hasta === hasta;
    }) ?? null
  );
}

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

/** «22 oct – 28 oct 2026», o «28 oct 2026» si es un solo día. */
export function textoDelRango(desde: string, hasta: string): string {
  const parte = (f: string, conAno: boolean) => {
    const [a, m, d] = f.split('-').map(Number);
    return `${d} ${MESES_CORTOS[m! - 1]}${conAno ? ` ${a}` : ''}`;
  };
  if (desde === hasta) return parte(hasta, true);
  return `${parte(desde, desde.slice(0, 4) !== hasta.slice(0, 4))} – ${parte(hasta, true)}`;
}

/** «45 s», «1 min 11 s», «6 min»: como se dice un tiempo de espera. */
export function duracionCorta(segundos: number): string {
  const s = Math.round(segundos);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  const resto = s % 60;
  // Pasados los diez minutos los segundos ya no le dicen nada a nadie.
  if (min >= 10 || resto === 0) return `${Math.round(s / 60)} min`;
  return `${min} min ${resto} s`;
}

/* ---------------------------------------------------------------- filtros --- */

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato AAAA-MM-DD');

/** En la dirección las listas van separadas por comas: `zonas=a,b`. */
const lista = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
    z.array(item).max(50),
  );

const siNo = z.preprocess((v) => (v === 'false' || v === '0' ? false : v === 'true' || v === '1' ? true : v), z.boolean());

/**
 * Los filtros del tablero.
 *
 * De opción única: el periodo (un tablero mira un solo periodo), urbano o
 * veredas (son tres casos que se excluyen) y el conductor (uno solo es la
 * vista individual; para comparar a varios ya está la tabla de conductores).
 * De opción múltiple: los sectores y las líneas de WhatsApp, que tiene
 * sentido sumar: «Centro y Norte», «las dos líneas del hotel».
 */
export const filtrosDeInformeSchema = z
  .object({
    desde: fecha,
    hasta: fecha,
    zonas: lista(z.string().uuid()).optional(),
    tipoZona: z.enum(['urbano', 'rural']).optional(),
    conductor: z.string().uuid().optional(),
    lineas: lista(z.string().trim().min(1).max(60)).optional(),
    sinPruebas: siNo.default(true),
  })
  .refine((f) => f.desde <= f.hasta, { message: 'El periodo termina antes de empezar', path: ['hasta'] })
  .refine((f) => diasDelRango(f.desde, f.hasta) <= MAX_DIAS_INFORME, {
    message: `El periodo puede tener hasta ${MAX_DIAS_INFORME} días`,
    path: ['desde'],
  });
export type FiltrosDeInforme = z.infer<typeof filtrosDeInformeSchema>;

/* ------------------------------------------------------- lo que devuelve --- */

/** Un trozo del resumen en palabras; los fuertes van en negrita. */
export interface Fragmento {
  texto: string;
  fuerte?: boolean;
}

export interface CifrasDelInforme {
  creadas: number;
  finalizadas: number;
  canceladas: number;
  sinAsignar: number;
  enCurso: number;
  /** Canceladas sobre creadas, de 0 a 1. */
  tasaCancelacion: number | null;
  /** De crear la carrera a que un conductor la acepte, en segundos. */
  asignacionP50: number | null;
  asignacionP95: number | null;
  /** De aceptar a «Llegué»: lo que esperó el cliente, en segundos. */
  llegadaP50: number | null;
  llegadaP95: number | null;
  /** Con el pasajero a bordo, en minutos, solo las finalizadas. */
  duracionP50: number | null;
  kmRecorridos: number;
  /** Las que el agente resolvió sin ningún paso de un operador, de 0 a 1. */
  sinIntervencion: number | null;
  horaPico: { hora: string; carreras: number } | null;
  /** Conductores con al menos una carrera asignada. */
  conductores: number;
}

export interface FilaConductorInforme {
  id: string;
  codigo: string;
  nombre: string;
  esPrueba: boolean;
  /** Carreras que tomó en el periodo, terminaran como terminaran. */
  asignadas: number;
  finalizadas: number;
  /** Canceladas después de que él la aceptara. */
  canceladas: number;
  ofertas: number;
  aceptadas: number;
  rechazadas: number;
  vencidas: number;
  /** Aceptadas sobre las que respondió o dejó vencer; las que tomó otro no cuentan. */
  tasaAceptacion: number | null;
  llegadaP50: number | null;
  duracionP50: number | null;
  km: number;
  /** Horas con turno abierto dentro del periodo, sin mirar zona ni línea. */
  horasTurno: number;
  carrerasPorHora: number | null;
}

export interface TableroInforme {
  periodo: { desde: string; hasta: string; dias: number };
  /** Si había más carreras de las que se cuentan y las cifras van recortadas. */
  recortado: boolean;
  enPalabras: Fragmento[];
  cifras: CifrasDelInforme;
  porDia: {
    dia: string;
    carreras: number;
    finalizadas: number;
    canceladas: number;
    sinAsignar: number;
    abiertas: number;
    asignacionP50: number | null;
    asignacionP95: number | null;
    llegadaP50: number | null;
    sinIntervencion: number | null;
  }[];
  porHora: { hora: string; urbano: number; rural: number; total: number }[];
  /** Carreras por día de la semana (lunes primero) y hora: dónde están los picos. */
  calor: { dias: string[]; valores: number[][] };
  porZona: { zona: string; tipo: string; carreras: number; finalizadas: number; canceladas: number }[];
  porLinea: { linea: string; carreras: number; finalizadas: number; sinIntervencion: number | null }[];
  cancelaciones: { motivo: string; carreras: number }[];
  /** Todos los conductores, con los mismos filtros salvo el de conductor. */
  conductores: FilaConductorInforme[];
  /** Solo con un conductor elegido: él frente al resto. */
  individual: {
    fila: FilaConductorInforme;
    placas: string[];
    grupo: {
      conductores: number;
      finalizadasPorConductor: number | null;
      tasaAceptacion: number | null;
      llegadaP50: number | null;
      duracionP50: number | null;
      carrerasPorHora: number | null;
    };
  } | null;
}

export interface OpcionesDeInforme {
  zonas: { id: string; nombre: string; tipo: 'urbano' | 'rural' }[];
  conductores: { id: string; codigo: string; nombre: string; esPrueba: boolean; activo: boolean }[];
  lineas: string[];
}
