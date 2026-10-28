import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Genera, a partir del logo oficial, todo lo que la marca necesita en mapa
 * de bits: los iconos de la PWA, el aviso de Web Push, los favicon de las
 * dos aplicaciones y el logo de la barra lateral del panel (HU-UI-01).
 *
 * Hacen falta PNG, no basta con un SVG: Chrome en Android **no considera
 * instalable** una aplicación cuyo manifiesto solo ofrece iconos SVG, así que
 * `beforeinstallprompt` no se dispara nunca y el conductor no ve por dónde
 * instalarla. Safari en iOS, por su parte, ignora los iconos del manifiesto
 * para la pantalla de inicio y usa `apple-touch-icon`.
 *
 * Se hace aquí, leyendo y escribiendo el PNG a mano, para no depender de
 * ImageMagick ni de `sharp`, que no están, y para que los iconos sean
 * reproducibles: el repositorio guarda el original y la receta, no solo el
 * resultado.
 *
 * El original es hoy un PNG de 256 × 251 sacado de los documentos de la
 * empresa. Alcanza para la barra lateral (38 px, nítido hasta pantallas 3×),
 * pero el icono de 512 sale ampliado y pierde nitidez. Cuando llegue el logo
 * en vector: exportarlo a PNG de 1024 px con fondo transparente, reemplazar
 * `packages/ui/src/assets/logo-tax-turistico.png` y volver a correr esto.
 *
 *   node apps/driver/scripts/generar-iconos.mjs
 */

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '../../..');
const ORIGINAL = join(RAIZ, 'packages/ui/src/assets/logo-tax-turistico.png');
const TOKENS = join(RAIZ, 'packages/ui/src/styles/tokens.css');

