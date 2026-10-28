import { useState } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Ban,
  Bot,
  Car,
  CheckCircle2,
  Clock,
  Download,
  FileSpreadsheet,
  FileText,
  Gauge,
  Handshake,
  Hourglass,
  Loader2,
  MapPin,
  Route,
  Timer,
  Users,
  X,
} from 'lucide-react';
import type {
  FilaConductorInforme,
  FiltrosDeInforme,
  OpcionesDeInforme,
  PeriodoRapido,
  TableroInforme,
} from '@tax/shared';
import {
  ETIQUETA_PERIODO,
  METAS,
  PERIODOS_RAPIDOS,
  duracionCorta,
  formatRelative,
  periodoDelRango,
  rangoDePeriodo,
  textoDelRango,
} from '@tax/shared';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Segmented,
  Skeleton,
  Stat,
  cn,
  staggerItem,
  staggerList,
  useToast,
} from '@tax/ui';
import {
  descargarExportacion,
  useExportaciones,
  useExportar,
  type Exportacion,
} from '../api/exportaciones';
import { ApiError } from '../api/client';
import { useFiltrosDeInforme, useOpcionesDeInforme, useTablero } from '../api/informes';
import { ChartFrame, DataTable, HorizontalBars, Lines, MapaDeCalor, StackedBars } from '../components/charts';
import { Casilla, FiltroMultiple, FiltroUnico, RangoDeFechas } from '../components/Filtros';

/* --------------------------------------------------------------- formatos --- */

const pct = (tasa: number | null) => (tasa === null ? '—' : `${Math.round(tasa * 100)} %`);
const dur = (segundos: number | null) => (segundos === null ? '—' : duracionCorta(segundos));
const minutos = (m: number | null) => (m === null ? '—' : `${m} min`);
const numero = (n: number) => n.toLocaleString('es-CO');
/** `2026-10-22` → `22/10`: el eje de los días no necesita el año. */
const diaCorto = (dia: string) => {
  const [, m, d] = dia.split('-');
  return `${Number(d)}/${Number(m)}`;
};

/** Lo que va en el título del Excel y del PDF: qué recortaba el tablero. */
function etiquetaDeFiltros(f: FiltrosDeInforme, opciones?: OpcionesDeInforme): string {
  const partes: string[] = [];
  if (f.conductor) {
    const c = opciones?.conductores.find((x) => x.id === f.conductor);
    partes.push(c ? `Conductor ${c.codigo}` : 'Un conductor');
  }
  if (f.zonas?.length) {
    const z = opciones?.zonas.find((x) => x.id === f.zonas![0]);
    partes.push(f.zonas.length === 1 && z ? z.nombre : `${f.zonas.length} sectores`);
  }
  if (f.tipoZona) partes.push(f.tipoZona === 'urbano' ? 'solo casco urbano' : 'solo veredas');
  if (f.lineas?.length) partes.push(f.lineas.length === 1 ? f.lineas[0]! : `${f.lineas.length} líneas`);
  partes.push(f.sinPruebas ? 'sin pruebas' : 'con pruebas');
  return partes.join(' · ');
}

/* ------------------------------------------------------------------ página --- */

/**
 * Reportes: el tablero de la operación.
 *
 * Arriba los filtros, debajo el resumen en palabras, las cifras, las gráficas
 * y la tabla de conductores. Todo sale de una sola consulta con los mismos
 * filtros, y el Excel y el PDF se generan con esos mismos filtros: lo que se
 * descarga es lo que se está viendo.
 *
 * Con un conductor elegido, el tablero pasa a ser el suyo y lo compara con el
 * resto; la tabla de conductores sigue mostrando a todos para ver dónde queda.
 */
