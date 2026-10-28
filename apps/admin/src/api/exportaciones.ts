import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RideStatus } from '@tax/shared';
import { useToast } from '@tax/ui';
import { ApiError, api } from './client';

/**
 * Exportaciones a Excel y PDF (§4.1).
 *
 * La API las genera en segundo plano y las guarda siete días. Pedir una
 * espera aquí a que esté lista y la descarga sola; si la persona se va a otra
 * página mientras tanto, la descarga y el aviso llegan igual, y además queda
 * en *Reportes › Exportaciones* para bajarla otra vez.
 */

export interface Exportacion {
  id: string;
  kind: 'resumen' | 'carreras';
  format: 'xlsx' | 'pdf';
  title: string;
  fileName: string;
  status: 'pending' | 'running' | 'ready' | 'failed';
  error: string | null;
  sizeBytes: number | null;
  requestedByName: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface SolicitudExportacion {
  kind: Exportacion['kind'];
  format: Exportacion['format'];
  /** Desde *Carreras*: hacia atrás desde ahora; 1 son las últimas 24 horas. */
  days?: number;
  /** Desde *Reportes*: los días del tablero, con los dos extremos. */
  desde?: string;
  hasta?: string;
  statuses?: RideStatus[];
  zoneId?: string;
  query?: string;
  /** Los filtros del tablero de Reportes. */
  zoneIds?: string[];
  zoneKind?: 'urbano' | 'rural';
  driverId?: string;
  lines?: string[];
  excludeTests?: boolean;
  /** El nombre del filtro en el panel, para el título del archivo. */
  filterLabel?: string;
}

const enMarcha = (e: Exportacion) => e.status === 'pending' || e.status === 'running';

export function useExportaciones() {
  return useQuery({
    queryKey: ['exportaciones'],
    queryFn: () => api.get<Exportacion[]>('/v1/reports/exports'),
    // Mientras alguna se está generando se pregunta seguido; si no, nada.
    refetchInterval: (query) => (query.state.data?.some(enMarcha) ? 1500 : false),
  });
}

export const descargarExportacion = (e: Exportacion) =>
  api.download(`/v1/reports/exports/${e.id}/file`, e.fileName);

const NOMBRE_FORMATO: Record<Exportacion['format'], string> = { xlsx: 'Excel', pdf: 'PDF' };

export function useExportar() {
  const qc = useQueryClient();
  const { push } = useToast();
  const [generando, setGenerando] = useState<string[]>([]);

  const exportar = async (solicitud: SolicitudExportacion, clave = `${solicitud.kind}-${solicitud.format}`) => {
    const formato = NOMBRE_FORMATO[solicitud.format];
    setGenerando((actuales) => [...actuales, clave]);

    try {
      let fila = await api.post<Exportacion>('/v1/reports/exports', solicitud);
      void qc.invalidateQueries({ queryKey: ['exportaciones'] });

      // Un informe de un mes tarda segundos; dos minutos es que algo se atascó.
      const limite = Date.now() + 120_000;
      while (enMarcha(fila) && Date.now() < limite) {
        await new Promise((resolver) => setTimeout(resolver, 800));
        fila = await api.get<Exportacion>(`/v1/reports/exports/${fila.id}`);
      }
      void qc.invalidateQueries({ queryKey: ['exportaciones'] });

      if (fila.status === 'ready') {
        await descargarExportacion(fila);
        push({
          tone: 'positive',
          title: `${formato} listo`,
          description: `${fila.title}. Queda también en Reportes › Exportaciones durante 7 días.`,
        });
      } else if (fila.status === 'failed') {
        push({ tone: 'critical', title: `No se pudo generar el ${formato}`, description: fila.error ?? undefined });
      } else {
        push({
          tone: 'info',
          title: `El ${formato} sigue generándose`,
          description: 'Cuando termine aparecerá en Reportes › Exportaciones.',
        });
      }
    } catch (causa) {
      push({
        tone: 'critical',
        title: `No se pudo generar el ${formato}`,
        description: causa instanceof ApiError ? causa.message : undefined,
      });
    } finally {
      setGenerando((actuales) => actuales.filter((c) => c !== clave));
    }
  };

  return { exportar, generando: (clave: string) => generando.includes(clave) };
}
