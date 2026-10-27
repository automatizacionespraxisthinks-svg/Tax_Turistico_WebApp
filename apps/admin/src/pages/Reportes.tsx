import { useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import { formatRelative } from '@tax/shared';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Segmented,
  Skeleton,
  Stat,
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
import { ChartFrame, DataTable, HorizontalBars, Lines, StackedBars } from '../components/charts';
import {
  useAssignmentTimes,
  useAutomationRate,
  useDemandByZone,
  useReportSummary,
  useRidesByHour,
} from '../api/queries';

type Range = '7d' | '30d' | 'hoy';

const DAYS: Record<Range, number> = { hoy: 1, '7d': 7, '30d': 30 };

export function Reportes() {
  const [range, setRange] = useState<Range>('7d');
  const { exportar, generando } = useExportar();

  const days = DAYS[range];
  const resumen = useReportSummary(days);
  const ridesByHour = useRidesByHour(range === 'hoy' ? 1 : days);
  const assignment = useAssignmentTimes(days);
  const demand = useDemandByZone(days);
  const automation = useAutomationRate(days);

  // Las series llegan de la API; mientras tanto se dibuja el esqueleto en vez
  // de una gráfica vacía, que se leería como «no hubo carreras».
  const hourly = ridesByHour.data ?? [];
  const assignmentSeconds = assignment.data ?? [];
  const zoneDemand = demand.data ?? [];
  const automationRate = automation.data ?? [];
  const cargando =
    ridesByHour.isLoading || assignment.isLoading || demand.isLoading || automation.isLoading;
  const r = resumen.data;

  return (
    <div className="space-y-4 p-5">
      {/* Los filtros van en una sola fila, encima de todas las gráficas. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={range}
          onChange={setRange}
          options={[
            { value: 'hoy', label: 'Hoy' },
            { value: '7d', label: '7 días' },
            { value: '30d', label: '30 días' },
          ]}
        />
        {/* Del periodo elegido arriba: lo mismo que se está viendo. */}
        <div className="flex gap-2">
          <Button
            icon={<FileSpreadsheet className="size-3.5" />}
            loading={generando('resumen-xlsx')}
            title="Todas las carreras del periodo, y las tablas por conductor, zona, día y hora"
            onClick={() => void exportar({ kind: 'resumen', format: 'xlsx', days })}
          >
            Excel
          </Button>
          <Button
            icon={<FileText className="size-3.5" />}
            loading={generando('resumen-pdf')}
            title="Resumen del periodo para imprimir o enviar"
            onClick={() => void exportar({ kind: 'resumen', format: 'pdf', days })}
          >
            PDF
          </Button>
        </div>
      </div>

      {/*
        Las cifras salen de la API con la misma cuenta que el Excel y el PDF.
        Antes dos eran números fijos (8,4 min y 83 %) y otra contaba solo las
        carreras cargadas en pantalla; ahora todas son del periodo elegido.
      */}
      <motion.div
        variants={staggerList(8)}
        initial="hidden"
        animate="visible"
        className="grid grid-cols-2 gap-3 xl:grid-cols-4"
      >
        <motion.div variants={staggerItem}>
          <Stat
            label="Carreras"
            value={r?.creadas ?? 0}
            hint={r ? `${r.finalizadas} finalizadas · ${r.canceladas} canceladas` : 'En el periodo'}
          />
        </motion.div>
        <motion.div variants={staggerItem}>
          <Stat
            label="Hora pico"
            value={r?.horaPico ? `${r.horaPico.hora}:00` : '—'}
            tone="warning"
            hint={r?.horaPico ? `${r.horaPico.carreras} carreras en esa hora` : 'Sin carreras en el periodo'}
          />
        </motion.div>
        <motion.div variants={staggerItem}>
          <Stat
            label="Llegada al cliente"
            value={r?.llegadaP50 != null ? Math.round(r.llegadaP50 / 6) / 10 : 0}
            unit="min"
            tone="info"
            hint="Mediana, de aceptar a «Llegué» · objetivo 10 min"
          />
        </motion.div>
        <motion.div variants={staggerItem}>
          <Stat
            label="Sin intervención humana"
            value={r?.sinIntervencion != null ? Math.round(r.sinIntervencion * 100) : 0}
            unit="%"
            tone="progress"
            hint="Meta inicial 80 %"
            trend={automationRate.map((d) => d.rate * 100)}
          />
        </motion.div>
        <motion.div variants={staggerItem}>
          <Stat
            label="Asignación"
            value={r?.asignacionP50 ?? 0}
            unit="s"
            hint="Mediana, de crearla a que un conductor la acepte"
          />
        </motion.div>
        <motion.div variants={staggerItem}>
          <Stat
            label="Duración a bordo"
            value={r?.duracionP50 ?? 0}
            unit="min"
            hint="Mediana de las carreras finalizadas"
          />
        </motion.div>
        <motion.div variants={staggerItem}>
          <Stat
            label="Sin asignar"
            value={r?.sinAsignar ?? 0}
            tone={(r?.sinAsignar ?? 0) > 0 ? 'critical' : 'positive'}
            hint="Agotaron las oleadas sin conductor"
          />
        </motion.div>
        <motion.div variants={staggerItem}>
          <Stat
            label="Conductores activos"
            value={r?.conductores ?? 0}
            hint={r ? `${r.kmRecorridos.toLocaleString('es-CO')} km recorridos` : 'Con alguna carrera'}
          />
        </motion.div>
      </motion.div>

      <div className="grid gap-3 xl:grid-cols-2">
        <ChartFrame
          title="Carreras por hora"
          subtitle="Distribución del día entre zona urbana y veredas"
          legend={[
            { label: 'Urbano', color: 'var(--c-series-1)' },
            { label: 'Rural', color: 'var(--c-series-2)' },
          ]}
          table={
            <DataTable
              head={['Hora', 'Urbano', 'Rural', 'Total']}
              rows={hourly.map((d) => [d.hour, d.urbano, d.rural, d.urbano + d.rural])}
            />
          }
        >
          {cargando ? (
            <Skeleton className="h-50" />
          ) : (
            <StackedBars
              data={hourly.map((d) => ({ label: d.hour, values: [d.urbano, d.rural] }))}
              series={['Urbano', 'Rural']}
            />
          )}
        </ChartFrame>

        <ChartFrame
          title="Tiempo hasta la asignación"
          subtitle="Segundos entre crear la carrera y que un conductor la acepte"
          legend={[
            { label: 'Mediana (p50)', color: 'var(--c-series-1)' },
            { label: 'p95', color: 'var(--c-series-2)' },
          ]}
          table={
            <DataTable
              head={['Día', 'p50 (s)', 'p95 (s)']}
              rows={assignmentSeconds.map((d) => [d.day, d.p50, d.p95])}
            />
          }
        >
          {cargando || assignmentSeconds.length === 0 ? (
            <Skeleton className="h-50" />
          ) : (
            <Lines
              labels={assignmentSeconds.map((d) => d.day.slice(5))}
              series={[
                { name: 'p50', values: assignmentSeconds.map((d) => d.p50) },
                { name: 'p95', values: assignmentSeconds.map((d) => d.p95) },
              ]}
              unit=" s"
            />
          )}
        </ChartFrame>

        <ChartFrame
          title="Demanda por zona"
          subtitle="Carreras atendidas en el periodo"
          table={
            <DataTable head={['Zona', 'Carreras']} rows={zoneDemand.map((d) => [d.zone, d.rides])} />
          }
        >
          {cargando ? (
            <Skeleton className="h-40" />
          ) : (
            <HorizontalBars
              data={zoneDemand.map((d) => ({
                label: d.zone,
                value: d.rides,
                hint: d.kind === 'rural' ? 'Vereda' : undefined,
              }))}
            />
          )}
        </ChartFrame>

        <ChartFrame
          title="Carreras sin intervención humana"
          subtitle="Porcentaje que el agente resolvió de punta a punta"
          table={
            <DataTable
              head={['Día', 'Automatizadas (%)']}
              rows={automationRate.map((d) => [d.day, Math.round((d.rate ?? 0) * 100)])}
            />
          }
        >
          {cargando || automationRate.length === 0 ? (
            <Skeleton className="h-50" />
          ) : (
            <Lines
              labels={automationRate.map((d) => d.day.slice(5))}
              series={[
                {
                  name: 'Automatizadas',
                  values: automationRate.map((d) => Math.round((d.rate ?? 0) * 100)),
                },
              ]}
              unit=" %"
            />
          )}
        </ChartFrame>
      </div>

      <ExportQueue />
    </div>
  );
}

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
          description="Los botones Excel y PDF de arriba, y Exportar en Carreras, dejan aquí sus archivos."
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
