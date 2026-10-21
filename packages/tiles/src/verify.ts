import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PMTiles, type Source, type RangeResponse } from 'pmtiles';

/**
 * Comprueba el archivo generado con el lector oficial.
 *
 * El escritor es propio, así que conviene que quien lo valide sea la misma
 * biblioteca que lo leerá en el navegador: si el formato estuviera mal, el
 * mapa saldría vacío sin un solo error.
 */
const file = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../apps/admin/public/tiles/paipa.pmtiles',
);

class BufferSource implements Source {
  constructor(private readonly data: Buffer) {}
  getKey(): string {
    return 'paipa.pmtiles';
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: this.data.buffer.slice(offset, offset + length) as ArrayBuffer };
  }
}

async function main(): Promise<void> {
  const data = await readFile(file);
  const archive = new PMTiles(new BufferSource(data));

  const header = await archive.getHeader();
  console.log('Cabecera leída por el lector oficial:');
  console.log(`  zoom ${header.minZoom}–${header.maxZoom}`);
  console.log(`  tipo de azulejo: ${header.tileType} (1 = mvt) · agrupado: ${header.clustered}`);
  console.log(`  compresión: interna ${header.internalCompression}, azulejos ${header.tileCompression}`);
  console.log(`  azulejos direccionables: ${header.numAddressedTiles}`);
  console.log(`  entradas: ${header.numTileEntries} · contenidos únicos: ${header.numTileContents}`);
  console.log(
    `  límites: ${header.minLon.toFixed(3)},${header.minLat.toFixed(3)} → ${header.maxLon.toFixed(3)},${header.maxLat.toFixed(3)}`,
  );

  const metadata = (await archive.getMetadata()) as { attribution?: string; name?: string };
  console.log(`  metadatos: ${metadata.name} · ${metadata.attribution}`);

  // Un azulejo del centro de Paipa a z15.
  const z = 15;
  const x = Math.floor(((-73.1142 + 180) / 360) * 2 ** z);
  const rad = (5.7803 * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);

  const tile = await archive.getZxy(z, x, y);
  if (!tile) throw new Error(`El azulejo ${z}/${x}/${y} del centro de Paipa no está`);

  const raw = Buffer.from(tile.data);
  // El lector devuelve el azulejo ya descomprimido si la cabecera lo indica.
  const mvt = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;

  console.log(`\nAzulejo ${z}/${x}/${y}: ${mvt.length} bytes de MVT`);

  // Los nombres de capa aparecen como cadenas dentro del protobuf.
  const text = mvt.toString('latin1');
  const found = ['roads', 'water', 'landuse', 'buildings', 'places'].filter((layer) =>
    text.includes(layer),
  );
  console.log(`Capas presentes: ${found.join(', ')}`);

  if (found.length === 0) throw new Error('El azulejo no contiene ninguna capa reconocible');
  console.log('\nArchivo válido.');
}

main().catch((error: unknown) => {
  console.error('\nArchivo inválido:', error);
  process.exitCode = 1;
});
