import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import { PAIPA_BBOX, fetchPaipaLayers, type LayerData } from './overpass';
import { buildArchive, type TileInput } from './pmtiles';

/**
 * Genera el archivo PMTiles de Paipa (ADR-08).
 *
 *   pnpm --filter @tax/tiles build:tiles
 *
 * El resultado es un archivo estático que sirve la propia API y que el
 * navegador cachea: cero CPU del servidor por cada mapa dibujado y ningún
 * coste por consulta, que es justo lo que el ADR busca al descartar un
 * servidor de rutas.
 *
 * Se regenera a mano, cuando interese refrescar los datos de OSM. No es parte
 * del despliegue: el archivo cambia unas pocas veces al año.
 */

const MIN_ZOOM = 9;
const MAX_ZOOM = 15;

/** Extensión del azulejo en unidades internas; 4096 es lo estándar. */
const EXTENT = 4096;

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(here, '../../../apps/admin/public/tiles/paipa.pmtiles');

function lngToTileX(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

interface IndexedLayer {
  name: string;
  index: InstanceType<typeof geojsonvt>;
}

function indexLayers(layers: LayerData[]): IndexedLayer[] {
  return layers.map((layer) => ({
    name: layer.name,
    // geojson-vt v5 expone una clase, no una función.
    index: new geojsonvt(layer.collection, {
      maxZoom: MAX_ZOOM,
      // Por debajo de este nivel no se indexa de golpe: ahorra memoria y
      // estos niveles se generan al vuelo igual de rápido.
      indexMaxZoom: 5,
      indexMaxPoints: 0,
      tolerance: 3,
      extent: EXTENT,
      // Margen para que una línea que cruza el borde no se corte en seco al
      // dibujarla; 64 es el valor que espera MapLibre.
      buffer: 64,
      generateId: false,
    }),
  }));
}

async function main(): Promise<void> {
  console.log('Descargando datos de OpenStreetMap para Paipa…');
  const layers = await fetchPaipaLayers();

  const total = layers.reduce((sum, layer) => sum + layer.collection.features.length, 0);
  console.log(`\n${total} elementos en ${layers.length} capas.`);

  console.log('\nIndexando…');
  const indexed = indexLayers(layers);

  console.log('Generando azulejos…');
  const tiles: TileInput[] = [];

  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const minX = lngToTileX(PAIPA_BBOX.minLng, z);
    const maxX = lngToTileX(PAIPA_BBOX.maxLng, z);
    // En la proyección de Mercator la latitud crece hacia arriba y la Y de
    // los azulejos hacia abajo: el mínimo sale de la latitud máxima.
    const minY = latToTileY(PAIPA_BBOX.maxLat, z);
    const maxY = latToTileY(PAIPA_BBOX.minLat, z);

    let generated = 0;

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const parts: Record<string, unknown> = {};

        for (const layer of indexed) {
          const tile = layer.index.getTile(z, x, y);
          if (tile && tile.features.length > 0) parts[layer.name] = tile;
        }

        // Un azulejo sin nada dentro no se guarda: el lector devuelve
        // «no hay» y MapLibre lo trata como vacío.
        if (Object.keys(parts).length === 0) continue;

        const data = Buffer.from(vtpbf.fromGeojsonVt(parts, { version: 2, extent: EXTENT }));
        tiles.push({ z, x, y, data });
        generated += 1;
      }
    }

    console.log(`  z${z}: ${generated} azulejos`);
  }

  const archive = buildArchive(tiles, {
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    bounds: PAIPA_BBOX,
    center: { lng: -73.1142, lat: 5.7803, zoom: 13 },
    metadata: {
      name: 'Paipa',
      description: 'Paipa y veredas · despacho de Tax Turístico',
      // Obligatoria por la licencia ODbL de OpenStreetMap (§9.4).
      attribution: '© OpenStreetMap',
      type: 'baselayer',
      format: 'pbf',
      generated: new Date().toISOString(),
      vector_layers: [
        { id: 'roads', fields: { highway: 'String', name: 'String', ref: 'String' } },
        { id: 'water', fields: { natural: 'String', waterway: 'String', name: 'String' } },
        { id: 'landuse', fields: { landuse: 'String', leisure: 'String' } },
        { id: 'buildings', fields: { building: 'String' } },
        { id: 'places', fields: { place: 'String', amenity: 'String', name: 'String' } },
      ],
    },
  });

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, archive);

  const mb = (archive.length / 1024 / 1024).toFixed(2);
  console.log(`\nListo: ${OUTPUT}`);
  console.log(`${tiles.length} azulejos · ${mb} MB`);
}

main().catch((error: unknown) => {
  console.error('\nFalló la generación:', error);
  process.exitCode = 1;
});
