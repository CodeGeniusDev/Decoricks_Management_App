import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    /*
     * Unit tests only. `src/e2e` holds Playwright specs, which run under the
     * Playwright runner (`npm run test:e2e`) — Vitest cannot execute them and
     * would report the whole file as a collection error.
     */
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['src/e2e/**', 'node_modules/**', '.next/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
