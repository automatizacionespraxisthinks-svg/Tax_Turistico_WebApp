import { gzipSync } from 'node:zlib';

/**
 * Escritor de archivos PMTiles v3.
 *
 * El paquete `pmtiles` de npm solo lee; el escritor oficial es un binario de
 * Go. Como el formato está especificado y lo que hace falta aquí es un
 * archivo pequeño y de una sola pieza, se implementa: así el pipeline entero
 * corre con `pnpm` y no depende de instalar herramientas aparte en cada
 * máquina ni en CI.
 *
 * Formato: cabecera fija de 127 bytes, directorio raíz, metadatos y los
 * azulejos, todos en orden de identificador. Al estar ordenados y sin huecos
 * el archivo es «clustered», que es lo que permite al lector pedir rangos
 * contiguos por HTTP.
 *
 * Especificación: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 */

const HEADER_BYTES = 127;
const MAGIC = 'PMTiles';

export const Compression = { none: 1, gzip: 2 } as const;
export const TileType = { mvt: 1 } as const;

interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

/**
 * Identificador de azulejo según la curva de Hilbert.
 *
 * El orden de Hilbert agrupa en el archivo los azulejos que están cerca en el
 * mapa, de modo que mover el mapa se traduce en lecturas contiguas. Es la
 * razón de ser del formato; ordenarlos por z/x/y lo dejaría inservible.
 */
export function zxyToTileId(z: number, x: number, y: number): number {
  if (z > 26) throw new Error('Zoom fuera de rango para un entero seguro');

  // Azulejos acumulados de todos los niveles anteriores: (4^z - 1) / 3.
  let acc = 0;
  for (let t = 0; t < z; t++) acc += 4 ** t;

  let tx = x;
  let ty = y;
  let d = 0;

  for (let s = 2 ** (z - 1); s > 0; s = Math.floor(s / 2)) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);

    // Rotación del cuadrante.
    if (ry === 0) {
      if (rx === 1) {
        tx = s - 1 - tx;
        ty = s - 1 - ty;
      }
      const swap = tx;
      tx = ty;
      ty = swap;
    }
  }

  return acc + d;
}

/* ------------------------------------------------------------- varints --- */

function writeVarint(bytes: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v & 0x7f);
}

/** Serializa un directorio tal como lo espera el lector. */
function serializeDirectory(entries: Entry[]): Buffer {
  const bytes: number[] = [];
  writeVarint(bytes, entries.length);

  // Identificadores, en diferencias: ordenados, casi siempre consecutivos.
  let previousId = 0;
  for (const entry of entries) {
    writeVarint(bytes, entry.tileId - previousId);
    previousId = entry.tileId;
  }

  for (const entry of entries) writeVarint(bytes, entry.runLength);
  for (const entry of entries) writeVarint(bytes, entry.length);

  // Un 0 significa «justo después del anterior», que es el caso habitual.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const previous = i > 0 ? entries[i - 1]! : undefined;
    if (previous && entry.offset === previous.offset + previous.length) {
      writeVarint(bytes, 0);
    } else {
      writeVarint(bytes, entry.offset + 1);
    }
  }

  return Buffer.from(bytes);
}

/* ------------------------------------------------------------ archivo --- */

export interface TileInput {
  z: number;
  x: number;
  y: number;
  data: Buffer;
}

export interface ArchiveOptions {
  minZoom: number;
  maxZoom: number;
  bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  center: { lng: number; lat: number; zoom: number };
  metadata: Record<string, unknown>;
  /** Comprimir cada azulejo. Los MVT bajan a menos de la mitad. */
  compressTiles?: boolean;
}

export function buildArchive(tiles: TileInput[], options: ArchiveOptions): Buffer {
  const compressTiles = options.compressTiles ?? true;

  const prepared = tiles
    .map((tile) => ({
      tileId: zxyToTileId(tile.z, tile.x, tile.y),
      data: compressTiles ? gzipSync(tile.data, { level: 9 }) : tile.data,
    }))
    .sort((a, b) => a.tileId - b.tileId);

  /*
   * Azulejos idénticos se guardan una sola vez. En un mapa rural hay muchos
   * cuadrados vacíos o con el mismo trozo de carretera, así que la
   * deduplicación quita bastante peso.
   */
  const entries: Entry[] = [];
  const chunks: Buffer[] = [];
  const seen = new Map<string, { offset: number; length: number }>();
  let dataLength = 0;

  for (const tile of prepared) {
    const key = tile.data.toString('base64');
    const known = seen.get(key);

    if (known) {
      const last = entries[entries.length - 1];
      // Azulejos consecutivos con el mismo contenido se agrupan en una
      // sola entrada con `runLength`.
      if (last && last.offset === known.offset && last.tileId + last.runLength === tile.tileId) {
        last.runLength += 1;
      } else {
        entries.push({ tileId: tile.tileId, offset: known.offset, length: known.length, runLength: 1 });
      }
      continue;
    }

    const offset = dataLength;
    chunks.push(tile.data);
    dataLength += tile.data.length;
    seen.set(key, { offset, length: tile.data.length });
    entries.push({ tileId: tile.tileId, offset, length: tile.data.length, runLength: 1 });
  }

  const rootDirectory = serializeDirectory(entries);
  const metadata = Buffer.from(JSON.stringify(options.metadata), 'utf8');

  const rootOffset = HEADER_BYTES;
  const metadataOffset = rootOffset + rootDirectory.length;
  const leafOffset = metadataOffset + metadata.length;
  const tileDataOffset = leafOffset; // sin directorios hoja: todo cabe en la raíz

  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt8(3, 7);

  header.writeBigUInt64LE(BigInt(rootOffset), 8);
  header.writeBigUInt64LE(BigInt(rootDirectory.length), 16);
  header.writeBigUInt64LE(BigInt(metadataOffset), 24);
  header.writeBigUInt64LE(BigInt(metadata.length), 32);
  header.writeBigUInt64LE(BigInt(leafOffset), 40);
  header.writeBigUInt64LE(0n, 48);
  header.writeBigUInt64LE(BigInt(tileDataOffset), 56);
  header.writeBigUInt64LE(BigInt(dataLength), 64);

  const addressed = entries.reduce((sum, entry) => sum + entry.runLength, 0);
  header.writeBigUInt64LE(BigInt(addressed), 72);
  header.writeBigUInt64LE(BigInt(entries.length), 80);
  header.writeBigUInt64LE(BigInt(seen.size), 88);

  header.writeUInt8(1, 96); // clustered: los azulejos van en orden
  header.writeUInt8(Compression.none, 97); // compresión interna (directorios)
  header.writeUInt8(compressTiles ? Compression.gzip : Compression.none, 98);
  header.writeUInt8(TileType.mvt, 99);
  header.writeUInt8(options.minZoom, 100);
  header.writeUInt8(options.maxZoom, 101);

  const e7 = (value: number) => Math.round(value * 1e7);
  header.writeInt32LE(e7(options.bounds.minLng), 102);
  header.writeInt32LE(e7(options.bounds.minLat), 106);
  header.writeInt32LE(e7(options.bounds.maxLng), 110);
  header.writeInt32LE(e7(options.bounds.maxLat), 114);
  header.writeUInt8(options.center.zoom, 118);
  header.writeInt32LE(e7(options.center.lng), 119);
  header.writeInt32LE(e7(options.center.lat), 123);

  return Buffer.concat([header, rootDirectory, metadata, ...chunks]);
}
