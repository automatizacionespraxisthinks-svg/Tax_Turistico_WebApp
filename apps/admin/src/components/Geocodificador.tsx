import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPinned, RefreshCw } from 'lucide-react';
import { formatDateTime, formatRelative } from '@tax/shared';
import { Banner, Button, SectionLabel, Sheet, StatusPill, useToast } from '@tax/ui';
import { ApiError, api } from '../api/client';
import { usePuede } from '../api/queries';

/**
 * El geocodificador de Google, a la vista como las líneas de WhatsApp.
 *
 * Es lo que convierte en un punto del mapa la dirección que el cliente
 * escribe. Sin él —sin clave, o con la clave rechazada— toda dirección
 * escrita queda «sin ubicar» y se despacha desde el punto de partida, y eso
 * no se nota hasta que un taxi llega a donde no era. Por eso va arriba, junto
 * a las líneas, y con letrero rojo si deja de funcionar.
 */

interface Prueba {
  en: string;
  direccion: string;
  ms: number;
  resultado: 'ubicada' | 'descartada' | 'sin_resultado' | 'rechazada' | 'sin_respuesta' | 'sin_clave';
  formatted: string | null;
  exacta: boolean | null;
  detalle: string | null;
}

interface Estado {
  estado: 'sin_clave' | 'sin_verificar' | 'ok' | 'rechazada' | 'sin_respuesta';
  detalle: string | null;
  respondioEn: string | null;
  ultimaPrueba: Prueba | null;
  hoy: {
    dia: string;
    consultasAGoogle: number;
    ubicadas: number;
    descartadas: number;
    sinResultado: number;
    desdeCache: number;
    sinClave: number;
    fallos: number;
  };
}

const ESTADO: Record<Estado['estado'], { etiqueta: string; tono: 'positive' | 'neutral' | 'warning' | 'critical'; texto: string }> = {
  ok: {
    etiqueta: 'Google',
    tono: 'positive',
    texto: 'Google está respondiendo: las direcciones escritas se ubican en el mapa.',
  },
  sin_verificar: {
    etiqueta: 'probando',
    tono: 'neutral',
    texto: 'Hay clave de Google, pero todavía no ha respondido. Se prueba sola al arrancar la API.',
  },
  sin_clave: {
    etiqueta: 'sin Google',
    tono: 'warning',
    texto:
      'Falta GOOGLE_GEOCODING_API_KEY en la API. Toda dirección escrita queda «sin ubicar» y se despacha desde el punto de partida; solo se ubican las ubicaciones compartidas y los lugares del catálogo.',
  },
  rechazada: {
    etiqueta: 'Google rechaza la clave',
    tono: 'critical',
    texto:
      'Google rechazó la clave. Suele ser la restricción de IP, la API sin habilitar o la facturación. Mientras tanto, las direcciones escritas quedan «sin ubicar».',
  },
  sin_respuesta: {
    etiqueta: 'Google no responde',
    tono: 'critical',
    texto: 'No se pudo hablar con Google. Mientras tanto, las direcciones escritas quedan «sin ubicar».',
  },
};

const RESULTADO_DE_PRUEBA: Record<Prueba['resultado'], string> = {
  ubicada: 'La ubicó',
  descartada: 'Respondió, pero no con el sitio exacto',
  sin_resultado: 'Respondió, sin resultado',
  rechazada: 'Rechazó la clave',
  sin_respuesta: 'No respondió',
  sin_clave: 'No hay clave',
};

