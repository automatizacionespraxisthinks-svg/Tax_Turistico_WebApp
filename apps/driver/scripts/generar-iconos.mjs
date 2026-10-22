import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Genera los iconos PNG de la PWA.
 *
 * Hacen falta PNG, no basta con el SVG: Chrome en Android **no considera
 * instalable** una aplicación cuyo manifiesto solo ofrece iconos SVG, así que
 * `beforeinstallprompt` no se dispara nunca y el conductor no ve por dónde
 * instalarla. Safari en iOS, por su parte, ignora los iconos del manifiesto
 * para la pantalla de inicio y usa `apple-touch-icon`.
 *
 * Se dibuja aquí en vez de rasterizar el SVG con una herramienta externa para
 * no depender de ImageMagick ni de `sharp`, que no están, y para que los
 * iconos sean reproducibles: el repositorio guarda el dibujo, no solo el
 * resultado.
 *
 *   node apps/driver/scripts/generar-iconos.mjs
 */

const AQUI = dirname(fileURLToPath(import.meta.url));
const DESTINO = join(AQUI, '../public');

const FONDO = [0x16, 0x18, 0x1d];
const TRAZO = [0xe9, 0xea, 0xee];

/** Se dibuja a 4× y se promedia: así los bordes salen suaves sin más. */
const MUESTREO = 4;

/* ------------------------------------------------------------ geometría */

const distanciaASegmento = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const largo = dx * dx + dy * dy;
  const t = largo === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / largo));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
};

/** Distancia al borde de un rectángulo redondeado, negativa por dentro. */
const distanciaARectangulo = (px, py, w, h, r) => {
  const qx = Math.abs(px - w / 2) - (w / 2 - r);
  const qy = Math.abs(py - h / 2) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

/**
 * El dibujo, en el sistema de coordenadas del SVG original (64×64): el techo
 * de dos trazos y el punto debajo.
 */
function pintar(tamano, { redondeado }) {
  const escala = tamano / 64;
  const pixeles = Buffer.alloc(tamano * tamano * 3);

  // Mismas coordenadas que `public/icon.svg`.
  const radio = redondeado ? 14 : 0;
  const grosor = redondeado ? 5 : 4.5;
  const [ax, ay] = redondeado ? [16, 44] : [20, 41];
  const [mx, my] = redondeado ? [32, 16] : [32, 22];
  const [bx, by] = redondeado ? [48, 44] : [44, 41];
  const [cx, cy] = redondeado ? [32, 44.5] : [32, 41.5];
  const radioPunto = redondeado ? 4.5 : 3.8;

  for (let y = 0; y < tamano; y++) {
    for (let x = 0; x < tamano; x++) {
      let dentroFondo = 0;
      let dentroTrazo = 0;

      for (let sy = 0; sy < MUESTREO; sy++) {
        for (let sx = 0; sx < MUESTREO; sx++) {
          const px = (x + (sx + 0.5) / MUESTREO) / escala;
          const py = (y + (sy + 0.5) / MUESTREO) / escala;

          if (distanciaARectangulo(px, py, 64, 64, radio) <= 0) dentroFondo++;

          const enTecho =
            Math.min(
              distanciaASegmento(px, py, ax, ay, mx, my),
              distanciaASegmento(px, py, mx, my, bx, by),
            ) <= grosor / 2;
          const enPunto = Math.hypot(px - cx, py - cy) <= radioPunto;
          if (enTecho || enPunto) dentroTrazo++;
        }
      }

      const total = MUESTREO * MUESTREO;
      const aFondo = dentroFondo / total;
      const aTrazo = dentroTrazo / total;

      const i = (y * tamano + x) * 3;
      for (let canal = 0; canal < 3; canal++) {
        // Fuera del fondo queda negro; como los PNG van sin transparencia,
        // el recorte redondeado se ve sobre el fondo oscuro del sistema.
        const base = FONDO[canal] * aFondo;
        pixeles[i + canal] = Math.round(base * (1 - aTrazo) + TRAZO[canal] * aTrazo);
      }
    }
  }

  return pixeles;
}

/* ----------------------------------------------------------------- PNG */

const CRC = (() => {
  const tabla = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = tabla[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function trozo(tipo, datos) {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(cuerpo));
  return Buffer.concat([largo, cuerpo, crc]);
}

function png(tamano, pixeles) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tamano, 0);
  ihdr.writeUInt32BE(tamano, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // color verdadero, sin alfa
  // Cada fila lleva delante su byte de filtro; 0 es «sin filtro».
  const filas = Buffer.alloc(tamano * (tamano * 3 + 1));
  for (let y = 0; y < tamano; y++) {
    const origen = y * tamano * 3;
    const destino = y * (tamano * 3 + 1);
    filas[destino] = 0;
    pixeles.copy(filas, destino + 1, origen, origen + tamano * 3);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr),
    trozo('IDAT', deflateSync(filas, { level: 9 })),
    trozo('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- salida */

mkdirSync(DESTINO, { recursive: true });

const iconos = [
  // Chrome exige al menos uno de 192 y otro de 512 para considerarla instalable.
  { archivo: 'icon-192.png', tamano: 192, redondeado: true },
  { archivo: 'icon-512.png', tamano: 512, redondeado: true },
  // El enmascarable va a sangre: Android le aplica su propia forma encima.
  { archivo: 'icon-maskable-512.png', tamano: 512, redondeado: false },
  // iOS ignora el manifiesto para esto y recorta él las esquinas.
  { archivo: 'apple-touch-icon.png', tamano: 180, redondeado: false },
];

for (const { archivo, tamano, redondeado } of iconos) {
  const datos = png(tamano, pintar(tamano, { redondeado }));
  writeFileSync(join(DESTINO, archivo), datos);
  console.log(`  ${archivo.padEnd(24)} ${tamano}×${tamano}  ${(datos.length / 1024).toFixed(1)} KB`);
}

console.log('\nListo. Los SVG se conservan para el favicon del navegador.');
