/**
 * Navigation probe — Phase 6 §1.1/§6.3.
 *
 * Measures what a sidebar-driven route change actually costs, against a real
 * production build (`next start`) with a real authenticated session:
 *
 *   - every `/api/` request a navigation issues, with its own duration;
 *   - how many of those requests are REPEATS of one already made in this
 *     session (the thing that makes a page "reload when its data has not
 *     changed");
 *   - how many times the `/api/events` stream is opened and torn down, which is
 *     the question `src/lib/sync/coordinator.ts` answers by refcounting
 *     subscribers;
 *   - time from click to the page heading, and from click to the last skeleton
 *     leaving the screen ("time to meaningful content").
 *
 * It is read-only: it navigates and observes. It never mutates a record, so it
 * is safe against a database that holds genuine data — but it is pointed at
 * `decoricks_test` by default for the same reason the e2e suite is.
 *
 * Usage:
 *   npx next build && npx next start -p 3111    # with E2E_TEST_MODE=1
 *   npx tsx scripts/nav-probe.ts               # baseline
 *   npx tsx scripts/nav-probe.ts --label after  # re-measure after a fix
 */
import { chromium } from '@playwright/test'

const BASE_URL = process.env.PROBE_BASE_URL ?? 'http://localhost:3111'
const EMAIL = process.env.E2E_FOUNDER_EMAIL ?? 'abdullah@decoricks.com'
const PASSWORD = process.env.E2E_PASSWORD ?? 'Decoricks2026'
const LABEL = process.argv.includes('--label')
  ? process.argv[process.argv.indexOf('--label') + 1]
  : 'baseline'
const ROUND_TRIPS = Number(process.env.PROBE_TRIPS ?? 2)
/*
 * 30s is generous against a production build and far too tight against `next dev`,
 * where the first request for a route pays for on-demand compilation. §1.2 needs
 * both measured, so the wait is configurable instead of hardcoded — without it the
 * dev run failed in the sign-in step and there was nothing to compare.
 */
const WAIT_MS = Number(process.env.PROBE_WAIT_MS ?? 30_000)

/** The sequence from the brief §6.1, walked by clicking the real sidebar links. */
const ROUTES: { path: string; label: string }[] = [
  { path: '/finance', label: 'Finance' },
  { path: '/inventory', label: 'Inventory' },
  { path: '/tasks', label: 'Tasks' },
  { path: '/chat', label: 'Chat' },
  { path: '/budgets', label: 'Budgets' },
  { path: '/sales', label: 'Sales' },
  { path: '/settings', label: 'Settings' },
  { path: '/', label: 'Dashboard' },
]

interface ApiCall {
  url: string
  method: string
  status: number
  /** ms from request start to the response's first byte. */
  ttfb: number
  /** ms for the whole exchange; Infinity-ish for a stream that never ends. */
  duration: number
  isStream: boolean
}

