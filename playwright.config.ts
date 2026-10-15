import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 3111)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`
const founderState = path.join(__dirname, 'src/e2e/.auth/founder.json')

/**
 * E2E config.
 *
 * Runs against a production build by default: the layout bugs this suite guards
 * (double route animation, sidebar/content offset mismatch, missing drawer
 * handlers) only reproduce in the shipped bundle, because `next dev` recompiles
 * and masks some of them. Start the server yourself and point at it with
 * PLAYWRIGHT_BASE_URL, or let the webServer block boot it.
 *
 * The port is deliberately not 3000 — a stale dev server on 3000 silently serves
 * an old build, which makes every layout assertion pass or fail for the wrong
 * reason.
 */
const manageServer = process.env.PLAYWRIGHT_BASE_URL === undefined

export default defineConfig({
  testDir: './src/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Three projects run at once; an unbounded worker count makes the heavier
  // navigation loops contend for CPU and flake on timing assertions. Since
  // Phase 7 every context also holds a live SSE /api/events stream and the
  // server keeps an Atlas change-stream open per subscriber, so 4 workers
  // (12 concurrent contexts) overwhelm the single free-tier M0 instance and
  // write round-trips intermittently blow past their timeout. 2 workers is the
  // highest count that stays deterministic against the free-tier backend.
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? 'line' : 'html',
  timeout: 30_000,
  // Login is a bcrypt round-trip plus a DB hop; under load it can exceed the
  // 5s default.
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    // Runs first and saves an authenticated session for the projects below.
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: founderState },
      dependencies: ['setup'],
    },
    {
      name: 'Mobile Chrome',
      testMatch: /.*\.spec\.ts/,
      use: { ...devices['Pixel 5'], storageState: founderState },
      dependencies: ['setup'],
    },
    {
      name: 'Tablet',
      testMatch: /.*\.spec\.ts/,
      use: { ...devices['iPad Pro'], storageState: founderState },
      dependencies: ['setup'],
    },
  ],
  webServer: manageServer
    ? {
        // Boot order matters: seed the isolated `decoricks_test` database
        // first (scripts/seed-e2e.ts can only ever target a test-named DB),
        // then build and start the server against it. E2E_TEST_MODE +
        // MONGODB_TEST_DB make src/lib/mongodb.ts resolve the test database,
        // so the suite can never write into the application database.
        command: `npx tsx scripts/seed-e2e.ts && npx next build && npx next start -p ${PORT}`,
        env: {
          // Playwright exports NODE_ENV=test to spawned processes; a
          // production-mode build is what the suite must ship and start. The
          // test database stays protected by E2E_TEST_MODE (see src/lib/mongodb.ts).
          NODE_ENV: 'production',
          E2E_TEST_MODE: '1',
          MONGODB_TEST_DB: process.env.MONGODB_TEST_DB ?? 'decoricks_test',
        },
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
      }
    : undefined,
})
