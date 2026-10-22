/**
 * Performance probe (Phase 4 §1: "measure before optimizing").
 *
 * Everything in this file is a measurement, not a claim. It drives the SAME
 * production build the e2e suite uses against the isolated `decoricks_test`
 * database, visits each route twice — once as a hard document load and once as
 * an in-app link click — and reports, per route:
 *
 *   documentMs      HTML round trip (server render + network)
 *   fcpMs           first contentful paint after navigation start
 *   skeletonMs      when the last `animate-pulse` block left the DOM. This is
 *                   the number the brief is actually about: the user sees
 *                   "loading" until this resolves, not until the document loads.
 *   interactiveMs   skeletonMs measured from the click (in-app navigation)
 *   apiCount        XHR/fetch requests issued by the screen
 *   apiMs           wall-clock span from the first API request to its response
 *   apiSum          sum of individual API durations (serialisation cost, i.e.
 *                   how much of apiMs is waiting one-after-another)
 *   slowest         the single worst API call and its url
 *   dupes           GET urls requested more than once in the same navigation
 *   jsKB            bytes of JS transferred for the route
 *   navs            document navigations observed (a full reload is the thing
 *                   Phase 4 §4 forbids, so it is counted, not assumed away)
 *
 * Each route is sampled `REPEATS` times and the MEDIAN is reported, because a
 * single sample against a shared free-tier Atlas instance is noise, not data.
 *
 * Usage:  npx tsx scripts/perf-probe.ts before   (writes /tmp/perf-before.json)
 *         npx tsx scripts/perf-probe.ts after    (writes /tmp/perf-after.json)
 *         npx tsx scripts/perf-probe.ts diff     (prints before/after table)
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Page,
  type Request,
  type Response,
} from '@playwright/test'
import fs from 'node:fs'

const BASE = process.env.PERF_BASE_URL ?? 'http://localhost:3111'
const EMAIL = process.env.E2E_FOUNDER_EMAIL ?? 'abdullah@decoricks.com'
const PASSWORD = process.env.E2E_PASSWORD ?? 'Decoricks2026'
const REPEATS = Number(process.env.PERF_REPEATS ?? 3)

/** The screens named in Phase 4 §7, plus the sub-pages reachable from them. */
const ROUTES: Array<{ path: string; label: string; anchor: string }> = [
  { path: '/', label: 'dashboard', anchor: 'Dashboard' },
  { path: '/finance', label: 'finance', anchor: 'Finance' },
  { path: '/finance/transactions', label: 'transactions', anchor: 'Transactions' },
  { path: '/finance/accounts', label: 'accounts', anchor: 'Accounts' },
  { path: '/finance/categories', label: 'categories', anchor: 'Categories' },
  { path: '/budgets', label: 'budgets', anchor: 'Budgets' },
  { path: '/cash-flow', label: 'cash-flow', anchor: 'Cash Flow' },
  { path: '/profit-loss', label: 'profit-loss', anchor: 'Profit' },
  { path: '/distributions', label: 'distributions', anchor: 'Distribution' },
  { path: '/reconciliation', label: 'reconciliation', anchor: 'Reconcil' },
  { path: '/inventory', label: 'inventory', anchor: 'Inventory' },
  { path: '/inventory/products', label: 'products', anchor: 'Products' },
  { path: '/inventory/movements', label: 'movements', anchor: 'Movements' },
  { path: '/inventory/purchases', label: 'purchases', anchor: 'Purchases' },
  { path: '/sales', label: 'sales', anchor: 'Sales' },
  { path: '/sales/returns', label: 'returns', anchor: 'Returns' },
  { path: '/tasks', label: 'tasks', anchor: 'Tasks' },
  { path: '/chat', label: 'chat', anchor: 'Chat' },
  { path: '/suppliers', label: 'suppliers', anchor: 'Suppliers' },
  { path: '/weekly-summary', label: 'weekly-summary', anchor: 'Weekly' },
  { path: '/sync', label: 'sync', anchor: 'Sync' },
  { path: '/settings', label: 'settings', anchor: 'Settings' },
  { path: '/profile', label: 'profile', anchor: 'Profile' },
]

