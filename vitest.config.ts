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
     * Same reasoning as `testTimeout`, aimed at the other half of a suite: eight
     * files under `src/lib` stand up a real `mongodb-memory-server` and stop it in
     * `afterAll`. Killing a mongod child process is I/O the full run competes for —
     * every one of those suites tears down at roughly the same moment, and a
     * `server.stop()` that takes longer than the 10s default fails the GATE while
     * every single test in the file has passed, which is the worst possible failure
     * mode because the code under test is not what broke. Measured on a full local
     * run: `phase8-reconciliation` took 28.6s with the suite running beside it and
     * its `afterAll` blew the 10s limit while all four of its tests passed; the same
     * file run alone is green.
     */
    hookTimeout: 60_000,
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