const ms = (n: number): string => (Number.isFinite(n) ? `${Math.round(n)}ms` : '—')
const median = (xs: number[]): number => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  const calls: ApiCall[] = []
  const streamOpens: { at: number; url: string }[] = []

  page.on('response', async (res) => {
    const url = res.url()
    if (!url.includes('/api/')) return
    const req = res.request()
    const timing = req.timing()
    const isStream = url.includes('/api/events')
    if (isStream) streamOpens.push({ at: Date.now(), url })
    calls.push({
      url: new URL(url).pathname + new URL(url).search,
      method: req.method(),
      status: res.status(),
      ttfb: timing.responseStart > 0 ? timing.responseStart : 0,
      duration: timing.responseEnd > 0 ? timing.responseEnd : timing.responseStart,
      isStream,
    })
  })

  // --- Sign in through the real form, then let the app settle. ---
  // `getByLabel('Password')` is a substring match and also hits the
  // "Show password" toggle, so the field is addressed by its id.
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' })
  await page.getByLabel('Email').fill(EMAIL)
  await page.locator('#login-password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: WAIT_MS })
  await page.waitForSelector('#main-content h1', { timeout: WAIT_MS })

  const results: {
    path: string
    toHeading: number
    toContent: number
    apiCalls: number
    repeatCalls: number
    streamOpens: number
    slowest: { url: string; ms: number }
  }[] = []

  for (let trip = 0; trip < ROUND_TRIPS; trip++) {
    for (const route of ROUTES) {
      const before = calls.length
      const streamsBefore = streamOpens.length

      // Click the sidebar link — a real client-side navigation, not a goto().
      const link = page.locator(`nav a[href="${route.path}"]`).first()
      const clickable = (await link.count()) > 0 && (await link.isVisible())

      const clickAt = Date.now()
      if (clickable) await link.click()
      else await page.goto(`${BASE_URL}${route.path}`) // documented fallback

      await page.waitForSelector('#main-content h1', { timeout: WAIT_MS })
      const toHeading = Date.now() - clickAt

      // "Meaningful content" = no loading placeholder left inside the page body.
      await page
        .waitForFunction(
          () => document.querySelectorAll('#main-content .animate-pulse').length === 0,
          undefined,
          { timeout: WAIT_MS }
        )
        .catch(() => undefined)
      const toContent = Date.now() - clickAt

      // Let late requests land so the counts are attributable to this navigation.
      await page.waitForTimeout(1200)

      const mine = calls.slice(before)
      const seenAlready = new Set(calls.slice(0, before).map((c) => c.url))
      const slowest = mine.reduce(
        (acc, c) => (c.duration > acc.ms ? { url: c.url, ms: c.duration } : acc),
        { url: '—', ms: 0 }
      )

      results.push({
        path: route.path,
        toHeading,
        toContent,
        apiCalls: mine.length,
        repeatCalls: mine.filter((c) => !c.isStream && seenAlready.has(c.url)).length,
        streamOpens: streamOpens.length - streamsBefore,
        slowest,
      })
    }
  }

  // --- Report ---
  console.log(`\n### nav-probe [${LABEL}] — ${BASE_URL} — ${ROUND_TRIPS} full circuit(s)`)
  console.log(
    `\n| # | route | → heading | → meaningful content | api calls | repeats | /api/events opens | slowest call |`
  )
  console.log(
    '|---|-------|-----------|----------------------|-----------|---------|-------------------|--------------|'
  )
  results.forEach((r, i) =>
    console.log(
      `| ${i + 1} | \`${r.path}\` | ${ms(r.toHeading)} | ${ms(r.toContent)} | ${r.apiCalls} | ${
        r.repeatCalls
      } | ${r.streamOpens} | \`${r.slowest.url}\` ${ms(r.slowest.ms)} |`
    )
  )

  const byPath = new Map<string, ApiCall[]>()
  for (const c of calls) {
    const key = c.url.split('?')[0]
    byPath.set(key, [...(byPath.get(key) ?? []), c])
  }
  console.log(`\n-- server-side cost per endpoint (median of ${LABEL}) --`)
  console.log('| endpoint | hits | median ttfb | median duration | max duration |')
  console.log('|----------|------|-------------|-----------------|--------------|')
  for (const [path, cs] of [...byPath.entries()].sort(
    (a, b) => median(b[1].map((c) => c.ttfb)) - median(a[1].map((c) => c.ttfb))
  )) {
    console.log(
      `| \`${path}\` | ${cs.length} | ${ms(median(cs.map((c) => c.ttfb)))} | ${ms(
        median(cs.map((c) => c.duration))
      )} | ${ms(Math.max(...cs.map((c) => c.duration)))} |`
    )
  }

  console.log(
    `\nTOTAL /api/events stream opens across ${results.length} navigations: ${streamOpens.length}` +
      `  (${(streamOpens.length / results.length).toFixed(2)} per navigation)`
  )
  console.log(
    `TOTAL api requests: ${calls.length}  (${(calls.length / results.length).toFixed(1)} per navigation)`
  )
  console.log(`Median → meaningful content: ${ms(median(results.map((r) => r.toContent)))}`)

  await browser.close()
}

main().catch((error) => {
  console.error('Probe failed:', error)
  process.exit(1)
})