interface Sample {
  documentMs: number
  fcpMs: number
  skeletonMs: number
  apiCount: number
  apiMs: number
  apiSum: number
  slowestMs: number
  slowestUrl: string
  dupes: string[]
  jsKB: number
  navs: number
  softNavs: number
  streams: number
  /** Data requests cancelled before an answer arrived (aborted superseded reads). */
  cancelled: number
  stuck: string[]
}

interface RouteResult {
  label: string
  path: string
  hard: Sample
  soft: Sample
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** Collapse a URL to its module path so `/messages?limit=50` variants group. */
const normalize = (url: string): string => url.replace(BASE, '').split('?')[0]

/** Sign in over HTTP and lift the cookies into the browser context. */
async function authenticatedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const res = await context.request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  })
  if (!res.ok()) throw new Error(`login failed: ${res.status()}`)
  // `cookies()` on the context keeps HttpOnly session cookies, which a
  // document.cookie injection could not carry.
  return context
}

/**
 * Block until the current screen has painted real content and no request is in
 * flight, then hold one quiet beat so a trailing fetch cannot leak into the
 * measurement that starts right after.
 */
async function waitForQuiescence(page: Page): Promise<void> {
  await page
    .waitForFunction(() => !document.querySelector('[class*="animate-pulse"]'), null, {
      timeout: 45_000,
    })
    .catch(() => undefined)
  await page.waitForTimeout(800)
}

/**
 * Instrument one navigation. `trigger` performs the load (goto or click) so the
 * same accounting works for both a document request and an in-app transition.
 */
