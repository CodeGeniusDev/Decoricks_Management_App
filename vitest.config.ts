import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    /*
     * bcrypt at cost factor 12 (the auth test) is deliberately slow and, when the
     * whole suite runs many workers on a busy CI machine, a single hash can exceed
     * the 5s default and flake the gate. The floor is raised so a genuinely slow
     * crypto assertion is not mistaken for a hang.
     */
    testTimeout: 20_000,
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