export function useGeocodificador() {
  return useQuery({
    queryKey: ['geocodificador'],
    queryFn: () => api.get<Estado>('/v1/admin/system/geocodificador'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/** La píldora de la barra de arriba. Al tocarla, el detalle. */
export function IndicadorDeDirecciones() {
  const geo = useGeocodificador();
  const [abierto, setAbierto] = useState(false);
  if (!geo.data) return null;
  const e = ESTADO[geo.data.estado];

  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        title="Ubicación de direcciones escritas"
        className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--on-accent)]"
      >
        <StatusPill tone={e.tono} live={geo.data.estado === 'ok'} inverse>
          Direcciones · {e.etiqueta}
        </StatusPill>
      </button>
      <Sheet open={abierto} onClose={() => setAbierto(false)} title="Ubicación de direcciones" subtitle="Google Geocoding">
        <Detalle estado={geo.data} />
      </Sheet>
    </>
  );
}

/** El letrero rojo cuando Google deja de funcionar, como el de las líneas caídas. */
export function GeocodificadorCaido() {
  const geo = useGeocodificador();
  const [abierto, setAbierto] = useState(false);
  const estado = geo.data?.estado;
  if (estado !== 'rechazada' && estado !== 'sin_respuesta') return null;

  return (
    <div className="px-5 pt-3">
      <Banner
        tone="critical"
        icon={<MapPinned className="size-4" />}
        action={
          <button
            type="button"
            onClick={() => setAbierto(true)}
            className="text-caption font-medium underline underline-offset-2"
          >
            Ver detalle
          </button>
        }
      >
        <span className="font-medium">{ESTADO[estado].etiqueta}.</span> Las direcciones escritas quedan
        «sin ubicar» hasta que vuelva a funcionar.
      </Banner>
      <Sheet open={abierto} onClose={() => setAbierto(false)} title="Ubicación de direcciones" subtitle="Google Geocoding">
        <Detalle estado={geo.data!} />
      </Sheet>
    </div>
  );
}

function Detalle({ estado }: { estado: Estado }) {
  const qc = useQueryClient();
  const toast = useToast();
  const puedeProbar = usePuede()('sistema.tecnico');
  const e = ESTADO[estado.estado];
  const prueba = estado.ultimaPrueba;
  const hoy = estado.hoy;

  const probar = useMutation({
    mutationFn: () => api.post<{ prueba: Prueba; estado: Estado }>('/v1/admin/system/geocodificador/probar'),
    onSuccess: (r) => {
      qc.setQueryData(['geocodificador'], r.estado);
      toast.push({
        tone: r.prueba.resultado === 'ubicada' ? 'positive' : r.prueba.resultado === 'rechazada' || r.prueba.resultado === 'sin_respuesta' ? 'critical' : 'warning',
        title: `Google: ${RESULTADO_DE_PRUEBA[r.prueba.resultado].toLowerCase()}`,
        description: `«${r.prueba.direccion}» en ${r.prueba.ms} ms`,
      });
    },
    onError: (causa: unknown) =>
      toast.push({ tone: 'critical', title: 'No se pudo probar', description: causa instanceof ApiError ? causa.message : undefined }),
  });

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <StatusPill tone={e.tono} size="md">
          {e.etiqueta}
        </StatusPill>
        <p className="text-base text-ink-secondary">{e.texto}</p>
        {estado.detalle ? (
          <p className="rounded-md border border-line bg-surface-sunk px-3 py-2 font-mono text-caption text-ink-secondary">
            {estado.detalle}
          </p>
        ) : null}
        {estado.respondioEn ? (
          <p className="text-caption text-ink-muted">Google respondió por última vez {formatRelative(estado.respondioEn)}.</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <SectionLabel>Última prueba</SectionLabel>
        {prueba ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md border border-line p-3 text-caption">
            <dt className="text-ink-muted">Cuándo</dt>
            <dd className="text-ink">{formatDateTime(prueba.en)}</dd>
            <dt className="text-ink-muted">Dirección</dt>
            <dd className="text-ink">{prueba.direccion}</dd>
            <dt className="text-ink-muted">Resultado</dt>
            <dd className="text-ink">
              {RESULTADO_DE_PRUEBA[prueba.resultado]}
              {prueba.resultado !== 'sin_clave' ? ` · ${prueba.ms} ms` : ''}
            </dd>
            {prueba.formatted ? (
              <>
                <dt className="text-ink-muted">Google entendió</dt>
                <dd className="text-ink">
                  {prueba.formatted}
                  {prueba.exacta === false ? ' (a la altura de la calle, no la puerta)' : ''}
                </dd>
              </>
            ) : null}
            {prueba.detalle ? (
              <>
                <dt className="text-ink-muted">Detalle</dt>
                <dd className="font-mono text-ink-secondary">{prueba.detalle}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="text-caption text-ink-muted">Todavía no se ha probado desde que arrancó la API.</p>
        )}
        {puedeProbar ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              icon={<RefreshCw className="size-3.5" />}
              loading={probar.isPending}
              onClick={() => probar.mutate()}
            >
              Probar ahora
            </Button>
            <span className="text-micro text-ink-muted">Cada prueba cuenta como una consulta en el cupo de Google.</span>
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <SectionLabel>Hoy</SectionLabel>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[
            { etiqueta: 'Consultas a Google', valor: hoy.consultasAGoogle },
            { etiqueta: 'Ubicadas', valor: hoy.ubicadas },
            { etiqueta: 'Desde la caché', valor: hoy.desdeCache },
            { etiqueta: 'No eran el sitio exacto', valor: hoy.descartadas },
            { etiqueta: 'No encontradas', valor: hoy.sinResultado },
            { etiqueta: estado.estado === 'sin_clave' ? 'Sin clave' : 'Fallos de Google', valor: estado.estado === 'sin_clave' ? hoy.sinClave : hoy.fallos },
          ].map((c) => (
            <div key={c.etiqueta} className="rounded-md border border-line bg-surface px-3 py-2">
              <dt className="text-micro text-ink-muted">{c.etiqueta}</dt>
              <dd className="tnum mt-0.5 text-title font-semibold text-ink">{c.valor}</dd>
            </div>
          ))}
        </dl>
        <p className="text-micro text-ink-muted">
          Cuentan desde que arrancó la API y vuelven a cero cada día. Lo que sale de la caché no se paga:
          cada dirección se guarda 30 días.
        </p>
      </div>
    </div>
  );
}
