import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import type { FiltrosDeInforme, OpcionesDeInforme, TableroInforme } from '@tax/shared';
import { MAX_DIAS_INFORME, diasDelRango, hoyEnPaipa, rangoDePeriodo } from '@tax/shared';
import { api } from './client';

/**
 * El tablero de Reportes.
 *
 * Los filtros viven en la dirección de la página, no en la memoria del
 * componente: recargar no los borra, el botón «atrás» deshace el último
 * cambio y un tablero filtrado se puede pasar a otra persona de la oficina.
 * Sin nada en la dirección se ven los últimos 7 días, sin pruebas.
 */

const UUID = /^[0-9a-f-]{36}$/i;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

function lista(valor: string | null, valida: (v: string) => boolean = () => true): string[] {
  return (valor ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v && valida(v));
}

export function useFiltrosDeInforme() {
  const [params, setParams] = useSearchParams();

  const filtros = useMemo<FiltrosDeInforme>(() => {
    const porDefecto = rangoDePeriodo('7d');
    let desde = params.get('desde') ?? '';
    let hasta = params.get('hasta') ?? '';
    // Una dirección rota o un periodo imposible no deja la página en blanco:
    // vuelve a los últimos 7 días.
    if (!FECHA.test(desde) || !FECHA.test(hasta) || desde > hasta || diasDelRango(desde, hasta) > MAX_DIAS_INFORME) {
      ({ desde, hasta } = porDefecto);
    }
    const tipo = params.get('tipo');
    const conductor = params.get('conductor');
    return {
      desde,
      hasta,
      zonas: lista(params.get('zonas'), (v) => UUID.test(v)),
      tipoZona: tipo === 'urbano' || tipo === 'rural' ? tipo : undefined,
      conductor: conductor && UUID.test(conductor) ? conductor : undefined,
      lineas: lista(params.get('lineas')),
      sinPruebas: params.get('pruebas') !== 'si',
    };
  }, [params]);

  const cambiar = (cambios: Partial<FiltrosDeInforme>) => {
    const siguiente = { ...filtros, ...cambios };
    const nuevos = new URLSearchParams();
    const porDefecto = rangoDePeriodo('7d');
    if (siguiente.desde !== porDefecto.desde || siguiente.hasta !== porDefecto.hasta) {
      nuevos.set('desde', siguiente.desde);
      nuevos.set('hasta', siguiente.hasta);
    }
    if (siguiente.zonas?.length) nuevos.set('zonas', siguiente.zonas.join(','));
    if (siguiente.tipoZona) nuevos.set('tipo', siguiente.tipoZona);
    if (siguiente.conductor) nuevos.set('conductor', siguiente.conductor);
    if (siguiente.lineas?.length) nuevos.set('lineas', siguiente.lineas.join(','));
    if (!siguiente.sinPruebas) nuevos.set('pruebas', 'si');
    setParams(nuevos);
  };

  const hayFiltros = Boolean(
    filtros.zonas?.length || filtros.tipoZona || filtros.conductor || filtros.lineas?.length || !filtros.sinPruebas,
  );

  return { filtros, cambiar, hayFiltros, hoy: hoyEnPaipa() };
}

export function aConsulta(f: FiltrosDeInforme): string {
  const q = new URLSearchParams({ desde: f.desde, hasta: f.hasta, sinPruebas: String(f.sinPruebas) });
  if (f.zonas?.length) q.set('zonas', f.zonas.join(','));
  if (f.tipoZona) q.set('tipoZona', f.tipoZona);
  if (f.conductor) q.set('conductor', f.conductor);
  if (f.lineas?.length) q.set('lineas', f.lineas.join(','));
  return q.toString();
}

export function useTablero(filtros: FiltrosDeInforme) {
  const consulta = aConsulta(filtros);
  return useQuery({
    queryKey: ['reports', 'dashboard', consulta],
    queryFn: () => api.get<TableroInforme>(`/v1/reports/dashboard?${consulta}`),
    staleTime: 60_000,
    // Al cambiar un filtro se sigue viendo el tablero anterior, atenuado,
    // hasta que llega el nuevo: sin parpadeo a esqueletos en cada clic.
    placeholderData: keepPreviousData,
  });
}

export function useOpcionesDeInforme() {
  return useQuery({
    queryKey: ['reports', 'filters'],
    queryFn: () => api.get<OpcionesDeInforme>('/v1/reports/filters'),
    staleTime: 5 * 60_000,
  });
}
