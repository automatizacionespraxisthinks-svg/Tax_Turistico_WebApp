import { useEffect, useMemo, useRef, useState } from 'react';
import {
  GeoJSONSource,
  Map as MapLibreMap,
  NavigationControl,
  addProtocol,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import type { FeatureCollection } from 'geojson';
import type { Driver, Ride } from '@tax/shared';
import { DRIVER_STATUS_LABEL, RIDE_STATUS_LABEL, RIDE_STATUS_TONE } from '@tax/shared';
import { cn } from '@tax/ui';
import { useLive } from '../live/store';
import { buildStyle, readPalette, token } from '../map/style';
import 'maplibre-gl/dist/maplibre-gl.css';

/**
 * Mapa de operación (ADR-08).
 *
 * MapLibre GL sobre un archivo PMTiles estático de Paipa generado de
 * OpenStreetMap: el navegador lo cachea y el servidor no gasta CPU ni dinero
 * por consulta. Sin servidor de rutas, que es el gigabyte de RAM que el
 * documento decide no gastar.
 *
 * Todo lo que se mueve —conductores, pines, oleada, ruta— son fuentes GeoJSON
 * que se actualizan con `setData`. Con 62 taxis reportando posición, pintar
 * marcadores del DOM sería mover 62 nodos a la vez; así es un solo dibujo por
 * fotograma en la GPU.
 */

const TILES_URL = import.meta.env.VITE_PMTILES_URL ?? '/tiles/paipa.pmtiles';

const PAIPA_CENTER: [number, number] = [-73.1142, 5.7803];

/** Una sola vez por página: registrar el protocolo dos veces lanza error. */
let protocolRegistered = false;

function registerPmtiles(): void {
  if (protocolRegistered) return;
  addProtocol('pmtiles', new Protocol().tile);
  protocolRegistered = true;
}

/** Color de un tono del sistema de diseño, resuelto para MapLibre. */
function toneColor(tone: string): string {
  return token(`--t-${tone}-solid`, '#888888');
}

const DRIVER_TONE: Record<Driver['status'], string> = {
  AVAILABLE: 'positive',
  ON_RIDE: 'progress',
  PAUSED: 'warning',
  OFF_SHIFT: 'neutral',
};

function driversToGeoJson(drivers: Driver[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: drivers
      .filter((driver) => driver.position)
      .map((driver) => ({
        type: 'Feature' as const,
        id: driver.id,
        geometry: {
          type: 'Point' as const,
          coordinates: [driver.position!.lng, driver.position!.lat],
        },
        properties: {
          id: driver.id,
          code: driver.code,
          name: driver.name,
          plate: driver.vehicle.plate,
          estado: DRIVER_STATUS_LABEL[driver.status],
          color: toneColor(DRIVER_TONE[driver.status]),
          enCarrera: driver.status === 'ON_RIDE',
          // Una posición vieja no sirve para prometer un ETA (§5.2): se
          // dibuja apagada para que el operador no cuente con ella.
          vieja: (driver.positionAgeSeconds ?? 0) > 60,
          edad: driver.positionAgeSeconds ?? 0,
        },
      })),
  };
}

function ridesToGeoJson(rides: Ride[], selectedId?: string | null): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: rides
      .filter((ride) => ride.pickup.point)
      .map((ride) => ({
        type: 'Feature' as const,
        id: ride.id,
        geometry: {
          type: 'Point' as const,
          coordinates: [ride.pickup.point!.lng, ride.pickup.point!.lat],
        },
        properties: {
          id: ride.id,
          code: ride.code,
          estado: RIDE_STATUS_LABEL[ride.status],
          color: toneColor(RIDE_STATUS_TONE[ride.status]),
          // Lo que espera a alguien lleva halo; lo que ya está en marcha, no.
          esperando:
            ride.status === 'NOTIFIED' || ride.status === 'UNASSIGNED' || ride.status === 'PENDING',
          seleccionada: ride.id === selectedId,
        },
      })),
  };
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

const OVERLAY_SOURCES = ['zonas', 'conductores', 'pines', 'ruta', 'oleada'] as const;

type OverlaySource = (typeof OVERLAY_SOURCES)[number];

