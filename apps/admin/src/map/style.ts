import { addProtocol, type StyleSpecification } from 'maplibre-gl';
import { Protocol } from 'pmtiles';

/**
 * Estilo del mapa base.
 *
 * Se construye a partir de los tokens del sistema de diseño en vez de usar un
 * estilo de terceros: así el mapa no es una isla visual dentro del panel.
 * Terreno y agua llevan los colores de mapa de la marca (HU-UI-01); el
 * esquema de capas no cambia.
 *
 * El esquema de capas es el que genera `@tax/tiles`, no el de un proveedor:
 * roads, water, landuse, buildings y places, con las etiquetas justas.
 */

/**
 * Resuelve un color del sistema de diseño a algo que MapLibre entienda.
 *
 * MapLibre solo lee colores CSS clásicos, y un token puede llegar en
 * cualquier sintaxis que el navegador acepte (`oklch()`, `color-mix()`…).
 * No basta con asignarlo a `fillStyle` y volver a leerlo: el navegador lo
 * devuelve tal cual, así que el valor llegaría igual de crudo y el estilo
 * entero se rechazaría con «color expected».
 *
 * Lo que sí es inequívoco es pintarlo: se rasteriza un píxel y se lee su
 * valor sRGB ya convertido. Un token que falte deja la capa transparente:
 * se nota, pero no tumba el mapa entero.
 */
let scratch: CanvasRenderingContext2D | null | undefined;

function pixelContext(): CanvasRenderingContext2D | null {
  if (scratch !== undefined) return scratch;
  if (typeof document === 'undefined') return (scratch = null);
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  scratch = canvas.getContext('2d', { willReadFrequently: true });
  return scratch;
}

export function resolveColor(value: string, fallback: string): string {
  const context = pixelContext();
  if (!context || !value) return fallback;

  try {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    if (a === 0) return fallback;
    return `rgba(${r}, ${g}, ${b}, ${(a! / 255).toFixed(3)})`;
  } catch {
    return fallback;
  }
}

/** Lee un token del sistema de diseño y lo deja listo para MapLibre. */
export function token(name: string, fallback = 'transparent'): string {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? resolveColor(raw, fallback) : fallback;
}

export interface MapPalette {
  land: string;
  surface: string;
  line: string;
  lineStrong: string;
  ink: string;
  inkMuted: string;
  water: string;
  green: string;
}

export function readPalette(): MapPalette {
  return {
    land: token('--map-land'),
    surface: token('--c-surface'),
    line: token('--c-line'),
    lineStrong: token('--c-line-strong'),
    ink: token('--c-ink'),
    inkMuted: token('--c-ink-muted'),
    water: token('--map-water'),
    green: token('--success-tint'),
  };
}

/** Grosor de vía por nivel de zoom: fino de lejos, legible de cerca. */
function roadWidth(base: number) {
  return [
    'interpolate',
    ['exponential', 1.5],
    ['zoom'],
    10,
    base * 0.4,
    14,
    base,
    17,
    base * 3.5,
  ];
}

const MAJOR = ['motorway', 'trunk', 'primary'];
const MEDIUM = ['secondary', 'tertiary'];

