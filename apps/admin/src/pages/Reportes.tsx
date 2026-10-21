import { useState } from 'react';
import { motion } from 'motion/react';
import { CheckCircle2, Download, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import { formatMoney } from '@tax/shared';
import {
  Button,
  Card,
  CardHeader,
  Segmented,
  Skeleton,
  Stat,
  staggerItem,
  staggerList,
  useToast,
} from '@tax/ui';
import { ChartFrame, DataTable, HorizontalBars, Lines, StackedBars } from '../components/charts';
import {
  useAssignmentTimes,
  useAutomationRate,
  useDemandByZone,
  useRidesByHour,
} from '../api/queries';
import { useLive } from '../live/store';

type Range = '7d' | '30d' | 'hoy';

const DAYS: Record<Range, number> = { hoy: 1, '7d': 7, '30d': 30 };

export function Reportes() {
  const [range, setRange] = useState<Range>('7d');
  const rides = useLive((s) => s.rides);
  const { push } = useToast();

  const days = DAYS[range];
  const ridesByHour = useRidesByHour(range === 'hoy' ? 1 : days);
  const assignment = useAssignmentTimes(days);
  const demand = useDemandByZone(days);
  const automation = useAutomationRate(days);

  const completed = rides.filter((r) => r.status === 'COMPLETED');
  const billed = completed.reduce((sum, r) => sum + r.fareEstimate, 0);

  // Las series llegan de la API; mientras tanto se dibuja el esqueleto en vez
  // de una gráfica vacía, que se leería como «no hubo carreras».
  const hourly = ridesByHour.data ?? [];
  const assignmentSeconds = assignment.data ?? [];
  const zoneDemand = demand.data ?? [];
  const automationRate = automation.data ?? [];
  const cargando =
    ridesByHour.isLoading || assignment.isLoading || demand.isLoading || automation.isLoading;

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
        <div className="flex gap-2">
          <Button
            icon={<FileSpreadsheet className="size-3.5" />}
            onClick={() =>
              push({
                tone: 'info',
                title: 'Excel en cola',
                description: 'Se genera en segundo plano; avisamos al terminar.',
              })
            }
          >
            Excel
          </Button>
          <Button
            icon={<FileText className="size-3.5" />}
            onClick={() =>
              push({
                tone: 'info',
                title: 'PDF en cola',
                description: 'Se genera en segundo plano; avisamos al terminar.',
              })
            }
          >
            PDF
          </Button>
        </div>
      </div>

      <motion.div
        variants={staggerList(4)}
        initial="hidden"
        animate="visible"
        className="grid grid-cols-2 gap-3 xl:grid-cols-4"
      >
        <motion.div variants={staggerItem}>
          <Stat label="Carreras finalizadas" value={completed.length} hint="En el periodo" />
        </motion.div>
        <motion.div variants={staggerItem}>
          <Stat label="Facturación estimada" value={formatMoney(billed)} tone="positive" hint="Suma de tarifas" />
        </motion.div>
        <motion.div variants={staggerItem}>
          <Stat
            label="Tiempo medio a recogida"
            value={8.4}
            unit="min"
            tone="info"
            hint="Objetivo de la empresa: 10 min"
          />
        </motion.div>
        <motion.div variants={staggerItem}>
          <Stat
            label="Sin intervención humana"
            value={83}
            unit="%"
            tone="progress"
            hint="Meta inicial 80 %"
            trend={automationRate.map((d) => d.rate * 100)}
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
                hint: d.kind === 'rural' ? 'Vereda · tarifa rural' : undefined,
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

/** Las exportaciones pesadas corren en segundo plano y aparecen aquí. */
function ExportQueue() {
  const jobs = [
    { id: 'j-3', name: 'Carreras · octubre 2026.xlsx', status: 'ready', size: '248 KB', at: 'hace 4 min' },
    { id: 'j-2', name: 'Tiempos de asignación · semana 42.pdf', status: 'running', size: '—', at: 'en curso' },
    { id: 'j-1', name: 'Liquidación conductores · semana 41.xlsx', status: 'ready', size: '612 KB', at: 'ayer' },
  ] as const;

  return (
    <Card className="space-y-3">
      <CardHeader
        title="Exportaciones"
        subtitle="Se generan en segundo plano para no frenar la operación"
      />
      <ul className="space-y-1.5">
        {jobs.map((job) => (
          <li
            key={job.id}
            className="flex items-center gap-3 rounded-md border border-line px-3 py-2.5"
          >
            {job.status === 'running' ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-ink-muted" />
            ) : (
              <CheckCircle2 className="size-4 shrink-0 text-[var(--t-positive-ink)]" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-base text-ink">{job.name}</p>
              <p className="text-micro text-ink-muted">
                {job.at} · {job.size}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={job.status === 'running'}
              icon={<Download className="size-3.5" />}
            >
              Descargar
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-micro text-ink-muted">
        <span className="font-semibold uppercase tracking-[0.07em]">URL firmada</span> · los archivos
        se sirven desde un volumen privado con enlaces que caducan a los 10 minutos.
      </p>
    </Card>
  );
}
