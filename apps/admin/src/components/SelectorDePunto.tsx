import { useEffect, useRef, useState } from 'react';
import { GeoJSONSource, Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { Crosshair } from 'lucide-react';
import type { Point, Zone } from '@tax/shared';
import { poligonoCircular } from '@tax/shared';
import { Input, cn } from '@tax/ui';
import { PAIPA_CENTER, TILES_URL, buildStyle, readPalette, registerPmtiles, token } from '../map/style';
import 'maplibre-gl/dist/maplibre-gl.css';

const VACIO: FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Coordenadas dentro de lo que se pega: un enlace de Google Maps
 * (`@5.78,-73.11` o `?q=5.78,-73.11`) o el par suelto «5.78, -73.11». Así
 * llegan las ubicaciones a la oficina, por WhatsApp o copiadas del mapa.
 */
export function leerCoordenadas(texto: string): Point | null {
  const t = decodeURIComponent(texto);
  const patrones = [/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /[?&](?:q|query|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /^\s*(-?\d+\.\d+)\s*[,;\s]\s*(-?\d+\.\d+)\s*$/];
  for (const patron of patrones) {
    const m = t.match(patron);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}

const anillo = (puntos: Point[]) => [...puntos.map((p) => [p.lng, p.lat]), [puntos[0]!.lng, puntos[0]!.lat]];

/**
 * Elegir un punto en el mapa de Paipa: un clic lo pone, otro lo mueve.
 *
 * Es el mismo mapa base de *Operación*. Dibuja las zonas que ya existen para
 * que se vea dónde hay servicio y, con `radioKm`, el círculo que tendría la
 * zona nueva: el mismo polígono que guardará la API.
 */
export function SelectorDePunto({
  valor,
  onCambiar,
  zonas,
  radioKm,
  tipoVistaPrevia = 'urbano',
  className,
}: {
  valor?: Point;
  onCambiar: (punto: Point) => void;
  zonas: Zone[];
  radioKm?: number;
  tipoVistaPrevia?: 'urbano' | 'rural';
  className?: string;
}) {
  const contenedor = useRef<HTMLDivElement>(null);
  const mapa = useRef<MapLibreMap>(undefined);
  const alCambiar = useRef(onCambiar);
  alCambiar.current = onCambiar;
  const [pegado, setPegado] = useState('');
  const [errorPegado, setErrorPegado] = useState(false);

  /*
   * Lo último de cada capa: el mapa termina de cargar después del primer
   * render, y al cargar siembra sus fuentes con esto.
   */
  const ultimo = useRef<Record<'zonas' | 'vista' | 'punto', FeatureCollection>>({
    zonas: VACIO,
    vista: VACIO,
    punto: VACIO,
  });
  const publicar = (id: 'zonas' | 'vista' | 'punto', datos: FeatureCollection) => {
    ultimo.current[id] = datos;
    (mapa.current?.getSource(id) as GeoJSONSource | undefined)?.setData(datos);
  };

  useEffect(() => {
    if (!contenedor.current || mapa.current) return;
    registerPmtiles();
    const instancia = new MapLibreMap({
      container: contenedor.current,
      style: buildStyle(TILES_URL, readPalette()),
      center: valor ? [valor.lng, valor.lat] : PAIPA_CENTER,
      zoom: valor ? 14 : 11.6,
      pitch: 0,
      dragRotate: false,
      attributionControl: { compact: true },
    });
    instancia.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    instancia.getCanvas().style.cursor = 'crosshair';

    instancia.on('load', () => {
      for (const id of ['zonas', 'vista', 'punto'] as const) {
        instancia.addSource(id, { type: 'geojson', data: ultimo.current[id] });
      }
      instancia.addLayer({
        id: 'zonas-relleno',
        type: 'fill',
        source: 'zonas',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.06 },
      });
      instancia.addLayer({
        id: 'zonas-borde',
        type: 'line',
        source: 'zonas',
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.5 },
      });
      instancia.addLayer({
        id: 'zonas-nombre',
        type: 'symbol',
        source: 'zonas',
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 10 },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': token('--surface'), 'text-halo-width': 1.2 },
      });
      instancia.addLayer({
        id: 'vista-relleno',
        type: 'fill',
        source: 'vista',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16 },
      });
      instancia.addLayer({
        id: 'vista-borde',
        type: 'line',
        source: 'vista',
        paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
      });
      instancia.addLayer({
        id: 'punto',
        type: 'circle',
        source: 'punto',
        paint: {
          'circle-radius': 8,
          'circle-color': token('--ink'),
          'circle-stroke-color': token('--surface'),
          'circle-stroke-width': 3,
        },
      });
    });

    instancia.on('click', (evento) => alCambiar.current({ lat: evento.lngLat.lat, lng: evento.lngLat.lng }));
    mapa.current = instancia;
    return () => {
      instancia.remove();
      mapa.current = undefined;
    };
    // El mapa se crea una vez; lo demás se actualiza con `setData`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    publicar('zonas', {
      type: 'FeatureCollection',
      features: zonas
        .filter((z) => z.polygon.length > 2)
        .map((z) => ({
          type: 'Feature' as const,
          geometry: { type: 'Polygon' as const, coordinates: [anillo(z.polygon)] },
          properties: { name: z.name, color: token(z.kind === 'rural' ? '--success-fill' : '--brand') },
        })),
    });
  }, [zonas]);

  useEffect(() => {
    publicar(
      'punto',
      valor
        ? {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [valor.lng, valor.lat] }, properties: {} }],
          }
        : VACIO,
    );
    publicar(
      'vista',
      valor && radioKm && radioKm > 0
        ? {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: poligonoCircular(valor.lat, valor.lng, radioKm),
                properties: { color: token(tipoVistaPrevia === 'rural' ? '--success-fill' : '--brand') },
              },
            ],
          }
        : VACIO,
    );
  }, [valor, radioKm, tipoVistaPrevia]);

  const usarPegado = () => {
    const punto = leerCoordenadas(pegado);
    setErrorPegado(!punto);
    if (!punto) return;
    onCambiar(punto);
    mapa.current?.flyTo({ center: [punto.lng, punto.lat], zoom: Math.max(mapa.current.getZoom(), 14) });
    setPegado('');
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div ref={contenedor} className="min-h-72 flex-1 overflow-hidden rounded-lg border border-line" />
      <p className="flex items-center gap-1.5 text-micro text-ink-muted">
        <Crosshair className="size-3.5 shrink-0" />
        {valor
          ? `Punto: ${valor.lat.toFixed(5)}, ${valor.lng.toFixed(5)} · toca el mapa para moverlo`
          : 'Toca el mapa para poner el punto'}
      </p>
      <div className="flex gap-2">
        <Input
          value={pegado}
          onChange={(e) => {
            setPegado(e.target.value);
            setErrorPegado(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              usarPegado();
            }
          }}
          placeholder="…o pega un enlace de Google Maps o «5.7803, -73.1142»"
          aria-label="Enlace o coordenadas"
          className="flex-1"
        />
        <button
          type="button"
          onClick={usarPegado}
          className="shrink-0 rounded-md border border-line px-3 text-caption font-medium text-ink hover:bg-surface-sunk"
        >
          Usar
        </button>
      </div>
      {errorPegado ? (
        <p className="text-micro text-[var(--t-critical-ink)]">
          No encontré coordenadas ahí. Sirve un enlace de Google Maps con el punto o dos números separados por coma.
        </p>
      ) : null}
    </div>
  );
}