export function Reportes() {
  const { filtros, cambiar, hayFiltros, hoy } = useFiltrosDeInforme();
  const opciones = useOpcionesDeInforme();
  const tablero = useTablero(filtros);
  const { exportar, generando } = useExportar();

  const t = tablero.data;
  const actualizando = tablero.isFetching && tablero.isPlaceholderData;

  const descargar = (format: 'xlsx' | 'pdf') =>
    void exportar({
      kind: 'resumen',
      format,
      desde: filtros.desde,
      hasta: filtros.hasta,
      zoneIds: filtros.zonas?.length ? filtros.zonas : undefined,
      zoneKind: filtros.tipoZona,
      driverId: filtros.conductor,
      lines: filtros.lineas?.length ? filtros.lineas : undefined,
      excludeTests: filtros.sinPruebas,
      filterLabel: etiquetaDeFiltros(filtros, opciones.data),
    });

  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-ink">Cómo le fue al servicio en el periodo elegido</p>
          <p className="text-caption text-ink-muted">
            {textoDelRango(filtros.desde, filtros.hasta)} · días completos en hora de Paipa
          </p>
        </div>
        {/* Del tablero tal como está filtrado. Cada formato con su color de
            siempre: Excel verde, PDF rojo. */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="success-solid"
            icon={<FileSpreadsheet className="size-3.5" />}
            loading={generando('resumen-xlsx')}
            title="Las cifras, todas las carreras del periodo y las tablas por conductor, zona, día y hora"
            onClick={() => descargar('xlsx')}
          >
            Descargar Excel
          </Button>
          <Button
            variant="danger-solid"
            icon={<FileText className="size-3.5" />}
            loading={generando('resumen-pdf')}
            title="El resumen del periodo para imprimir o enviar"
            onClick={() => descargar('pdf')}
          >
            Descargar informe PDF
          </Button>
        </div>
      </div>

      <BarraDeFiltros
        filtros={filtros}
        opciones={opciones.data}
        hoy={hoy}
        hayFiltros={hayFiltros}
        cambiar={cambiar}
      />

      {tablero.isError ? (
        <Card>
          <EmptyState
            icon={<AlertTriangle className="size-4" />}
            tone="critical"
            title="No se pudo cargar el tablero"
            description={tablero.error instanceof ApiError ? tablero.error.message : 'Revisa la conexión y vuelve a intentarlo.'}
            action={
              <Button size="sm" onClick={() => void tablero.refetch()}>
                Reintentar
              </Button>
            }
          />
        </Card>
      ) : !t ? (
        <Esqueleto />
      ) : (
        <div
          aria-busy={actualizando}
          className={cn('space-y-4 transition-opacity duration-150', actualizando && 'opacity-60')}
        >
          <EnPocasPalabras tablero={t} />
          {t.individual ? (
            <FichaConductor individual={t.individual} onVolver={() => cambiar({ conductor: undefined })} />
          ) : null}
          {t.individual ? <CifrasIndividuales individual={t.individual} /> : <CifrasDelGrupo tablero={t} />}
          <Graficas tablero={t} />
          <TablaDeConductores
            filas={t.conductores}
            elegido={filtros.conductor}
            onElegir={(id) => cambiar({ conductor: id === filtros.conductor ? undefined : id })}
          />
        </div>
      )}

      <ExportQueue />
    </div>
  );
}

/* ---------------------------------------------------------------- filtros --- */