/** Fuente GeoJSON ya tipada, o nada si el estilo aún no la montó. */
function overlay(instance: MapLibreMap | undefined, id: OverlaySource): GeoJSONSource | undefined {
  const source = instance?.getSource(id);
  return source instanceof GeoJSONSource ? source : undefined;
}

export interface MapCanvasProps {
  rides: Ride[];
  selectedRideId?: string | null;
  onSelectRide?: (rideId: string) => void;
  className?: string;
}

export function MapCanvas({ rides, selectedRideId, onSelectRide, className }: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap>(undefined);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState<{
    code: string;
    name: string;
    plate: string;
    estado: string;
    edad: number;
  } | null>(null);

  const drivers = useLive((s) => s.drivers);
  const zones = useLive((s) => s.zones);
  const sweepZoneId = useLive((s) => s.sweepZoneId);

  // El manejador vive en una referencia para que el mapa no se recree cada
  // vez que el padre cambia la función.
  const selectHandler = useRef(onSelectRide);
  selectHandler.current = onSelectRide;

  /*
   * Último dato conocido de cada capa.
   *
   * Al cambiar de tema el estilo se reemplaza entero y las capas propias se
   * vuelven a montar con sus fuentes vacías. Apoyarse en un indicador de
   * «listo» no sirve: pasa a falso y a verdadero en el mismo ciclo de React,
   * que no ve cambio y no vuelve a ejecutar los efectos. Así que el remontaje
   * siembra las fuentes él mismo con lo que haya aquí.
   */
  const latest = useRef<Record<OverlaySource, FeatureCollection>>({
    zonas: EMPTY,
    conductores: EMPTY,
    pines: EMPTY,
    ruta: EMPTY,
    oleada: EMPTY,
  });

  const publish = (id: OverlaySource, data: FeatureCollection) => {
    latest.current[id] = data;
    overlay(map.current, id)?.setData(data);
  };

  useEffect(() => {
    if (!container.current || map.current) return;
    registerPmtiles();

    const palette = readPalette();
    const instance = new MapLibreMap({
      container: container.current,
      style: buildStyle(TILES_URL, palette),
      center: PAIPA_CENTER,
      zoom: 12.4,
      // El operador mira un plano, no un paisaje: sin inclinación ni giro se
      // lee más rápido y no queda torcido por un arrastre accidental.
      pitch: 0,
      dragRotate: false,
      attributionControl: { compact: true },
    });

    instance.addControl(new NavigationControl({ showCompass: false }), 'top-right');

    instance.on('error', (event: { error?: { message?: string } }) => {
      const message = String(event.error?.message ?? '');

      /*
       * Los errores del mapa no se tragan: un estilo inválido o un azulejo
       * que no llega dejan el lienzo en blanco sin decir por qué, y depurar
       * eso a ciegas cuesta horas.
       */
      if (import.meta.env.DEV) console.warn('[mapa]', message, event);

      // Que falte un azulejo suelto no es alarma; que falte el archivo, sí.
      if (message.includes('pmtiles') || message.includes('paipa')) setFailed(true);
    });

    /** Las capas propias se montan sobre el estilo, y se remontan al cambiarlo. */
    const addOverlays = () => {
      // Idempotente: `style.load` también se emite en la carga inicial.
      if (instance.getLayer('conductores')) return;
      const colors = readPalette();

      for (const id of OVERLAY_SOURCES) {
        if (!instance.getSource(id)) {
          instance.addSource(id, { type: 'geojson', data: latest.current[id] });
        }
      }

      instance.addLayer({
        id: 'zonas-relleno',
        type: 'fill',
        source: 'zonas',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.06 },
      });
      instance.addLayer({
        id: 'zonas-borde',
        type: 'line',
        source: 'zonas',
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.5 },
      });
      instance.addLayer({
        id: 'zonas-nombre',
        type: 'symbol',
        source: 'zonas',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.08,
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-opacity': 0.8,
          'text-halo-color': colors.canvas,
          'text-halo-width': 1.5,
        },
      });

      instance.addLayer({
        id: 'oleada',
        type: 'circle',
        source: 'oleada',
        paint: {
          'circle-radius': ['get', 'radio'],
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': 2,
          'circle-stroke-opacity': ['get', 'opacidad'],
        },
      });

      instance.addLayer({
        id: 'ruta',
        type: 'line',
        source: 'ruta',
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2.5,
          'line-dasharray': [2, 2],
          'line-opacity': 0.85,
        },
      });

      instance.addLayer({
        id: 'pines-halo',
        type: 'circle',
        source: 'pines',
        filter: ['get', 'esperando'],
        paint: { 'circle-radius': 16, 'circle-color': ['get', 'color'], 'circle-opacity': 0.14 },
      });
      instance.addLayer({
        id: 'pines',
        type: 'circle',
        source: 'pines',
        paint: {
          'circle-radius': ['case', ['get', 'seleccionada'], 9, 6],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': colors.surface,
          'circle-stroke-width': ['case', ['get', 'seleccionada'], 3, 2],
        },
      });

      instance.addLayer({
        id: 'conductores-halo',
        type: 'circle',
        source: 'conductores',
        filter: ['get', 'enCarrera'],
        paint: { 'circle-radius': 12, 'circle-color': ['get', 'color'], 'circle-opacity': 0.16 },
      });
      instance.addLayer({
        id: 'conductores',
        type: 'circle',
        source: 'conductores',
        paint: {
          'circle-radius': 5,
          'circle-color': ['get', 'color'],
          'circle-opacity': ['case', ['get', 'vieja'], 0.4, 1],
          'circle-stroke-color': colors.surface,
          'circle-stroke-width': 1.5,
        },
      });

      setReady(true);
    };

    /*
     * `style.load` y no `styledata`: el segundo se emite durante la carga,
     * cuando el estilo todavía no está listo, y deja de emitirse en cuanto lo
     * está. Al cambiar de tema las capas propias nunca volvían, y el operador
     * se quedaba con el mapa pero sin conductores ni carreras encima.
     */
    instance.on('style.load', addOverlays);

    instance.on('load', () => {
      addOverlays();

      instance.on('click', 'pines', (event: MapLayerMouseEvent) => {
        const id = event.features?.[0]?.properties?.id;
        if (typeof id === 'string') selectHandler.current?.(id);
      });

      instance.on('mouseenter', 'pines', () => {
        instance.getCanvas().style.cursor = 'pointer';
      });
      instance.on('mouseleave', 'pines', () => {
        instance.getCanvas().style.cursor = '';
      });

      instance.on('mousemove', 'conductores', (event: MapLayerMouseEvent) => {
        const p = event.features?.[0]?.properties;
        if (!p) return;
        setHovered({
          code: String(p.code),
          name: String(p.name),
          plate: String(p.plate),
          estado: String(p.estado),
          edad: Number(p.edad),
        });
      });
      instance.on('mouseleave', 'conductores', () => setHovered(null));
    });

    map.current = instance;
    if (import.meta.env.DEV) {
      // Asa para inspeccionar el mapa desde la consola mientras se ajusta el
      // estilo. No existe en producción.
      (window as unknown as { mapa?: MapLibreMap }).mapa = instance;
    }

    return () => {
      instance.remove();
      map.current = undefined;
      setReady(false);
    };
  }, []);

  /* ------------------------------------------------------------- tema --- */

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const instance = map.current;
      if (!instance) return;
      setReady(false);
      instance.setStyle(buildStyle(TILES_URL, readPalette()));
    });

    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  /* ------------------------------------------------------------ datos --- */

  const zonesGeoJson = useMemo<FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: zones
        .filter((zone) => zone.polygon.length > 2)
        .map((zone) => ({
          type: 'Feature' as const,
          id: zone.id,
          geometry: {
            type: 'Polygon' as const,
            coordinates: [
              [
                ...zone.polygon.map((p) => [p.lng, p.lat] as [number, number]),
                [zone.polygon[0]!.lng, zone.polygon[0]!.lat] as [number, number],
              ],
            ],
          },
          properties: {
            name: zone.name,
            color: toneColor(zone.kind === 'rural' ? 'accent' : 'info'),
          },
        })),
    }),
    [zones],
  );

  useEffect(() => {
    publish('zonas', zonesGeoJson);
  }, [zonesGeoJson, ready]);

  useEffect(() => {
    publish('conductores', driversToGeoJson(drivers));
  }, [drivers, ready]);

  useEffect(() => {
    publish('pines', ridesToGeoJson(rides, selectedRideId));
  }, [rides, selectedRideId, ready]);

  /** Línea entre el conductor asignado y el punto de recogida. */
  useEffect(() => {
    const ride = rides.find((r) => r.id === selectedRideId);
    const driver = ride?.driverId ? drivers.find((d) => d.id === ride.driverId) : undefined;

    if (!ride?.pickup.point || !driver?.position) {
      publish('ruta', EMPTY);
      return;
    }

    publish('ruta', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [driver.position.lng, driver.position.lat],
              [ride.pickup.point.lng, ride.pickup.point.lat],
            ],
          },
          properties: { color: toneColor('info') },
        },
      ],
    });
  }, [rides, drivers, selectedRideId, ready]);

  /* -------------------------------------------------------- animaciones --- */

  /** Barrido de la oleada: un anillo que crece desde el centro de la zona. */
  useEffect(() => {
    const instance = map.current;
    const zone = zones.find((z) => z.id === sweepZoneId);
    if (!instance) return;

    if (!zone || zone.polygon.length === 0) {
      publish('oleada', EMPTY);
      return;
    }

    const center = zone.polygon.reduce(
      (acc, p) => ({
        lng: acc.lng + p.lng / zone.polygon.length,
        lat: acc.lat + p.lat / zone.polygon.length,
      }),
      { lng: 0, lat: 0 },
    );
    const color = toneColor('info');
    const start = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      const progress = ((now - start) % 2200) / 2200;
      publish('oleada', {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [center.lng, center.lat] },
            properties: { radio: 10 + progress * 110, opacidad: 0.55 * (1 - progress), color },
          },
        ],
      });
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [sweepZoneId, zones, ready]);

  /** El guion de la ruta avanza hacia el punto de recogida. */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    const patterns: [number, number][] = [
      [2, 2],
      [1.5, 2.5],
      [1, 3],
      [0.5, 3.5],
    ];
    let step = 0;
    let last = 0;
    let frame = 0;

    const tick = (now: number) => {
      if (now - last > 110) {
        last = now;
        step = (step + 1) % patterns.length;
        if (instance.getLayer('ruta')) {
          instance.setPaintProperty('ruta', 'line-dasharray', patterns[step]!);
        }
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  const onShift = drivers.filter((d) => d.position).length;

  return (
    <div className={cn('relative overflow-hidden rounded-lg border border-line', className)}>
      <div ref={container} className="size-full" />

      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-sunk p-6 text-center">
          <p className="max-w-sm text-caption text-ink-muted">
            Falta el mapa de Paipa. Genéralo con{' '}
            <code className="font-mono text-ink">pnpm --filter @tax/tiles build:tiles</code>.
          </p>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
        <Legend />
        <span className="mr-10 rounded-md border border-line bg-surface/85 px-2 py-1 text-micro text-ink-muted backdrop-blur-sm">
          {onShift} en turno
        </span>
      </div>

      {hovered ? (
        <div className="pointer-events-none absolute bottom-8 left-3 rounded-md border border-line bg-surface px-2.5 py-1.5 shadow-md">
          <p className="text-caption font-medium text-ink">
            {hovered.code} · {hovered.name}
          </p>
          <p className="text-micro text-ink-muted">
            {hovered.plate} · {hovered.estado} · {hovered.edad} s
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Legend() {
  const items = [
    { tone: 'tone-positive', label: 'Disponible' },
    { tone: 'tone-progress', label: 'En carrera' },
    { tone: 'tone-warning', label: 'En pausa' },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface/85 px-2.5 py-1.5 backdrop-blur-sm">
      {items.map((item) => (
        <span
          key={item.label}
          className={cn(item.tone, 'flex items-center gap-1.5 text-micro text-ink-secondary')}
        >
          <span className="size-2 rounded-full bg-[var(--tone-solid)]" />
          {item.label}
        </span>
      ))}
    </div>
  );
}
