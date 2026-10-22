/**
 * Single-route network diagnostic — Phase 6 §1.3.
 *
 * `perf-probe.ts` answers "how long did the screen take"; this answers "what did
 * the browser actually ask for while it took it", which is the question the brief
 * asks before anything is optimised. It records, for ONE hard document load and
 * ONE in-app click into a route:
 *
 *   - every /api request with its FULL url (query included, so two different
 *     windows of the same endpoint are not mistaken for a duplicate),
 *   - requests that never produced a response — the failure mode that pins a
 *     page at a probe's ceiling and is invisible in a server log,
 *   - the moment the last skeleton block left the DOM,
 *   - console errors and uncaught exceptions.
 *
 * Read-only: it navigates and observes, it never submits a form.
 *
 * Usage: npx tsx scripts/route-diag.ts /finance/transactions
 *        npx tsx scripts/route-diag.ts /finance/transactions --soft
 */
import { chromium, type Page, type Request, type Response } from '@playwright/test'

const BASE = process.env.PROBE_BASE_URL ?? 'http://localhost:3111'
const EMAIL = process.env.E2E_FOUNDER_EMAIL ?? 'abdullah@decoricks.com'
const PASSWORD = process.env.E2E_PASSWORD ?? 'Decoricks2026'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const ROUTE = args[0] ?? '/'
const SOFT_ONLY = process.argv.includes('--soft')
const WATCH_MS = Number(process.env.PROBE_WATCH_MS ?? 20_000)

interface Trace {
  url: string
  method: string
  type: string
  start: number
  end?: number
  status?: number
  bytes?: number
  failure?: string
}

/**
 * Drains one route and prints its request schedule. Every offset is relative to
 * `t0` — the click for an in-app transition, the `goto` for a document load — so
 * the two cases are directly comparable.
 *
 * Listeners are named and removed on the way out: the hard and soft cases run on
 * the same `Page`, and a leaked listener would charge the first route's requests
 * to the second one.
 */
async function trace(page: Page, t0: number, watchMs: number): Promise<Trace[]> {
  const traces = new Map<Request, Trace>()

  const onRequest = (req: Request) => {
    const url = req.url()
    if (url.includes('/api/events')) return // the stream is open by design
    const isApi = url.includes('/api/')
    // RSC prefetches (`?_rsc=`) are Next's own traffic, not data the user waits
    // for, but they are the requests most often aborted mid-navigation — which is
    // what a page that never "settles" actually runs into — so they are booked
    // separately rather than dropped.
    const isRsc = url.includes('_rsc')
    if (!isApi && !isRsc) return
    traces.set(req, {
      url: url.replace(BASE, ''),
      method: req.method(),
      type: isApi ? 'api' : 'rsc',
      start: Date.now() - t0,
    })
  }
  const onResponse = (res: Response) => {
    const t = traces.get(res.request())
    if (!t) return
    t.end = Date.now() - t0
    t.status = res.status()
    t.bytes = Number(res.headers()['content-length'] ?? 0)
  }
  const onFailed = (req: Request) => {
    const t = traces.get(req)
    if (t) t.failure = req.failure()?.errorText ?? 'failed'
  }

  page.on('request', onRequest)
  // The handlers are stored in locals so they can be detached below; Playwright
  // types each event's listener separately, hence the two casts.
  page.on('response', onResponse as never)
  page.on('requestfailed', onFailed as never)

  let skeletonMs = -1
  const deadline = Date.now() + watchMs
  while (Date.now() < deadline) {
    const busy = await page
      .evaluate(() => !!document.querySelector('[class*="animate-pulse"]'))
      .catch(() => true)
    if (!busy) {
      skeletonMs = Date.now() - t0
      break
    }
    await page.waitForTimeout(50)
  }
  // Keep watching past the skeleton: a late or aborted request is exactly what
  // the skeleton number alone cannot show.
  await page.waitForTimeout(Math.max(0, Math.min(3_000, deadline - Date.now())))

  page.off('request', onRequest)
  page.off('response', onResponse as never)
  page.off('requestfailed', onFailed as never)

  if (skeletonMs >= 0) console.log(`  last skeleton left the DOM at +${skeletonMs}ms`)
  else console.log(`  ⚠ a skeleton was still on screen after ${watchMs}ms`)

  return [...traces.values()].sort((a, b) => a.start - b.start)
}

function print(label: string, traces: Trace[]): void {
  const api = traces.filter((t) => t.type === 'api')
  console.log(`\n── ${label}: ${api.length} /api request(s), ${traces.length - api.length} RSC`)
  const byUrl = new Map<string, Trace[]>()
  for (const t of traces) byUrl.set(t.url, [...(byUrl.get(t.url) ?? []), t])

  for (const t of traces) {
    const dur = t.end === undefined ? null : t.end - t.start
    console.log(
      `  +${String(t.start).padStart(6)}ms ${t.method.padEnd(6)} ${String(t.status ?? '—').padStart(3)} ` +
        `${dur === null ? 'NO RESPONSE'.padEnd(13) : `${String(dur).padStart(6)}ms`.padEnd(13)}` +
        `${t.failure ? `✗ ${t.failure} ` : ''}${t.url}`
    )
  }
  const repeats = [...byUrl.entries()].filter(([, ts]) => ts.length > 1)
  console.log(
    `\n  exact-url repeats: ${
      repeats.length
        ? repeats.map(([u, ts]) => `${u} ×${ts.length}`).join('\n                     ')
        : 'none'
    }`
  )
  const unanswered = traces.filter((t) => t.end === undefined)
  console.log(
    `  never answered:    ${
      unanswered.length
        ? unanswered.map((t) => `${t.url}${t.failure ? ` (${t.failure})` : ''}`).join(', ')
        : 'none'
    }`
  )
}

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`))

  // Sign in through the HTTP API and inject the cookies, so the first document
  // request below is the route under test rather than the login flow.
  const res = await context.request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  })
  if (!res.ok()) throw new Error(`login failed: ${res.status()}`)

  if (!SOFT_ONLY) {
    const t0 = Date.now()
    await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' })
    print('HARD document load', await trace(page, t0, WATCH_MS))
  }

  // In-app navigation: start from the dashboard and click through the shell.
  const from = SOFT_ONLY ? ROUTE : '/'
  await page.goto(`${BASE}${from}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#main-content h1', { timeout: 30_000 })
  await page.waitForTimeout(1_500) // let the previous route go quiet before arming

  const clickAt = Date.now()
  const link = page.locator(`nav a[href="${ROUTE}"]`).first()
  if ((await link.count()) > 0 && (await link.isVisible())) {
    await link.click()
    console.log(`\n(soft case clicked the sidebar link for ${ROUTE})`)
  } else {
    await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' })
    console.log(`\n(soft case fell back to a document load — no sidebar link for ${ROUTE})`)
  }
  print('SOFT in-app navigation', await trace(page, clickAt, WATCH_MS))

  console.log(`\n── console errors / uncaught exceptions: ${errors.length || 'none'}`)
  for (const e of [...new Set(errors)].slice(0, 15)) console.log(`  ${e.slice(0, 240)}`)

  await browser.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
