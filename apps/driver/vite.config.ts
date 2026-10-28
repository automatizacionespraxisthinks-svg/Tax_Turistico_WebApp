import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { colorDeMarca, colorDeTema } from '../../packages/ui/marca.vite';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // La barra del celular en tinta: continúa la cabecera (HU-UI-01).
    colorDeTema('--ink'),
    VitePWA({
      /*
       * `injectManifest` y no `generateSW`: el service worker generado no
       * admite manejadores propios, y sin un `push` dentro el teléfono no
       * recibe las ofertas con la aplicación cerrada (ADR-07).
       */
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      manifest: {
        name: 'Tax Turístico · Conductor',
        short_name: 'Conductor',
        description: 'Aplicación de carreras para conductores de Tax Turístico.',
        lang: 'es-CO',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        // Fondo de arranque con el de la app, para que no destelle al abrir.
        background_color: colorDeMarca('--bg'),
        theme_color: colorDeMarca('--ink'),
        /*
         * PNG y no solo SVG: Chrome en Android NO considera instalable una
         * aplicacion cuyo manifiesto solo ofrece iconos SVG, asi que
         * `beforeinstallprompt` no se dispara y el conductor no ve por donde
         * instalarla. Los 192 y 512 son el minimo que exige. Salen del logo
         * con `scripts/generar-iconos.mjs`.
         */
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // Las woff2 son Atkinson Hyperlegible: precacheadas, el conductor la
        // ve también sin conexión y no la que trae su celular.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
      // El service worker también en desarrollo: probar los avisos sin él
      // obligaría a compilar en cada cambio.
      devOptions: { enabled: true, type: 'module', navigateFallback: 'index.html' },
    }),
  ],
  resolve: {
    alias: {
      '@': resolvePath('./src'),
      '@tax/shared': resolvePath('../../packages/shared/src/index.ts'),
      '@tax/ui': resolvePath('../../packages/ui/src/index.ts'),
    },
    dedupe: ['react', 'react-dom', 'motion'],
  },
  server: { port: 5174 },
  build: { target: 'es2022', sourcemap: true },
});