function BarraDeFiltros({
  filtros,
  opciones,
  hoy,
  hayFiltros,
  cambiar,
}: {
  filtros: FiltrosDeInforme;
  opciones?: OpcionesDeInforme;
  hoy: string;
  hayFiltros: boolean;
  cambiar: (cambios: Partial<FiltrosDeInforme>) => void;
}) {
  const periodo = periodoDelRango(filtros.desde, filtros.hasta, hoy);
  // Con «Solo veredas» la lista de sectores muestra solo veredas: elegir un
  // sector urbano ahí dejaría el tablero vacío sin explicación.
  const zonas = (opciones?.zonas ?? []).filter((z) => !filtros.tipoZona || z.tipo === filtros.tipoZona);
  // Sin pruebas, las cuentas de prueba no se ofrecen: elegir una mostraría
  // un tablero vacío.
  const conductores = (opciones?.conductores ?? []).filter((c) => !filtros.sinPruebas || !c.esPrueba);

  return (
    <Card className="flex flex-wrap items-center gap-2">
      <Segmented<PeriodoRapido | 'personalizado'>
        ink
        value={periodo ?? 'personalizado'}
        onChange={(p) => {
          if (p !== 'personalizado') cambiar(rangoDePeriodo(p, hoy));
        }}
        options={PERIODOS_RAPIDOS.map((p) => ({ value: p, label: ETIQUETA_PERIODO[p] }))}
      />

      <RangoDeFechas desde={filtros.desde} hasta={filtros.hasta} hoy={hoy} onCambiar={cambiar} />

      <FiltroMultiple
        etiqueta="Sector"
        textoTodos="todos"
        opciones={zonas.map((z) => ({ valor: z.id, texto: z.nombre, detalle: z.tipo === 'rural' ? 'Vereda' : 'Casco urbano' }))}
        valores={filtros.zonas ?? []}
        onCambiar={(zonasElegidas) => cambiar({ zonas: zonasElegidas })}
      />

      <FiltroUnico<'urbano' | 'rural'>
        etiqueta="Zona"
        textoTodos="Casco urbano y veredas"
        sinEtiquetaCuandoTodos
        opciones={[
          { valor: 'urbano', texto: 'Solo casco urbano' },
          { valor: 'rural', texto: 'Solo veredas' },
        ]}
        valor={filtros.tipoZona}
        onCambiar={(tipo) =>
          cambiar({
            tipoZona: tipo,
            // Los sectores que ya no son de ese tipo se sueltan.
            zonas: (filtros.zonas ?? []).filter((id) => !tipo || opciones?.zonas.find((z) => z.id === id)?.tipo === tipo),
          })
        }
      />

      <FiltroUnico
        etiqueta="Conductor"
        textoTodos="todos"
        opciones={conductores.map((c) => ({
          valor: c.id,
          texto: `${c.codigo} · ${c.nombre}`,
          detalle: c.esPrueba ? 'Cuenta de prueba' : !c.activo ? 'Inactivo' : undefined,
        }))}
        valor={filtros.conductor}
        onCambiar={(conductor) => cambiar({ conductor })}
      />

      <FiltroMultiple
        etiqueta="Línea"
        textoTodos="todas"
        opciones={(opciones?.lineas ?? []).map((l) => ({ valor: l, texto: l }))}
        valores={filtros.lineas ?? []}
        onCambiar={(lineas) => cambiar({ lineas })}
      />

      <div className="ml-auto flex items-center gap-4">
        {hayFiltros ? (
          <button
            type="button"
            onClick={() =>
              cambiar({ zonas: [], tipoZona: undefined, conductor: undefined, lineas: [], sinPruebas: true })
            }
            className="text-caption font-medium text-accent-ink hover:underline"
          >
            Quitar filtros
          </button>
        ) : null}
        <Casilla
          marcada={filtros.sinPruebas}
          onCambiar={(sinPruebas) => cambiar({ sinPruebas })}
          title="Deja fuera las carreras de los teléfonos y las cuentas de conductor marcados como de prueba"
        >
          No incluir pruebas
        </Casilla>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- resumen --- */

function EnPocasPalabras({ tablero }: { tablero: TableroInforme }) {
  return (
    <Card>
      <p className="text-micro font-semibold uppercase tracking-[0.06em] text-ink-muted">En pocas palabras</p>
      <p className="mt-2 max-w-5xl text-lg leading-relaxed text-ink">
        {tablero.enPalabras.map((f, i) =>
          f.fuerte ? (
            <strong key={i} className="font-bold">
              {f.texto}
            </strong>
          ) : (
            <span key={i}>{f.texto}</span>
          ),
        )}
      </p>
      {tablero.recortado ? (
        <p className="mt-2 text-caption text-[var(--t-warning-ink)]">
          Hay más carreras de las que se pueden contar de una vez: las cifras salen de las 50.000 más recientes.
          Acorta el periodo para verlas todas.
        </p>
      ) : null}
    </Card>
  );
}

function FichaConductor({
  individual,
  onVolver,
}: {
  individual: NonNullable<TableroInforme['individual']>;
  onVolver: () => void;
}) {
  const { fila, placas, grupo } = individual;
  return (
    <Card className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand text-lg font-bold text-on-accent">
          {fila.nombre.charAt(0)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold text-ink">{fila.nombre}</p>
          <p className="text-caption text-ink-muted">
            Código {fila.codigo}
            {fila.esPrueba ? ' · Cuenta de prueba' : ''}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {placas.length ? (
          placas.map((p) => (
            <span
              key={p}
              className="rounded-sm border border-ink bg-[var(--plate)] px-1.5 py-0.5 font-mono text-caption font-bold text-ink"
            >
              {p}
            </span>
          ))
        ) : (
          <span className="text-caption text-ink-muted">Sin turnos en el periodo</span>
        )}
      </div>
      <p className="text-caption text-ink-muted">
        Comparado con {grupo.conductores} {grupo.conductores === 1 ? 'conductor' : 'conductores'} con los mismos filtros
      </p>
      <Button size="sm" variant="secondary" icon={<X className="size-3.5" />} onClick={onVolver} className="ml-auto">
        Ver todo el grupo
      </Button>
    </Card>
  );
}

/* ----------------------------------------------------------------- cifras --- */

function Cifras({ children }: { children: ReactNode[] }) {
  return (
    <motion.div
      variants={staggerList(children.length)}
      initial="hidden"
      animate="visible"
      className="grid grid-cols-2 gap-3 xl:grid-cols-4"
    >
      {children.map((c, i) => (
        <motion.div key={i} variants={staggerItem}>
          {c}
        </motion.div>
      ))}
    </motion.div>
  );
}

function CifrasDelGrupo({ tablero }: { tablero: TableroInforme }) {
  const c = tablero.cifras;
  const asignacionOk = c.asignacionP50 === null || c.asignacionP50 <= METAS.asignacionSegundos;
  const llegadaOk = c.llegadaP50 === null || c.llegadaP50 <= METAS.llegadaMinutos * 60;
  const automaticaOk = c.sinIntervencion === null || c.sinIntervencion >= METAS.sinIntervencion;
  const motivo = tablero.cancelaciones[0];
  const tendencia = tablero.porDia.flatMap((d) => (d.sinIntervencion === null ? [] : [d.sinIntervencion * 100]));

  return (
    <Cifras>
      {[
        <Stat
          key="carreras"
          label="Carreras"
          value={c.creadas}
          icon={<Car className="size-3.5" />}
          iconTone="neutral"
          hint={`${numero(c.finalizadas)} terminadas · ${numero(c.canceladas)} canceladas · ${numero(c.enCurso)} abiertas`}
        />,
        <Stat
          key="asignacion"
          label="Conseguir taxi"
          value={dur(c.asignacionP50)}
          tone={c.asignacionP50 === null ? 'neutral' : asignacionOk ? 'positive' : 'critical'}
          icon={<Timer className="size-3.5" />}
          iconTone="info"
          hint={`Mediana · meta 1 min${c.asignacionP95 !== null ? ` · p95 ${duracionCorta(c.asignacionP95)}` : ''}`}
        />,
        <Stat
          key="llegada"
          label="Llegada al cliente"
          value={dur(c.llegadaP50)}
          tone={c.llegadaP50 === null ? 'neutral' : llegadaOk ? 'positive' : 'critical'}
          icon={<MapPin className="size-3.5" />}
          iconTone="info"
          hint={`Mediana, de aceptar a «Llegué» · objetivo ${METAS.llegadaMinutos} min`}
        />,
        <Stat
          key="automatica"
          label="Sin intervención humana"
          value={c.sinIntervencion === null ? '—' : Math.round(c.sinIntervencion * 100)}
          unit={c.sinIntervencion === null ? undefined : '%'}
          tone={c.sinIntervencion === null ? 'neutral' : automaticaOk ? 'positive' : 'critical'}
          icon={<Bot className="size-3.5" />}
          iconTone="positive"
          hint={`Las resolvió el asistente solo · meta ${Math.round(METAS.sinIntervencion * 100)} %`}
          trend={tendencia}
        />,
        <Stat
          key="sin-asignar"
          label="Sin asignar"
          value={c.sinAsignar}
          tone={c.sinAsignar > 0 ? 'critical' : 'positive'}
          icon={<AlertTriangle className="size-3.5" />}
          iconTone="critical"
          hint={c.creadas ? `${pct(c.sinAsignar / c.creadas)} de las carreras se quedaron sin taxi` : 'Agotaron las oleadas'}
        />,
        <Stat
          key="canceladas"
          label="Canceladas"
          value={c.canceladas}
          icon={<Ban className="size-3.5" />}
          iconTone="neutral"
          hint={motivo ? `${pct(c.tasaCancelacion)} · la mayoría: «${motivo.motivo}»` : `${pct(c.tasaCancelacion)} de las carreras`}
        />,
        <Stat
          key="a-bordo"
          label="Duración a bordo"
          value={minutos(c.duracionP50)}
          icon={<Route className="size-3.5" />}
          iconTone="info"
          hint="Mediana de las terminadas, de «Pasajero a bordo» a finalizar"
        />,
        <Stat
          key="conductores"
          label="Conductores activos"
          value={c.conductores}
          icon={<Users className="size-3.5" />}
          iconTone="positive"
          hint={`Con alguna carrera · ${numero(c.kmRecorridos)} km recorridos`}
        />,
      ]}
    </Cifras>
  );
}

/** «6 min frente a 8 min del grupo»: la referencia siempre al lado. */
const frenteAlGrupo = (propio: string, delGrupo: string) => `${propio === '—' ? 'Sin datos' : 'Grupo'}: ${delGrupo}`;

function CifrasIndividuales({ individual }: { individual: NonNullable<TableroInforme['individual']> }) {
  const { fila: f, grupo: g } = individual;
  const mejorQue = (propio: number | null, delGrupo: number | null, menorEsMejor: boolean) =>
    propio === null || delGrupo === null
      ? 'neutral'
      : (menorEsMejor ? propio <= delGrupo : propio >= delGrupo)
        ? 'positive'
        : 'critical';

  return (
    <Cifras>
      {[
        <Stat
          key="tomadas"
          label="Carreras tomadas"
          value={f.asignadas}
          icon={<Car className="size-3.5" />}
          iconTone="neutral"
          hint={`${numero(f.finalizadas)} terminadas · ${numero(f.canceladas)} canceladas`}
        />,
        <Stat
          key="aceptacion"
          label="Aceptación de ofertas"
          value={f.tasaAceptacion === null ? '—' : Math.round(f.tasaAceptacion * 100)}
          unit={f.tasaAceptacion === null ? undefined : '%'}
          tone={mejorQue(f.tasaAceptacion, g.tasaAceptacion, false)}
          icon={<Handshake className="size-3.5" />}
          iconTone="positive"
          hint={`${numero(f.aceptadas)} de ${numero(f.aceptadas + f.rechazadas + f.vencidas)} · grupo ${pct(g.tasaAceptacion)}`}
        />,
        <Stat
          key="llegada"
          label="Llegada al cliente"
          value={dur(f.llegadaP50)}
          tone={mejorQue(f.llegadaP50, g.llegadaP50, true)}
          icon={<MapPin className="size-3.5" />}
          iconTone="info"
          hint={frenteAlGrupo(dur(f.llegadaP50), dur(g.llegadaP50))}
        />,
        <Stat
          key="a-bordo"
          label="Duración a bordo"
          value={minutos(f.duracionP50)}
          icon={<Route className="size-3.5" />}
          iconTone="info"
          hint={frenteAlGrupo(minutos(f.duracionP50), minutos(g.duracionP50))}
        />,
        <Stat
          key="horas"
          label="Horas en turno"
          value={f.horasTurno}
          unit="h"
          icon={<Clock className="size-3.5" />}
          iconTone="neutral"
          hint="Con el turno abierto en el periodo"
        />,
        <Stat
          key="ritmo"
          label="Terminadas por hora"
          value={f.carrerasPorHora ?? '—'}
          tone={mejorQue(f.carrerasPorHora, g.carrerasPorHora, false)}
          icon={<Gauge className="size-3.5" />}
          iconTone="info"
          hint={`Grupo: ${g.carrerasPorHora ?? '—'} · por hora de turno`}
        />,
        <Stat
          key="km"
          label="Km recorridos"
          value={f.km}
          unit="km"
          icon={<Route className="size-3.5" />}
          iconTone="neutral"
          hint={`Grupo: ${g.finalizadasPorConductor ?? '—'} terminadas por conductor`}
        />,
        <Stat
          key="vencidas"
          label="Ofertas sin responder"
          value={f.vencidas}
          tone={f.vencidas > 0 ? 'critical' : 'positive'}
          icon={<Hourglass className="size-3.5" />}
          iconTone="critical"
          hint={`Dejó vencer ${numero(f.vencidas)} · rechazó ${numero(f.rechazadas)}`}
        />,
      ]}
    </Cifras>
  );
}

/* --------------------------------------------------------------- gráficas --- */

const SIN_DATOS_POR_DIA = 'Hace falta más de un día con datos para dibujar la tendencia.';

function PocoDato({ texto = SIN_DATOS_POR_DIA }: { texto?: string }) {
  return <p className="flex h-40 items-center justify-center text-center text-caption text-ink-muted">{texto}</p>;
}

function Graficas({ tablero: t }: { tablero: TableroInforme }) {
  const conAsignacion = t.porDia.filter((d) => d.asignacionP50 !== null);
  const conLlegada = t.porDia.filter((d) => d.llegadaP50 !== null);
  const conAutomatica = t.porDia.filter((d) => d.sinIntervencion !== null);
  const horasDelCalor = Array.from({ length: 24 }, (_, h) => h).filter((h) =>
    t.calor.valores.some((fila) => (fila[h] ?? 0) > 0),
  );

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <ChartFrame
        title="Carreras por día"
        subtitle="Cómo terminó cada carrera, según el día en que se pidió"
        legend={[
          { label: 'Terminadas', color: 'var(--success-fill)' },
          { label: 'Abiertas', color: 'var(--brand)' },
          { label: 'Canceladas', color: 'var(--muted)' },
          { label: 'Sin taxi', color: 'var(--danger-fill)' },
        ]}
        table={
          <DataTable
            head={['Día', 'Total', 'Terminadas', 'Abiertas', 'Canceladas', 'Sin taxi']}
            rows={t.porDia.map((d) => [d.dia, d.carreras, d.finalizadas, d.abiertas, d.canceladas, d.sinAsignar])}
          />
        }
      >
        <StackedBars
          data={t.porDia.map((d) => ({
            label: diaCorto(d.dia),
            values: [d.finalizadas, d.abiertas, d.canceladas, d.sinAsignar],
          }))}
          series={['Terminadas', 'Abiertas', 'Canceladas', 'Sin taxi']}
          colors={['var(--success-fill)', 'var(--brand)', 'var(--muted)', 'var(--danger-fill)']}
        />
      </ChartFrame>

      <ChartFrame
        title="Carreras por hora"
        subtitle="A qué hora se piden, entre casco urbano y veredas"
        legend={[
          { label: 'Urbano', color: 'var(--c-series-1)' },
          { label: 'Rural', color: 'var(--c-series-2)' },
        ]}
        table={
          <DataTable
            head={['Hora', 'Urbano', 'Rural', 'Total']}
            rows={t.porHora.map((h) => [`${h.hora}:00`, h.urbano, h.rural, h.total])}
          />
        }
      >
        <StackedBars
          data={t.porHora.map((h) => ({ label: h.hora, values: [h.urbano, h.rural] }))}
          series={['Urbano', 'Rural']}
        />
      </ChartFrame>

      <ChartFrame
        className="xl:col-span-2"
        title="Picos por día y hora"
        subtitle="Carreras según el día de la semana y la hora en que se pidieron. Lo más oscuro es lo más lleno."
        table={
          <DataTable
            head={['Hora', ...t.calor.dias]}
            rows={horasDelCalor.map((h) => [`${h}:00`, ...t.calor.valores.map((fila) => fila[h] ?? 0)])}
          />
        }
      >
        <MapaDeCalor dias={t.calor.dias} valores={t.calor.valores} />
      </ChartFrame>

      <ChartFrame
        title="Tiempo hasta la asignación"
        subtitle="De crear la carrera a que un conductor la acepte · meta 1 min"
        legend={[
          { label: 'Mediana (p50)', color: 'var(--c-series-1)' },
          { label: 'p95', color: 'var(--danger-fill)' },
        ]}
        table={
          <DataTable
            head={['Día', 'p50', 'p95']}
            rows={conAsignacion.map((d) => [d.dia, dur(d.asignacionP50), dur(d.asignacionP95)])}
          />
        }
      >
        {conAsignacion.length < 2 ? (
          <PocoDato />
        ) : (
          <Lines
            labels={conAsignacion.map((d) => diaCorto(d.dia))}
            series={[
              { name: 'p50', values: conAsignacion.map((d) => d.asignacionP50 ?? 0) },
              {
                name: 'p95',
                values: conAsignacion.map((d) => d.asignacionP95 ?? 0),
                color: 'var(--danger-fill)',
                markMax: true,
              },
            ]}
            unit=" s"
          />
        )}
      </ChartFrame>

      <ChartFrame
        title="Llegada al cliente"
        subtitle={`Minutos de aceptar a «Llegué», mediana por día · objetivo ${METAS.llegadaMinutos} min`}
        table={
          <DataTable head={['Día', 'Mediana']} rows={conLlegada.map((d) => [d.dia, dur(d.llegadaP50)])} />
        }
      >
        {conLlegada.length < 2 ? (
          <PocoDato />
        ) : (
          <Lines
            labels={conLlegada.map((d) => diaCorto(d.dia))}
            series={[
              {
                name: 'Llegada',
                values: conLlegada.map((d) => Math.round(((d.llegadaP50 ?? 0) / 60) * 10) / 10),
                area: 'var(--brand-tint)',
              },
            ]}
            unit=" min"
          />
        )}
      </ChartFrame>

      <ChartFrame
        title="Sin intervención humana"
        subtitle={`Porcentaje que el asistente resolvió de punta a punta · meta ${Math.round(METAS.sinIntervencion * 100)} %`}
        table={
          <DataTable head={['Día', 'Sin ayuda']} rows={conAutomatica.map((d) => [d.dia, pct(d.sinIntervencion)])} />
        }
      >
        {conAutomatica.length < 2 ? (
          <PocoDato />
        ) : (
          <Lines
            labels={conAutomatica.map((d) => diaCorto(d.dia))}
            series={[
              {
                name: 'Sin ayuda',
                values: conAutomatica.map((d) => Math.round((d.sinIntervencion ?? 0) * 100)),
                area: 'var(--success-tint)',
                color: 'var(--success-fill)',
              },
            ]}
            unit=" %"
          />
        )}
      </ChartFrame>

      <ChartFrame
        title="Demanda por sector"
        subtitle="Carreras pedidas en cada sector; la pista verde es vereda"
        table={
          <DataTable
            head={['Sector', 'Carreras', 'Terminadas', 'Canceladas']}
            rows={t.porZona.map((z) => [z.zona, z.carreras, z.finalizadas, z.canceladas])}
          />
        }
      >
        {t.porZona.length === 0 ? (
          <PocoDato texto="Sin carreras en el periodo." />
        ) : (
          <HorizontalBars
            data={t.porZona.map((z) => ({
              label: z.zona,
              value: z.carreras,
              hint: `${z.finalizadas} terminadas · ${z.canceladas} canceladas${z.tipo === 'rural' ? ' · vereda' : ''}`,
              rural: z.tipo === 'rural',
            }))}
          />
        )}
      </ChartFrame>

      <ChartFrame
        title="Por línea de WhatsApp"
        subtitle="Qué línea recibió cada pedido y cuántos resolvió el asistente solo"
        table={
          <DataTable
            head={['Línea', 'Carreras', 'Terminadas', 'Sin ayuda']}
            rows={t.porLinea.map((l) => [l.linea, l.carreras, l.finalizadas, pct(l.sinIntervencion)])}
          />
        }
      >
        {t.porLinea.length === 0 ? (
          <PocoDato texto="Sin carreras en el periodo." />
        ) : (
          <HorizontalBars
            data={t.porLinea.map((l) => ({
              label: l.linea,
              value: l.carreras,
              hint: `${l.finalizadas} terminadas · ${pct(l.sinIntervencion)} sin ayuda`,
            }))}
          />
        )}
      </ChartFrame>

      <ChartFrame
        title="Motivos de cancelación"
        subtitle="Lo que escribió quien canceló; los motivos repetidos dicen qué arreglar"
        table={<DataTable head={['Motivo', 'Carreras']} rows={t.cancelaciones.map((c) => [c.motivo, c.carreras])} />}
      >
        {t.cancelaciones.length === 0 ? (
          <PocoDato texto="Ninguna carrera cancelada en el periodo." />
        ) : (
          <HorizontalBars
            color="var(--muted)"
            data={t.cancelaciones.slice(0, 8).map((c) => ({ label: c.motivo, value: c.carreras }))}
          />
        )}
      </ChartFrame>
    </div>
  );
}

/* ------------------------------------------------------------ conductores --- */

type Orden = keyof Pick<
  FilaConductorInforme,
  | 'asignadas'
  | 'finalizadas'
  | 'canceladas'
  | 'tasaAceptacion'
  | 'llegadaP50'
  | 'duracionP50'
  | 'km'
  | 'horasTurno'
  | 'carrerasPorHora'
>;

const COLUMNAS: { clave: Orden; titulo: string; ayuda: string; ver: (c: FilaConductorInforme) => string }[] = [
  { clave: 'asignadas', titulo: 'Tomadas', ayuda: 'Carreras que aceptó, terminaran como terminaran', ver: (c) => numero(c.asignadas) },
  { clave: 'finalizadas', titulo: 'Terminadas', ayuda: 'Carreras que finalizó', ver: (c) => numero(c.finalizadas) },
  { clave: 'canceladas', titulo: 'Canceladas', ayuda: 'Se cancelaron después de que él la aceptara', ver: (c) => numero(c.canceladas) },
  {
    clave: 'tasaAceptacion',
    titulo: 'Aceptación',
    ayuda: 'Ofertas aceptadas sobre las que respondió o dejó vencer; las que tomó otro no cuentan',
    // «73 % · 63/86»: el porcentaje y de dónde sale, sin las que tomó otro.
    ver: (c) => {
      const respondidas = c.aceptadas + c.rechazadas + c.vencidas;
      return respondidas ? `${pct(c.tasaAceptacion)} · ${c.aceptadas}/${respondidas}` : '—';
    },
  },
  { clave: 'llegadaP50', titulo: 'Llegada', ayuda: 'Mediana de aceptar a «Llegué»', ver: (c) => dur(c.llegadaP50) },
  { clave: 'duracionP50', titulo: 'A bordo', ayuda: 'Mediana con el pasajero a bordo', ver: (c) => minutos(c.duracionP50) },
  { clave: 'km', titulo: 'Km', ayuda: 'Kilómetros de las carreras terminadas', ver: (c) => numero(c.km) },
  { clave: 'horasTurno', titulo: 'Horas', ayuda: 'Horas con turno abierto en el periodo, sin mirar zona ni línea', ver: (c) => numero(c.horasTurno) },
  { clave: 'carrerasPorHora', titulo: 'Por hora', ayuda: 'Terminadas por hora de turno', ver: (c) => (c.carrerasPorHora === null ? '—' : numero(c.carrerasPorHora)) },
];

function TablaDeConductores({
  filas,
  elegido,
  onElegir,
}: {
  filas: FilaConductorInforme[];
  elegido?: string;
  onElegir: (id: string) => void;
}) {
  const [orden, setOrden] = useState<{ clave: Orden; desc: boolean }>({ clave: 'finalizadas', desc: true });

  const ordenadas = [...filas].sort((a, b) => {
    const x = a[orden.clave];
    const y = b[orden.clave];
    // Sin dato va siempre al final, ordene como ordene.
    if (x === null) return 1;
    if (y === null) return -1;
    return orden.desc ? y - x : x - y;
  });

  return (
    <Card className="space-y-3">
      <CardHeader
        title="Conductores"
        subtitle="Toca un conductor para ver su tablero y compararlo con el grupo. Toca una columna para ordenar."
      />

      {filas.length === 0 ? (
        <EmptyState
          icon={<Users className="size-4" />}
          title="Ningún conductor con actividad"
          description="Nadie tomó carreras, recibió ofertas ni abrió turno con estos filtros."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-caption">
            <thead>
              <tr className="border-b border-line text-micro uppercase tracking-[0.06em] text-ink-muted">
                <th className="py-2 pr-3 font-medium">Conductor</th>
                {COLUMNAS.map((col) => (
                  <th key={col.clave} className="py-2 pl-3 text-right font-medium" title={col.ayuda}>
                    <button
                      type="button"
                      onClick={() =>
                        setOrden((o) => ({ clave: col.clave, desc: o.clave === col.clave ? !o.desc : true }))
                      }
                      className={cn(
                        'inline-flex items-center gap-1 uppercase hover:text-ink',
                        orden.clave === col.clave && 'text-ink',
                      )}
                    >
                      {col.titulo}
                      {orden.clave === col.clave ? (
                        orden.desc ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ArrowUp className="size-3" />
                        )
                      ) : null}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ordenadas.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => onElegir(c.id)}
                  aria-selected={c.id === elegido}
                  className={cn(
                    'cursor-pointer border-b border-line last:border-0',
                    'transition-colors duration-150 ease-[var(--ease-standard)]',
                    c.id === elegido ? 'bg-accent-soft' : 'hover:bg-surface-sunk',
                  )}
                >
                  <td className="py-2 pr-3">
                    <span className="font-mono text-ink-muted">{c.codigo}</span>{' '}
                    <span className={cn('text-ink', c.id === elegido && 'font-semibold')}>{c.nombre}</span>
                    {c.esPrueba ? (
                      <span className="ml-1.5 rounded-xs bg-[var(--t-warning-bg)] px-1 text-micro text-[var(--t-warning-ink)]">
                        prueba
                      </span>
                    ) : null}
                  </td>
                  {COLUMNAS.map((col) => (
                    <td key={col.clave} className="py-2 pl-3 text-right tnum text-ink">
                      {col.ver(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* --------------------------------------------------------------- esqueleto --- */

function Esqueleto() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-24" />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ exportaciones --- */

const tamano = (bytes: number | null) =>
  bytes === null ? '' : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Lo que se ha exportado en los últimos siete días, de cualquiera de la oficina. */
function ExportQueue() {
  const exportaciones = useExportaciones();
  const { push } = useToast();
  const [bajando, setBajando] = useState<string | null>(null);
  const filas = exportaciones.data ?? [];

  const descargar = async (e: Exportacion) => {
    setBajando(e.id);
    try {
      await descargarExportacion(e);
    } catch (causa) {
      push({
        tone: 'critical',
        title: 'No se pudo descargar',
        description: causa instanceof ApiError ? causa.message : undefined,
      });
    } finally {
      setBajando(null);
    }
  };

  return (
    <Card className="space-y-3">
      <CardHeader
        title="Exportaciones"
        subtitle="Se generan en segundo plano para no frenar la operación"
      />

      {exportaciones.isLoading ? (
        <Skeleton className="h-24" />
      ) : filas.length === 0 ? (
        <EmptyState
          icon={<FileSpreadsheet className="size-4" />}
          title="Nada exportado esta semana"
          description="Los botones Descargar Excel y Descargar informe PDF de arriba, y Exportar en Carreras, dejan aquí sus archivos."
        />
      ) : (
        <ul className="space-y-1.5">
          {filas.map((e) => (
            <li key={e.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2.5">
              {e.status === 'ready' ? (
                <CheckCircle2 className="size-4 shrink-0 text-[var(--t-positive-ink)]" />
              ) : e.status === 'failed' ? (
                <AlertTriangle className="size-4 shrink-0 text-[var(--t-critical-ink)]" />
              ) : (
                <Loader2 className="size-4 shrink-0 animate-spin text-ink-muted" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-base text-ink">
                  {e.title}
                  <span className="ml-1.5 font-mono text-micro uppercase text-ink-muted">{e.format}</span>
                </p>
                <p
                  className={
                    e.status === 'failed' ? 'text-micro text-[var(--t-critical-ink)]' : 'text-micro text-ink-muted'
                  }
                >
                  {e.status === 'failed'
                    ? `Falló: ${e.error ?? 'sin detalle'}`
                    : e.status === 'ready'
                      ? `${formatRelative(e.createdAt)} · ${e.requestedByName} · ${tamano(e.sizeBytes)}`
                      : `Generando · pedido por ${e.requestedByName}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={e.status !== 'ready'}
                loading={bajando === e.id}
                icon={<Download className="size-3.5" />}
                onClick={() => void descargar(e)}
              >
                Descargar
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-micro text-ink-muted">
        Se guardan 7 días y luego se borran solas. Llevan nombres y teléfonos de clientes: compártelas
        solo con quien las necesite.
      </p>
    </Card>
  );
}