/** Los colores salen del archivo de tokens: los hexadecimales solo viven allí. */
function colorDeMarca(nombre) {
  const css = readFileSync(TOKENS, 'utf8');
  const hallado = new RegExp(`${nombre}:\\s*#([0-9a-fA-F]{6})`).exec(css);
  if (!hallado) throw new Error(`No encuentro ${nombre} en tokens.css`);
  const hex = hallado[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/* ------------------------------------------------------------- PNG: leer */

/** Solo lo que hace falta: 8 bits por canal, RGB o RGBA, sin entrelazado. */
function leerPng(archivo) {
  const datos = readFileSync(archivo);
  let i = 8;
  let ancho = 0;
  let alto = 0;
  let tipo = 0;
  const idat = [];

  while (i < datos.length) {
    const largo = datos.readUInt32BE(i);
    const nombre = datos.toString('ascii', i + 4, i + 8);
    const cuerpo = datos.subarray(i + 8, i + 8 + largo);
    if (nombre === 'IHDR') {
      ancho = cuerpo.readUInt32BE(0);
      alto = cuerpo.readUInt32BE(4);
      tipo = cuerpo[9];
      if (cuerpo[8] !== 8 || (tipo !== 2 && tipo !== 6) || cuerpo[12] !== 0) {
        throw new Error('El logo tiene que ser PNG de 8 bits, RGB o RGBA, sin entrelazar');
      }
    } else if (nombre === 'IDAT') {
      idat.push(cuerpo);
    }
    i += 12 + largo;
  }

  const canales = tipo === 6 ? 4 : 3;
  const crudo = inflateSync(Buffer.concat(idat));
  const fila = ancho * canales;
  const salida = new Float64Array(ancho * alto * 4);
  let previa = Buffer.alloc(fila);

  for (let y = 0; y < alto; y++) {
    const filtro = crudo[y * (fila + 1)];
    const actual = Buffer.from(crudo.subarray(y * (fila + 1) + 1, (y + 1) * (fila + 1)));
    for (let x = 0; x < fila; x++) {
      const a = x >= canales ? actual[x - canales] : 0;
      const b = previa[x];
      const c = x >= canales ? previa[x - canales] : 0;
      const predicho =
        filtro === 1 ? a : filtro === 2 ? b : filtro === 3 ? (a + b) >> 1 : filtro === 4 ? paeth(a, b, c) : 0;
      actual[x] = (actual[x] + predicho) & 0xff;
    }
    for (let x = 0; x < ancho; x++) {
      const o = y * ancho * 4 + x * 4;
      const alfa = canales === 4 ? actual[x * 4 + 3] / 255 : 1;
      // Alfa premultiplicado: así los bordes no se tiñen al redimensionar.
      for (let k = 0; k < 3; k++) salida[o + k] = (actual[x * canales + k] / 255) * alfa;
      salida[o + 3] = alfa;
    }
    previa = actual;
  }

  return { ancho, alto, pixeles: salida };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/* ------------------------------------------------------- redimensionar */

/** Mitchell–Netravali (B = C = 1/3): nitidez sin el halo de Lanczos. */
function mitchell(x) {
  const B = 1 / 3;
  const C = 1 / 3;
  const t = Math.abs(x);
  if (t < 1) return ((12 - 9 * B - 6 * C) * t ** 3 + (-18 + 12 * B + 6 * C) * t ** 2 + (6 - 2 * B)) / 6;
  if (t < 2) return ((-B - 6 * C) * t ** 3 + (6 * B + 30 * C) * t ** 2 + (-12 * B - 48 * C) * t + (8 * B + 24 * C)) / 6;
  return 0;
}

/** Un pase en una dirección; se llama dos veces, una por eje. */
function pase(origen, anchoO, altoO, destino, horizontal) {
  const n = horizontal ? anchoO : altoO;
  const m = destino;
  const escala = n / m;
  const soporte = 2 * Math.max(1, escala);
  const anchoD = horizontal ? m : anchoO;
  const altoD = horizontal ? altoO : m;
  const salida = new Float64Array(anchoD * altoD * 4);

  for (let d = 0; d < m; d++) {
    const centro = (d + 0.5) * escala - 0.5;
    const desde = Math.max(0, Math.floor(centro - soporte));
    const hasta = Math.min(n - 1, Math.ceil(centro + soporte));
    const pesos = [];
    let suma = 0;
    for (let s = desde; s <= hasta; s++) {
      const w = mitchell((s - centro) / Math.max(1, escala));
      pesos.push(w);
      suma += w;
    }
    const otros = horizontal ? altoO : anchoO;
    for (let o = 0; o < otros; o++) {
      const acumulado = [0, 0, 0, 0];
      for (let s = desde; s <= hasta; s++) {
        const w = pesos[s - desde] / suma;
        const idx = horizontal ? (o * anchoO + s) * 4 : (s * anchoO + o) * 4;
        for (let k = 0; k < 4; k++) acumulado[k] += origen[idx + k] * w;
      }
      const out = horizontal ? (o * anchoD + d) * 4 : (d * anchoD + o) * 4;
      for (let k = 0; k < 4; k++) salida[out + k] = acumulado[k];
    }
  }
  return { ancho: anchoD, alto: altoD, pixeles: salida };
}

function redimensionar(imagen, ancho, alto) {
  const h = pase(imagen.pixeles, imagen.ancho, imagen.alto, ancho, true);
  return pase(h.pixeles, h.ancho, h.alto, alto, false);
}

/* ------------------------------------------------------------- componer */

/**
 * Un lienzo cuadrado con el logo centrado. `proporcion` es el lado mayor del
 * logo respecto al lienzo; `fondo`, un color de marca o nada (transparente).
 * Con `silueta`, solo cuenta la forma: blanco opaco donde hay logo, que es lo
 * que Android usa para el icono pequeño de la barra de avisos.
 */
function componer(logo, tamano, { proporcion = 1, fondo = null, silueta = false } = {}) {
  const lado = tamano * proporcion;
  const factor = lado / Math.max(logo.ancho, logo.alto);
  const ancho = Math.round(logo.ancho * factor);
  const alto = Math.round(logo.alto * factor);
  const chico = redimensionar(logo, ancho, alto);
  const ox = Math.round((tamano - ancho) / 2);
  const oy = Math.round((tamano - alto) / 2);

  const lienzo = new Float64Array(tamano * tamano * 4);
  if (fondo) {
    for (let p = 0; p < tamano * tamano; p++) {
      lienzo.set([fondo[0] / 255, fondo[1] / 255, fondo[2] / 255, 1], p * 4);
    }
  }

  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const o = (y * ancho + x) * 4;
      const d = ((y + oy) * tamano + (x + ox)) * 4;
      const alfa = Math.min(1, Math.max(0, chico.pixeles[o + 3]));
      for (let k = 0; k < 3; k++) {
        const color = silueta ? alfa : Math.min(1, Math.max(0, chico.pixeles[o + k]));
        lienzo[d + k] = color + lienzo[d + k] * (1 - alfa);
      }
      lienzo[d + 3] = alfa + lienzo[d + 3] * (1 - alfa);
    }
  }
  return { ancho: tamano, alto: tamano, pixeles: lienzo };
}

/* ----------------------------------------------------------- PNG: escribir */

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

/** RGBA de 8 bits. Cada fila elige el filtro que menos ocupa. */
function png({ ancho, alto, pixeles }) {
  const fila = ancho * 4;
  const bytes = Buffer.alloc(alto * fila);
  for (let p = 0; p < ancho * alto; p++) {
    const alfa = pixeles[p * 4 + 3];
    for (let k = 0; k < 3; k++) {
      // Se deshace el premultiplicado para guardar el color de verdad.
      const valor = alfa > 0 ? pixeles[p * 4 + k] / alfa : 0;
      bytes[p * 4 + k] = Math.round(Math.min(1, Math.max(0, valor)) * 255);
    }
    bytes[p * 4 + 3] = Math.round(Math.min(1, Math.max(0, alfa)) * 255);
  }

  const filas = Buffer.alloc(alto * (fila + 1));
  const vacia = Buffer.alloc(fila);
  for (let y = 0; y < alto; y++) {
    const actual = bytes.subarray(y * fila, (y + 1) * fila);
    const previa = y > 0 ? bytes.subarray((y - 1) * fila, y * fila) : vacia;
    let mejor = null;
    let costoMejor = Infinity;
    for (let filtro = 0; filtro <= 4; filtro++) {
      const candidato = Buffer.alloc(fila);
      let costo = 0;
      for (let x = 0; x < fila; x++) {
        const a = x >= 4 ? actual[x - 4] : 0;
        const b = previa[x];
        const c = x >= 4 ? previa[x - 4] : 0;
        const predicho =
          filtro === 1 ? a : filtro === 2 ? b : filtro === 3 ? (a + b) >> 1 : filtro === 4 ? paeth(a, b, c) : 0;
        const v = (actual[x] - predicho) & 0xff;
        candidato[x] = v;
        costo += v < 128 ? v : 256 - v;
      }
      if (costo < costoMejor) {
        costoMejor = costo;
        mejor = { filtro, candidato };
      }
    }
    filas[y * (fila + 1)] = mejor.filtro;
    mejor.candidato.copy(filas, y * (fila + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // color verdadero con alfa

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr),
    trozo('IDAT', deflateSync(filas, { level: 9 })),
    trozo('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- salida */

const logo = leerPng(ORIGINAL);
const blanco = colorDeMarca('--surface');

const PWA = join(RAIZ, 'apps/driver/public');
const PANEL = join(RAIZ, 'apps/admin/public');

const salidas = [
  // Chrome exige al menos uno de 192 y otro de 512 para considerarla
  // instalable. El logo ya es redondo: va a sangre y sin fondo.
  { archivo: join(PWA, 'icon-192.png'), tamano: 192 },
  { archivo: join(PWA, 'icon-512.png'), tamano: 512 },
  // El enmascarable lo recorta Android con su forma: el logo cabe en la zona
  // segura (el círculo del 80 %) y el resto es fondo blanco.
  { archivo: join(PWA, 'icon-maskable-512.png'), tamano: 512, proporcion: 0.76, fondo: blanco },
  // iOS rellena la transparencia de negro y recorta él las esquinas.
  { archivo: join(PWA, 'apple-touch-icon.png'), tamano: 180, proporcion: 0.88, fondo: blanco },
  // El icono pequeño de la barra de avisos: Android solo mira la forma.
  { archivo: join(PWA, 'badge-96.png'), tamano: 96, silueta: true },
  { archivo: join(PWA, 'favicon-32.png'), tamano: 32 },
  { archivo: join(PWA, 'favicon-16.png'), tamano: 16 },
  { archivo: join(PANEL, 'favicon-32.png'), tamano: 32 },
  { archivo: join(PANEL, 'favicon-16.png'), tamano: 16 },
  // Barra lateral del panel: se pinta a 38 px, así que 128 lo deja nítido
  // hasta en pantallas de densidad 3.
  { archivo: join(RAIZ, 'apps/admin/src/assets/logo-tax-turistico.png'), tamano: 128 },
];

for (const { archivo, tamano, ...opciones } of salidas) {
  mkdirSync(dirname(archivo), { recursive: true });
  const datos = png(componer(logo, tamano, opciones));
  writeFileSync(archivo, datos);
  console.log(`  ${relative(RAIZ, archivo).padEnd(52)} ${tamano}×${tamano}  ${(datos.length / 1024).toFixed(1)} KB`);
}

if (Math.max(logo.ancho, logo.alto) < 512) {
  console.log(
    `\nOjo: el original mide ${logo.ancho}×${logo.alto}. Los iconos de más de ese tamaño salen ampliados;` +
      '\nreemplázalo por una exportación de 1024 px del vector en cuanto exista.',
  );
}
