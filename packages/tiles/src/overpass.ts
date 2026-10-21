import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Feature, FeatureCollection, Geometry } from 'geojson';

/**
 * Descarga de datos de OpenStreetMap para Paipa.
 *
 * Se usa Overpass y no un extracto de Geofabrik porque el área es diminuta
 * —unos 17 × 17 km— y bajar el extracto de Colombia entero para recortarlo
 * sería mover cientos de megas para quedarse con unos pocos.
 *
 * Los datos son ODbL: la atribución «© OpenStreetMap» es obligatoria allí
 * donde se muestre el mapa (§9.4).
 */

/*
 * Varias instancias: la pública principal se satura a diario y responde 502.
 * Se prueban en orden y se reintenta con espera creciente, que es justo lo
 * que la propia API pide en su mensaje de error.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/*
 * Caché en disco por capa. Bajar estos datos tarda minutos y depende de un
 * servicio gratuito y compartido: repetir la descarga porque una consulta
 * posterior falló sería maleducado además de lento.
 */
const CACHE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../.cache');

/** Paipa y sus veredas, con margen. */
export const PAIPA_BBOX = {
  minLat: 5.69,
  minLng: -73.22,
  maxLat: 5.86,
  maxLng: -73.03,
} as const;

interface OverpassNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

interface OverpassWay {
  type: 'way';
  id: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

type OverpassElement = OverpassNode | OverpassWay;

interface OverpassResponse {
  elements: OverpassElement[];
}

function bboxClause(): string {
  const { minLat, minLng, maxLat, maxLng } = PAIPA_BBOX;
  return `(${minLat},${minLng},${maxLat},${maxLng})`;
}

/**
 * Una sola consulta por capa, no una por etiqueta: Overpass es un recurso
 * compartido y gratuito, y conviene pedirle lo justo.
 */
const QUERIES: Record<string, string> = {
  roads: `way["highway"]["highway"!~"^(footway|steps|path|cycleway|bridleway|construction|proposed)$"]${bboxClause()};`,
  water: `(
    way["natural"="water"]${bboxClause()};
    way["waterway"~"^(river|stream|canal)$"]${bboxClause()};
    way["landuse"="reservoir"]${bboxClause()};
  );`,
  landuse: `(
    way["landuse"~"^(residential|commercial|industrial|farmland|forest|meadow|grass)$"]${bboxClause()};
    way["leisure"~"^(park|pitch|garden)$"]${bboxClause()};
  );`,
  buildings: `way["building"]${bboxClause()};`,
  places: `(
    node["place"~"^(city|town|village|hamlet|suburb|neighbourhood|locality|isolated_dwelling)$"]${bboxClause()};
    node["amenity"~"^(hospital|school|bus_station|police|fuel|pharmacy)$"]${bboxClause()};
  );`,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Una respuesta vacía se trata como fallo.
 *
 * Hay instancias de Overpass que solo indexan su país y contestan 200 con
 * cero elementos para el resto del mundo. Darlas por buenas produce un mapa
 * en blanco que parece correcto: ningún error, ninguna carretera. Si de
 * verdad no hay nada, los nueve intentos coincidirán y se avisa.
 */
async function attempt(endpoint: string, body: string): Promise<OverpassResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // Overpass pide identificarse; sin esto responde 406.
      'user-agent': 'tax-turistico/0.1 (despacho de taxis, Paipa)',
    },
    body: new URLSearchParams({ data: body }).toString(),
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${(await response.text()).slice(0, 120)}`);
  }

  return (await response.json()) as OverpassResponse;
}

async function query(
  body: string,
  log: (message: string) => void,
): Promise<OverpassResponse> {
  let wait = 5_000;
  let lastError: unknown;

  // Tres vueltas sobre las tres instancias: nueve intentos en total, con la
  // espera doblándose cada vuelta.
  for (let round = 0; round < 3; round++) {
    for (const endpoint of ENDPOINTS) {
      try {
        return await attempt(endpoint, body);
      } catch (error) {
        lastError = error;
        const host = new URL(endpoint).host;
        const detail = error instanceof Error ? error.message.split(/\r?\n/)[0] : 'error';
        log(`    ${host} falló (${detail})`);
      }
    }

    log(`    esperando ${wait / 1000} s antes de reintentar…`);
    await sleep(wait);
    wait *= 2;
  }

  throw new Error(
    `Overpass no respondió tras nueve intentos. Último error: ${String(lastError)}`,
  );
}

/** Un anillo cerrado se interpreta como polígono; si no, como línea. */
function isClosed(geometry: { lat: number; lon: number }[]): boolean {
  if (geometry.length < 4) return false;
  const first = geometry[0]!;
  const last = geometry[geometry.length - 1]!;
  return first.lat === last.lat && first.lon === last.lon;
}

function toFeature(element: OverpassElement, forcePolygon: boolean): Feature | null {
  const tags = element.tags ?? {};

  if (element.type === 'node') {
    return {
      type: 'Feature',
      id: element.id,
      geometry: { type: 'Point', coordinates: [element.lon, element.lat] },
      properties: pickProperties(tags),
    };
  }

  const coordinates = (element.geometry ?? []).map((p) => [p.lon, p.lat] as [number, number]);
  if (coordinates.length < 2) return null;

  const polygon = forcePolygon && isClosed(element.geometry ?? []);
  const geometry: Geometry = polygon
    ? { type: 'Polygon', coordinates: [coordinates] }
    : { type: 'LineString', coordinates };

  return { type: 'Feature', id: element.id, geometry, properties: pickProperties(tags) };
}

/**
 * Solo las etiquetas que el estilo usa. Llevarse todas multiplicaría el
 * tamaño del archivo sin que se vea un pixel distinto.
 */
function pickProperties(tags: Record<string, string>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const key of ['highway', 'name', 'natural', 'waterway', 'landuse', 'leisure', 'place', 'amenity', 'building']) {
    const value = tags[key];
    if (value) out[key] = value;
  }
  // `ref` da el número de la vía nacional; útil para orientarse en carretera.
  if (tags.ref) out.ref = tags.ref;
  return out;
}

export interface LayerData {
  name: string;
  collection: FeatureCollection;
}

/**
 * Capas sin las que el mapa no sirve. Las demás son mejora: si Overpass no
 * las da hoy, el mapa sale igual y se completan en la próxima regeneración.
 */
const REQUIRED = new Set(['roads', 'water']);

export async function fetchPaipaLayers(
  log: (message: string) => void = console.log,
): Promise<LayerData[]> {
  const layers: LayerData[] = [];

  await mkdir(CACHE_DIR, { recursive: true });

  for (const [name, clause] of Object.entries(QUERIES)) {
    const cachePath = resolve(CACHE_DIR, `${name}.json`);

    let response: OverpassResponse | undefined;
    try {
      response = JSON.parse(await readFile(cachePath, 'utf8')) as OverpassResponse;
      log(`  ${name}: en caché`);
    } catch {
      log(`  consultando ${name}…`);
      try {
        response = await query(`[out:json][timeout:180];(${clause});out geom;`, log);
        // Solo se cachea lo que trajo datos: guardar un vacío lo convertiría
        // en permanente.
        await writeFile(cachePath, JSON.stringify(response));
      } catch (error) {
        if (REQUIRED.has(name)) throw error;
        log(`    sin ${name} esta vez; el mapa se genera igual`);
        response = { elements: [] };
      }
    }

    const forcePolygon = name !== 'roads';
    const features = response.elements
      .map((element) => toFeature(element, forcePolygon))
      .filter((feature): feature is Feature => feature !== null);

    log(`    ${features.length} elementos`);
    layers.push({ name, collection: { type: 'FeatureCollection', features } });

    await sleep(1500);
  }

  return layers;
}