async function measure(
  page: Page,
  beforeStart: () => void,
  trigger: () => Promise<void>,
  settleAnchor: string
): Promise<Sample> {
  let t0 = Date.now()
  const api: Array<{ url: string; start: number; end: number; bytes: number }> = []
  const pending = new Map<Request, number>()
  let navs = 0
  let softNavs = 0
  let lastActivity = t0
  let cancelled = 0
  let streams = 0
  /*
   * The warm-up navigation (`/login`, which client-redirects into the app for a
   * signed-in session) is still issuing its own requests when this measurement
   * begins, and page-level listeners survive a document change. Without this
   * gate those requests were attributed to the route under test and reported as
   * a duplicate — the phantom second `/api/notifications` on the dashboard.
   */
  let armed = false

  /** The realtime SSE channel is open by design; it must never gate "settled". */
  const isStream = (url: string): boolean => url.includes('/api/events')

  const onRequest = (request: Request) => {
    lastActivity = Date.now()
    // A full document request during a navigation is the thing Phase 4 §4 forbids.
    // `framenavigated` was counted before and it also fires on a soft (pushState)
    // navigation, so it reported 2 for every hard load and could not distinguish a
    // reload from a client-side route change. Document requests can only be a reload.
    if (armed && request.resourceType() === 'document') navs += 1
    if (!armed) return
    if (isStream(request.url())) {
      streams += 1
      return
    }
    // Only the screen's own data requests gate "settled". Next.js prefetches
    // (RSC `?_rsc=` fetches and route chunks) are not data the user waits for,
    // and a prefetch aborted by the navigation never produces a response — which
    // left the pending set non-empty and pinned the sample at the 45s ceiling.
    if (!request.url().includes('/api/')) return
    pending.set(request, Date.now())
  }
  const onResponse = (response: Response) => {
    const request = response.request()
    if (!armed) return
    if (isStream(request.url())) return
    const url = request.url()
    if (!url.includes('/api/')) {
      // Script bytes are read from the page's Resource Timing buffer after the
      // navigation instead of being accumulated here.
      return
    }
    const start = pending.get(request)
    if (start === undefined) return
    pending.delete(request)
    lastActivity = Date.now()
    if (url.includes('/api/')) {
      api.push({
        url: normalize(url),
        start: start - t0,
        end: Date.now() - t0,
        bytes: Number(response.headers()['content-length'] ?? 0),
      })
    }
  }
  const onNav = (frame: Frame) => {
    // Kept as a cross-check on the document counter: a soft navigation changes the
    // frame URL without requesting a document, which is the expected case.
    if (armed && frame === page.mainFrame()) softNavs += 1
  }
  /*
   * A cancelled request produces no response. Without this handler it stayed in
   * `pending` forever, `settled()` could never report true, and the sample was
   * pinned at the 45s ceiling while the screen itself had been painted for ages —
   * which the first baseline did on `/finance/transactions` (45022ms of "skeleton"
   * for a page whose data all landed inside 1.3s). Cancelling a superseded filter
   * change is legitimate, so it is counted rather than treated as a hang.
   */
  const onRequestFailed = (request: Request) => {
    if (!armed || isStream(request.url())) return
    if (!request.url().includes('/api/')) return
    if (!pending.delete(request)) return
    cancelled += 1
    lastActivity = Date.now()
  }

  page.on('request', onRequest)
  page.on('response', onResponse as never)
  page.on('framenavigated', onNav)
  page.on('requestfailed', onRequestFailed)

  // Start the clock only once the previous document has gone quiet, and drop
  // anything it had already put on the books.
  const armDeadline = Date.now() + 12_000
  while (Date.now() - lastActivity < 600 && Date.now() < armDeadline) {
    await page.waitForTimeout(100)
  }
  pending.clear()
  armed = true
  t0 = Date.now()

  beforeStart()
  await trigger()

  // The screen is "done" when no skeleton block remains AND every API request
  // it issued has come back. Both are polled with the clock already running, so
  // they are part of the number rather than a precondition for it. A route that
  // never settles still reports the ceiling, which is itself the finding.
  const deadline = t0 + 45_000
  const settled = async (): Promise<boolean> => {
    // Nothing in flight and nothing has happened for a beat.
    if (pending.size > 0 || Date.now() - lastActivity < 300) return false
    const skeleton = await page
      .evaluate(() => !!document.querySelector('[class*="animate-pulse"]'))
      .catch(() => true)
    if (skeleton) return false
    /*
     * A screen that issues no data request at all is legitimate, not stuck: the
     * Sync page reads its offline queue from IndexedDB (Dexie) and never touches
     * the API, so requiring "the page has started asking for data" pinned that
     * route at the 45s ceiling. It now settles once the content is painted and
     * the network has been quiet for a moment — the number is the transition, and
     * the small floor is the probe's own quiet window, not the app's.
     */
    if (api.length === 0) return Date.now() - t0 > 1_500
    return true
  }

  let skeletonMs = -1
  let stuck: string[] = []
  try {
    if (settleAnchor) {
      await page.waitForSelector(`text=${settleAnchor}`, { timeout: 15_000 }).catch(() => null)
    }
    while (Date.now() < deadline) {
      if (await settled()) break
      await page.waitForTimeout(50)
    }
    skeletonMs = Date.now() - t0
    // Whatever is still pulsing at the deadline is the finding itself, so name
    // it rather than just reporting a number.
    stuck = await page
      .evaluate(() =>
        [...document.querySelectorAll('[class*="animate-pulse"]')].slice(0, 8).map((el) => {
          const cls = (el.className ?? '').toString().split(' ').slice(0, 4).join(' ')
          const box = el.getBoundingClientRect()
          return `${el.tagName.toLowerCase()}.${cls} ${Math.round(box.width)}x${Math.round(box.height)}`
        })
      )
      .catch(() => [])
  } catch {
    skeletonMs = Date.now() - t0
  }

  const paints = await page.evaluate(() =>
    performance
      .getEntriesByType('paint')
      .filter((e) => e.name === 'first-contentful-paint')
      .map((e) => e.startTime)
  )
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined
    return n ? { responseEnd: n.responseEnd, domLoaded: n.domContentLoadedEventEnd } : null
  })

  /*
   * `response.body()` looked like the right way to count bundle bytes and reported
   * 0 KB for every route: Playwright evicts a response body once the navigation
   * commits, so the promise resolved with nothing. The browser's own Resource
   * Timing buffer is the authoritative source. `entry.responseEnd` is relative to
   * the document time origin, so it is converted to wall clock and compared with
   * the arming instant — a soft navigation must be charged only for the route
   * chunks it fetched, not for the document's initial scripts.
   */
  const observedJsBytes = await page
    .evaluate((since: number) => {
      const origin =
        typeof performance.timeOrigin === 'number'
          ? performance.timeOrigin
          : (performance.timeOrigin as unknown as Date).getTime()
      let total = 0
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      for (const entry of resources) {
        // A plain substring test on purpose: route chunks, the webpack runtime and
        // the framework scripts all end in `.js`, and nothing else does.
        const isScript = entry.name.includes('.js') || entry.initiatorType === 'script'
        if (!isScript) continue
        if (origin + entry.responseEnd <= since) continue
        total += Math.max(entry.decodedBodySize, entry.transferSize)
      }
      return total
    }, t0)
    .catch(() => 0)

  page.off('request', onRequest)
  page.off('response', onResponse as never)
  page.off('framenavigated', onNav)
  page.off('requestfailed', onRequestFailed)

  const counts = new Map<string, number>()
  for (const call of api) {
    if (!call.url.startsWith('/api/')) continue
    counts.set(call.url, (counts.get(call.url) ?? 0) + 1)
  }
  const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([u, n]) => `${u} ×${n}`)

  const slowest = api.reduce<(typeof api)[number] | undefined>(
    (worst, c) => (c.end - c.start > (worst ? worst.end - worst.start : 0) ? c : worst),
    api[0]
  )

  return {
    // `nav` is null for an in-app transition (no new document); that is exactly
    // the case where only the data pipeline matters.
    documentMs: nav ? Math.round(nav.domLoaded) : 0,
    fcpMs: paints.length ? Math.round(paints[0]) : 0,
    skeletonMs: Math.round(skeletonMs),
    apiCount: api.length,
    apiMs: api.length ? Math.round(Math.max(...api.map((c) => c.end))) : 0,
    apiSum: api.length ? Math.round(api.reduce((s, c) => s + (c.end - c.start), 0)) : 0,
    slowestMs: slowest ? Math.round(slowest.end - slowest.start) : 0,
    slowestUrl: slowest?.url ?? '',
    dupes,
    jsKB: Math.round(observedJsBytes / 1024),
    navs,
    softNavs,
    streams,
    cancelled,
    stuck,
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'before'

  if (mode === 'diff') {
    const before = JSON.parse(fs.readFileSync('/tmp/perf-before.json', 'utf8')) as RouteResult[]
    const after = JSON.parse(fs.readFileSync('/tmp/perf-after.json', 'utf8')) as RouteResult[]
    const pad = (s: string | number, n: number) => String(s).padEnd(n)
    console.log(
      pad('route', 18) +
        pad('hard before', 13) +
        pad('hard after', 13) +
        pad('Δ', 8) +
        pad('api before', 13) +
        pad('api after', 12) +
        'navs'
    )
    for (const b of before) {
      const a = after.find((r) => r.path === b.path)
      if (!a) continue
      const d = a.hard.skeletonMs - b.hard.skeletonMs
      console.log(
        pad(b.label, 18) +
          pad(`${b.hard.skeletonMs}ms`, 13) +
          pad(`${a.hard.skeletonMs}ms`, 13) +
          pad(`${d > 0 ? '+' : ''}${d}ms`, 8) +
          pad(`${b.hard.apiCount}`, 13) +
          pad(`${a.hard.apiCount}`, 12) +
          `${a.hard.navs}/${b.hard.navs}`
      )
    }
    return
  }

  const browser = await chromium.launch()
  const context = await authenticatedContext(browser)
  const results: RouteResult[] = []

  for (const route of ROUTES) {
    if (process.env.PERF_ONLY && !route.label.startsWith(process.env.PERF_ONLY)) continue
    const hardSamples: Sample[] = []
    const softSamples: Sample[] = []

    // Hard load: a fresh document with a cleared HTTP cache, which is what a
    // teammate returning to the app in the morning experiences.
    if (!process.env.PERF_SKIP_HARD) {
      for (let i = 0; i < REPEATS; i += 1) {
        const page = await context.newPage()
        await page.goto(`${BASE}/login`) // any page, so the clock starts from a neutral route
        hardSamples.push(
          await measure(
            page,
            () => {},
            async () => {
              await page.goto(`${BASE}${route.path}`, { waitUntil: 'commit' })
            },
            route.anchor
          )
        )
        await page.close()
      }
    }

    // In-app navigation: one click from an idle screen, no document request. This
    // is the "navigating between pages feels slow" path.
    for (let i = 0; i < REPEATS; i += 1) {
      const page = await context.newPage()
      // Start from a different route than the target — clicking "Dashboard" while
      // already on the dashboard fires no navigation at all, and the sample would
      // just time out. Sub-pages start from their own module page, which is where
      // their in-page link actually lives.
      const from =
        route.path === '/'
          ? '/suppliers'
          : route.path.split('/').length > 2
            ? `/${route.path.split('/')[1]}`
            : '/'
      await page.goto(`${BASE}${from}`, { waitUntil: 'domcontentloaded' })
      // The starting screen must be genuinely idle before the clock starts. Waiting
      // only for the header text to paint (the first version of this loop did)
      // clicks while that screen's OWN initial request is still in flight, and the
      // request then lands inside the next route's sample — measuring the previous
      // screen instead of the transition. The dashboard is now fast enough that the
      // leak showed up as a phantom `/api/dashboard` call on almost every sample.
      await waitForQuiescence(page)
      // Sidebar link when the route is in the rail, otherwise any in-page link
      // with that href (sub-pages such as /finance/transactions). A route with
      // no reachable link simply reports no soft sample.
      const target = page
        .locator(
          `aside[aria-label="Main navigation"] nav a[href="${route.path}"], a[href="${route.path}"]`
        )
        .first()

      if ((await target.count()) === 0) {
        await page.close()
        continue
      }

      softSamples.push(
        await measure(
          page,
          () => {},
          async () => {
            await target.click()
          },
          route.anchor
        )
      )
      await page.close()
    }

    const collapse = (samples: Sample[]): Sample => ({
      documentMs: median(samples.map((s) => s.documentMs)),
      fcpMs: median(samples.map((s) => s.fcpMs)),
      skeletonMs: median(samples.map((s) => s.skeletonMs)),
      apiCount: median(samples.map((s) => s.apiCount)),
      apiMs: median(samples.map((s) => s.apiMs)),
      apiSum: median(samples.map((s) => s.apiSum)),
      slowestMs: median(samples.map((s) => s.slowestMs)),
      slowestUrl: samples[0]?.slowestUrl ?? '',
      dupes: samples.find((s) => s.dupes.length)?.dupes ?? [],
      jsKB: median(samples.map((s) => s.jsKB)),
      // Worst case across samples: one reload in three is still a reload.
      navs: Math.max(...samples.map((s) => s.navs)),
      softNavs: Math.max(...samples.map((s) => s.softNavs)),
      streams: median(samples.map((s) => s.streams)),
      cancelled: median(samples.map((s) => s.cancelled ?? 0)),
      stuck: samples.find((s) => s.stuck.length)?.stuck ?? [],
    })

    results.push({
      label: route.label,
      path: route.path,
      hard: collapse(hardSamples),
      soft: collapse(softSamples),
    })

    const h = results[results.length - 1].hard
    console.log(
      `${route.label.padEnd(18)} hard ${String(h.skeletonMs).padStart(6)}ms  ` +
        `soft ${String(results[results.length - 1].soft.skeletonMs).padStart(6)}ms  ` +
        `api ${String(h.apiCount).padStart(2)} (sum ${String(h.apiSum).padStart(5)}ms, ` +
        `slowest ${String(h.slowestMs).padStart(5)}ms ${h.slowestUrl})  ` +
        `js ${String(h.jsKB).padStart(4)}KB  dupes: ${h.dupes.join(', ') || 'none'}`
    )
    if (h.stuck.length) console.log(`  ⚠ still loading at ceiling: ${h.stuck.join(' | ')})`)
    if (h.cancelled) console.log(`  ⓘ cancelled API requests: ${h.cancelled}`)
  }

  fs.writeFileSync(
    // PERF_SKIP_HARD keeps a soft-only re-run from clobbering a full result set.
    process.env.PERF_SKIP_HARD ? `/tmp/perf-${mode}-soft.json` : `/tmp/perf-${mode}.json`,
    JSON.stringify(results, null, 2)
  )
  await browser.close()
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
