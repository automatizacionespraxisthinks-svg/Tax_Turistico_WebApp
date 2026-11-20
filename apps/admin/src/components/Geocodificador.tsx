import { useEffect, useState } from 'react';
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
  hoy: Uso;
  mes: Uso & { mes: string; dias: number };
  historial: Array<Pick<Uso, 'dia' | 'consultasAGoogle' | 'direcciones' | 'municipios' | 'pruebas'>>;
  /** `false` si Redis no respondió: las cifras son solo las del proceso. */
  persistente: boolean;
}

/** El uso de Google en un día (o sumado en el mes). Lo guarda la API en Redis. */
interface Uso {
  dia: string;
  /** Lo que Google cobra: cada llamada, sea cual sea su resultado. */
  consultasAGoogle: number;
  direcciones: number;
  municipios: number;
  pruebas: number;
  ubicadas: number;
  descartadas: number;
  sinResultado: number;
  desdeCache: number;
  sinClave: number;
  fallos: number;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** «2026-11-20» → «20 nov». Sin pasar por Date: el día ya viene en hora de Paipa. */
const diaCorto = (dia: string) => `${Number(dia.slice(8, 10))} ${MESES[Number(dia.slice(5, 7)) - 1]!.slice(0, 3)}`;

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
    // Cada consulta se anota al hacerse; el panel la ve en el siguiente
    // refresco, o al abrir el detalle.
    refetchInterval: 30_000,
    staleTime: 10_000,
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
  const mes = estado.mes;
  // Al abrir el detalle, las cifras de este momento y no las de hace 30 s.
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['geocodificador'] });
  }, [qc]);

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

      {!estado.persistente ? (
        <Banner tone="warning">
          No se pudo leer el registro de uso en Redis: las cifras son solo las de este proceso de la API.
        </Banner>
      ) : null}

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
          De las {hoy.consultasAGoogle} consultas: {hoy.direcciones} de direcciones escritas, {hoy.municipios} para saber
          si una ubicación compartida es de Paipa y {hoy.pruebas} de prueba de la clave.
        </p>
      </div>

      <div className="space-y-2">
        <SectionLabel>Este mes · {MESES[Number(mes.mes.slice(5, 7)) - 1]}</SectionLabel>
        <div className="rounded-md border border-line bg-surface px-3 py-2">
          <p className="text-micro text-ink-muted">Consultas a Google</p>
          <p className="tnum mt-0.5 text-title font-semibold text-ink">{mes.consultasAGoogle}</p>
          <p className="mt-1 text-micro text-ink-muted">
            {mes.direcciones} de direcciones · {mes.municipios} de municipio · {mes.pruebas} de prueba ·{' '}
            {mes.desdeCache} desde la caché (no se pagan)
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <SectionLabel>Últimos 30 días</SectionLabel>
        <Historial dias={estado.historial} />
      </div>

      <p className="text-micro text-ink-muted">
        Cada llamada a Google se anota al hacerse y queda guardada un año, aunque la API se reinicie. «Consultas a
        Google» es lo que Google cobra; lo que sale de la caché no se paga: cada dirección y cada municipio se guardan
        30 días.
      </p>
    </div>
  );
}

/** Una barra por día: de un vistazo, qué días se consultó más. */
function Historial({ dias }: { dias: Estado['historial'] }) {
  if (dias.length === 0) return <p className="text-caption text-ink-muted">Sin registro.</p>;
  const maximo = Math.max(1, ...dias.map((d) => d.consultasAGoogle));
  return (
    <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-line p-2">
      {dias.map((d) => (
        <li
          key={d.dia}
          className="grid grid-cols-[3.5rem_1fr_2.5rem] items-center gap-2 text-caption"
          title={`${d.direcciones} de direcciones · ${d.municipios} de municipio · ${d.pruebas} de prueba`}
        >
          <span className="text-ink-muted">{diaCorto(d.dia)}</span>
          <span className="h-2 rounded-full bg-surface-sunk">
            <span
              className="block h-2 rounded-full bg-accent"
              style={{ width: `${(d.consultasAGoogle / maximo) * 100}%` }}
            />
          </span>
          <span className="tnum text-right text-ink">{d.consultasAGoogle}</span>
        </li>
      ))}
    </ul>
  );
}
