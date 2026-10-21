import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
