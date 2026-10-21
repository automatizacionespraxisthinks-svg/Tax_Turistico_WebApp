import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Las pruebas de exclusividad tocan PostgreSQL de verdad: en CI eso lo
    // levanta Testcontainers, en local el docker-compose de desarrollo.
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // En serie: varias suites escribiendo a la vez sobre la misma base se
    // estorbarían y los fallos no dirían nada.
    fileParallelism: false,
    setupFiles: ['dotenv/config'],
  },
});
