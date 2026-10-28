import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { colorDeTema } from '../../packages/ui/marca.vite';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));


/**
 * Copia el worker de MapLibre junto al paquete compilado.
 *
 * MapLibre v6 resuelve su worker EN TIEMPO DE EJECUCIÓN, como hermano de su
 * propio módulo:
 *
 *   const n = new URL('./maplibre-gl-worker.mjs', import.meta.url);
 *
 * Es una cadena construida al vuelo, así que Vite no puede detectarla y nunca
 * emite ese archivo. En desarrollo no se nota —`optimizeDeps.exclude` sirve
 * MapLibre desde `node_modules`, donde el hermano existe— pero compilado el
 * bundle vive en `/assets/` y pide `/assets/maplibre-gl-worker.mjs`, que no
 * está: la petición cae en el `index.html` del SPA, llega como `text/html` y
 * el navegador la rechaza por tipo MIME.
 *
 * El síntoma es un mapa en blanco con los controles intactos y un único
 * «Worker failed to load» en la consola, sin que falle ninguna tesela.
 *
 * Si algún día MapLibre cambia el nombre del archivo, esto rompe la
 * compilación en vez de publicar un mapa vacío: es la diferencia entre
 * enterarse al compilar o en producción.
 */
const NOMBRE_WORKER = 'assets/maplibre-gl-worker.mjs';

function copiarWorkerDeMapLibre(): Plugin {
  return {
    name: 'maplibre-worker',
    apply: 'build',
    generateBundle() {
      /*
       * Se busca por ruta y no con `require.resolve('maplibre-gl')`: el
       * paquete declara `exports` sin entrada CommonJS, así que resolverlo
       * por nombre falla. Con pnpm, `node_modules/maplibre-gl` es un enlace
       * al almacén y la ruta funciona igual.
       */
      const candidatos = [
        resolvePath('./node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs'),
        resolvePath('../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs'),
      ];

      let contenido: Buffer | undefined;
      for (const origen of candidatos) {
        try {
          contenido = readFileSync(origen);
          break;
        } catch {
          // Se prueba la siguiente ubicación.
        }
      }

      if (!contenido) {
        throw new Error(
          'No se encontró maplibre-gl-worker.mjs en ninguna de estas rutas:\n  ' +
            candidatos.join('\n  ') +
            '\nSin él el mapa compila pero sale en blanco; revisa si la versión cambió el nombre.',
        );
      }

      this.emitFile({
        type: 'asset',
        // Nombre exacto y sin hash: es el que MapLibre pide por su cuenta.
        fileName: NOMBRE_WORKER,
        source: contenido,
      });
    },

    /*
     * Comprobación de que el nombre sigue siendo el que MapLibre pide.
     *
     * Emitir el archivo no basta: si una versión futura cambia el nombre,
     * este plugin publicaría el viejo, MapLibre pediría el nuevo y el mapa
     * volvería a salir vacío sin que nadie se entere hasta producción. Se
     * busca la cadena en el paquete compilado; si no aparece, se rompe la
     * compilación, que es cuando cuesta barato.
     */
    writeBundle(_opciones, paquete) {
      const codigo = Object.values(paquete)
        .filter((salida) => salida.type === 'chunk')
        .map((salida) => (salida as { code: string }).code)
        .join('');

      if (!codigo.includes(NOMBRE_WORKER.replace('assets/', ''))) {
        throw new Error(
          'El paquete compilado ya no menciona ' +
            NOMBRE_WORKER.replace('assets/', '') +
            '. Probablemente MapLibre cambió el nombre de su worker: ' +
            'actualiza NOMBRE_WORKER o el mapa saldrá en blanco en producción.',
        );
      }
    },
  };
}

export default defineConfig({
  // La barra del navegador en el azul de marca (HU-UI-01).
  plugins: [react(), tailwindcss(), copiarWorkerDeMapLibre(), colorDeTema('--brand')],
  resolve: {
    alias: {
      '@': resolvePath('./src'),
      '@tax/shared': resolvePath('../../packages/shared/src/index.ts'),
      '@tax/ui': resolvePath('../../packages/ui/src/index.ts'),
    },
    // Una sola copia de React y del motor de animación en todo el árbol.
    dedupe: ['react', 'react-dom', 'motion'],
  },
  optimizeDeps: {
    /*
     * MapLibre crea un worker para procesar los azulejos. Al pre-empaquetarlo,
     * Vite reescribe la URL del worker y el navegador no lo encuentra: el
     * mapa queda en blanco sin más pista que «Worker failed to load».
     * Sirviéndolo tal cual, la ruta del worker sigue siendo la suya.
     */
    exclude: ['maplibre-gl'],
  },

  server: { port: 5173 },
  build: { target: 'es2022', sourcemap: true },
});