export function buildStyle(tilesUrl: string, palette: MapPalette): StyleSpecification {
  return {
    version: 8,
    name: 'Tax Turístico · Paipa',
    /*
     * Las tipografias se sirven desde `public/fonts`, no desde un CDN.
     *
     * El estilo apuntaba a `fonts.openmaptiles.org`, que hoy responde 200 con
     * una pagina HTML: MapLibre intenta leer ese HTML como protobuf, falla con
     * «Unimplemented type: 4» y dibuja cada letra con el canvas del navegador.
     * Se nota poco —las etiquetas salen igual, con otra letra— pero son 61
     * avisos por carga y una dependencia de un tercero caido.
     *
     * Hay dos rangos porque son los que piden los nombres de Paipa: 0-255 trae
     * el latino con acentos y enies, 256-511 el latino extendido. Si algun dia
     * aparece un nombre fuera de ahi, MapLibre lo dibujara localmente, que es
     * exactamente lo que pasa hoy con todos.
     */
    glyphs: '/fonts/{fontstack}/{range}.pbf',
    sources: {
      paipa: {
        type: 'vector',
        url: `pmtiles://${tilesUrl}`,
        // Obligatoria por la licencia ODbL de los datos (§9.4).
        attribution: '© OpenStreetMap',
      },
    },
    layers: [
      {
        id: 'fondo',
        type: 'background',
        paint: { 'background-color': palette.land },
      },

      {
        id: 'uso-suelo',
        type: 'fill',
        source: 'paipa',
        'source-layer': 'landuse',
        filter: ['any', ['has', 'landuse'], ['has', 'leisure']],
        paint: {
          'fill-color': [
            'case',
            ['in', ['get', 'landuse'], ['literal', ['forest', 'meadow', 'grass', 'farmland']]],
            palette.green,
            ['has', 'leisure'],
            palette.green,
            palette.surface,
          ],
          'fill-opacity': 0.55,
        },
      },

      {
        id: 'agua',
        type: 'fill',
        source: 'paipa',
        'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': palette.water },
      },
      {
        id: 'cauces',
        type: 'line',
        source: 'paipa',
        'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': palette.water,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 16, 3],
        },
      },

      /*
       * Las vías van en dos capas: primero el contorno y encima el relleno.
       * Es lo que hace que dos calles que se cruzan se lean como un cruce y
       * no como una mancha.
       */
      {
        id: 'vias-contorno',
        type: 'line',
        source: 'paipa',
        'source-layer': 'roads',
        filter: ['in', ['get', 'highway'], ['literal', [...MAJOR, ...MEDIUM]]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': palette.lineStrong,
          'line-width': roadWidth(3.4) as never,
        },
      },
      {
        id: 'vias-menores',
        type: 'line',
        source: 'paipa',
        'source-layer': 'roads',
        filter: ['!', ['in', ['get', 'highway'], ['literal', [...MAJOR, ...MEDIUM]]]],
        minzoom: 13,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // Vías blancas sobre el terreno, también las menores.
        paint: {
          'line-color': palette.surface,
          'line-width': roadWidth(1.4) as never,
        },
      },
      {
        id: 'vias',
        type: 'line',
        source: 'paipa',
        'source-layer': 'roads',
        filter: ['in', ['get', 'highway'], ['literal', [...MAJOR, ...MEDIUM]]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': palette.surface,
          'line-width': roadWidth(2.2) as never,
        },
      },

      {
        id: 'edificios',
        type: 'fill',
        source: 'paipa',
        'source-layer': 'buildings',
        minzoom: 15,
        paint: { 'fill-color': palette.line, 'fill-opacity': 0.7 },
      },

      {
        id: 'nombres-via',
        type: 'symbol',
        source: 'paipa',
        'source-layer': 'roads',
        minzoom: 15,
        filter: ['has', 'name'],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
        },
        paint: {
          'text-color': palette.inkMuted,
          'text-halo-color': palette.land,
          'text-halo-width': 1.2,
        },
      },
      {
        id: 'lugares',
        type: 'symbol',
        source: 'paipa',
        'source-layer': 'places',
        filter: ['has', 'name'],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            ['case', ['==', ['get', 'place'], 'town'], 13, 10],
            15,
            ['case', ['==', ['get', 'place'], 'town'], 16, 12],
          ],
          'text-anchor': 'center',
          'text-max-width': 8,
        },
        paint: {
          'text-color': palette.ink,
          'text-halo-color': palette.land,
          'text-halo-width': 1.5,
        },
      },
    ],
  };
}

/** El archivo de teselas de Paipa; lo comparten el mapa de operación y los formularios. */
export const TILES_URL: string = import.meta.env.VITE_PMTILES_URL ?? '/tiles/paipa.pmtiles';

export const PAIPA_CENTER: [number, number] = [-73.1142, 5.7803];

/** Una sola vez por página: registrar el protocolo dos veces lanza error. */
let protocolRegistered = false;

export function registerPmtiles(): void {
  if (protocolRegistered) return;
  addProtocol('pmtiles', new Protocol().tile);
  protocolRegistered = true;
}
