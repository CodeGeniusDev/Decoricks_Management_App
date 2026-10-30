import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test'
import { CSRF_HEADER, FOUNDER_STATE, csrfFromState } from './helpers'

/**
 * Brief item 1d — the live-connection report, reproduced in the shipped bundle.
 *
 * The reported state was a dashboard reading "Offline" in red beside a header
 * reading "Online" in green, frozen on "updated 12:39 am" hours later, on a phone
 * with signal. Every assertion here is about that shape of failure, against the
 * production build on the disposable `decoricks_test` database (`playwright.config
 * .ts` webServer: `E2E_TEST_MODE=1`, no application database touched).
 *
 * WHY THE OUTAGE IS ARMED BEFORE THE FIRST NAVIGATION. A Playwright route only
 * intercepts requests that START after it is installed, and an EventSource that is
 * already open is not a request any more — it is a response still streaming. Arm
 * the routes on a loaded page and the "dead" stream carries on delivering for the
 * rest of the outage, so the page never actually fails and the test proves nothing
 * but its own setup. Blocking before `goto` means the very first dial is refused,
 * which is the state the report describes: a page that never got a carrier.
 *
 * WHAT "RECOVER" MEANS HERE, AND WHY EACH WAIT IS SHAPED BY THE BUG RATHER THAN
 * BY LUCK:
 *
 *   1. Both realtime carriers are taken down — the stream (`/api/events`) AND the
 *      polling fallback (`/api/sync/cursor`) — plus the page's own read, so no
 *      part of the screen can be quietly succeeding and no background timer can
 *      rescue it. The chip must then say what is actually true: a retrying word
 *      (`Reconnecting…`, or `Server is waking up…` while the cold-start window is
 *      still trying — `wake-retry.ts` owns that precedence). Not "Live", and above
 *      all not "Offline", which the browser contradicts.
 *   2. A change made during the outage must still be ABSENT for the duration of
 *      the outage. Without this clause the test would pass on a page that had
 *      quietly been syncing all along.
 *   3. Restoring the routes is the only intervention. No reload, no click, no
 *      navigation, and that is measured rather than asserted: the number of
 *      documents the browser fetched stays at one, and a token written into the
 *      page's own JS context is still there at the end (see
 *      `countDocumentLoads`, which is deliberately not the `framenavigated`
 *      counter `phase3-collab` uses — that one counts hydration's replaceState
 *      too, which is fine as a delta and wrong as an absolute).
 *   4. Recovery is then asserted on independent surfaces — the chip returns to
 *      `Live` (the stream itself, not merely the poll), the board paints a
 *      snapshot it never received, and a row created during the outage appears on
 *      a report page whose read had been failing for half a minute.
 *
 * A MutationObserver records every word the chip shows across the whole episode.
 * That is the honest way to test "never says Offline": the wrong assertion is
 * "it does not say Offline right now", which passes for a page that flapped
 * through the lie twice in the middle.
 *
 * Scoped to the `chromium` project like the other multi-page suites: this spec
 * holds one device with a real outage window, and running that three times over in
 * parallel against one free-tier instance buys nothing.
 */

const founderCsrf = () => csrfFromState(FOUNDER_STATE)
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * The dashboard's status chip. `:visible` because the header renders it twice —
 * the eyebrow copy below `sm` and the actions copy from `sm` up, one `<span>` each,
 * both reading the same `useConnectionView` label. The bare selector resolves to
 * the hidden one on a desktop viewport, which is what `responsive-fixes.spec.ts`
 * also guards against.
 */
const chip = (page: Page) => page.locator('span[title^="Realtime sync:"]:visible').first()

/**
 * The app-shell pill, which reads `navigator.onLine` and nothing else. Scoped to
 * the fixed `header` and matched by its own words because `role="status"` is also
 * used by the dashboard's cold-start notice and by the chat panel's chip — a bare
 * `header [role="status"]` is more than one element and a strict-mode failure.
 */
const browserStatus = (page: Page) =>
  page
    .locator('header')
    .getByRole('status')
    .filter({ hasText: /^(Online|Offline)$/ })

/** The words a connected device is allowed to be shown while it is being served nothing. */
const RETRYING_LABELS = /^(Reconnecting…|Server is waking up…|Connecting…)$/

/** Endpoints taken down for the outage: both carriers plus the page's own read. */
const CARRIERS = ['**/api/events**', '**/api/sync/cursor**']

/** A server that is up and refusing, which is what a dying host looks like. */
const failWith503 = (route: Route) =>
  route.fulfill({ status: 503, contentType: 'text/plain', body: 'e2e outage' })

/** Install the outage on a page before anything on it has been asked for. */
async function blackout(page: Page, paths: string[]): Promise<void> {
  for (const path of [...CARRIERS, ...paths]) await page.route(path, failWith503)
}

async function lift(page: Page, paths: string[]): Promise<void> {
  for (const path of [...CARRIERS, ...paths]) await page.unroute(path)
}

/**
 * Start recording every label the chip displays. The observer reads whichever
 * `<span>` comes first in the document because both instances of the chip render
 * the identical label from the identical hook — on desktop that node is the hidden
 * eyebrow copy, and `textContent` does not care about visibility.
 */
async function watchChip(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __chipLabels: string[] }
    w.__chipLabels = []
    const read = () => {
      const el = document.querySelector('span[title^="Realtime sync:"]')
      const text = (el?.textContent ?? '').trim()
      if (text && text !== w.__chipLabels[w.__chipLabels.length - 1]) w.__chipLabels.push(text)
    }
    read()
    // `document.body` outlives client-side navigation in the App Router, and the
    // chip comes and goes with the route — so observe the tree, not the node.
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    })
  })
}

const chipLabels = (page: Page) =>
  page.evaluate(() => (window as unknown as { __chipLabels: string[] }).__chipLabels)

/**
 * The instant the snapshot on screen was generated, to the second, as printed by
 * the Cash Position card ("as of 10/29/2026, 1:15:43 pm"). Second granularity is
 * the point: the header's `updated 12:39` line only moves once a minute, so it
 * cannot distinguish "re-read on its own" from "the same old payload".
 */
const snapshotInstant = (page: Page) =>
  page.evaluate(() => /\(as of ([^)]+)\)/.exec(document.body.innerText)?.[1] ?? '')

/** The header's freshness sentence, verbatim. */
const updatedSentence = (page: Page) =>
  page.evaluate(() => /·\s*updated[^\n]*/.exec(document.body.innerText)?.[0] ?? '')

/** Authenticated write as the Founder through the real API, bypassing page routes. */
async function asFounder(ctx: BrowserContext, path: string, data: unknown) {
  const res = await ctx.request.fetch(path, {
    method: 'POST',
    data,
    headers: { [CSRF_HEADER]: founderCsrf() },
  })
  const body = await res.json().catch(() => null)
  expect(res.status(), `POST ${path} → ${res.status()} ${JSON.stringify(body)}`).toBeLessThan(300)
  return body?.data
}

/** Count the times the document itself was fetched — the thing the brief forbids.
 *
 * MEASURED, NOT ASSUMED. The obvious device, a main-frame `framenavigated`
 * count, does not count documents: `page.goto('/')` fires it TWICE for one
 * document (the initial commit, then the App Router's hydration
 * `history.replaceState`), observed at +164ms and +460ms with exactly one
 * document request in between. `phase3-collab` gets away with the same counter
 * only because it compares it against itself across a send, i.e. a delta. An
 * absolute "the page was never reloaded" claim needs a device that reloads and
 * nothing else moves, so this suite counts `document` requests and, under it,
 * pins a token in the page's own JS context — a real reload is the only thing
 * that can wipe it.
 */
const countDocumentLoads = (page: Page) => {
  let documents = 0
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documents += 1
  })
  return () => documents
}

const IDENTITY_TOKEN = 'phase11-recovery-no-reload'

/**
 * Write the token into the loaded page; only a discarded document can lose it.
 *
 * This is the one place in the suite where `page.evaluate` is the point rather
 * than the anti-pattern Playwright warns about: the measurement IS whether the
 * page's own JS context survived. `addInitScript` would re-run the write on
 * reload and make the assertion pass unconditionally.
 */
const pinIdentity = (page: Page) =>
  page.evaluate((token) => {
    ;(window as unknown as { __phase11Identity: string }).__phase11Identity = token
  }, IDENTITY_TOKEN)

const identityIntact = (page: Page) =>
  page.evaluate(
    (token) => (window as unknown as { __phase11Identity?: string }).__phase11Identity === token,
    IDENTITY_TOKEN
  )

test.describe('phase 11 — the live connection recovers without a reload', () => {
  test.describe.configure({ mode: 'serial' })

  test('both carriers down from the first paint degrades the chip honestly and the board heals itself', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Own contexts; run once')
    test.setTimeout(240_000)

    const device = await browser.newContext({ storageState: FOUNDER_STATE })
    const dash = await device.newPage()
    const loads = countDocumentLoads(dash)

    await blackout(dash, ['**/api/dashboard**'])
    await dash.goto('/')
    await pinIdentity(dash)
    await watchChip(dash)

    // ---- the outage ----------------------------------------------------------
    /*
     * The contradiction the report was built on: a green "Online" in the shell
     * next to a chip that must NOT claim the browser is offline. `Connecting…` is
     * tolerated only as a transient because a refused first dial lands on
     * `Reconnecting…` the moment the fallback is tried too.
     */
    await expect(chip(dash)).toHaveText(RETRYING_LABELS, { timeout: 20_000 })
    await expect(browserStatus(dash)).toHaveText('Online')
    expect(await snapshotInstant(dash), 'a snapshot painted while nothing could be read').toBe('')

    // Hold it: long enough that any carrier that was going to sneak a delivery
    // through would have done it, and long enough for the cold-start window to
    // have spent several of its own attempts.
    await dash.waitForTimeout(25_000)
    await expect(chip(dash), 'the outage was not actually an outage').toHaveText(RETRYING_LABELS)
    expect(await snapshotInstant(dash)).toBe('')

    // ---- restore: the only intervention --------------------------------------
    await lift(dash, ['**/api/dashboard**'])

    /*
     * Exactly `Live` — not the polling word — so this is the stream recovering on
     * the transport's own reopen backoff, with nobody pressing anything. The
     * budget covers the longest pause either ladder can be sitting on (30s) plus
     * one round trip.
     */
    await expect(chip(dash)).toHaveText('Live', { timeout: 90_000 })

    // The board paints a snapshot it was never able to ask for, on its own.
    await expect
      .poll(() => snapshotInstant(dash), {
        timeout: 90_000,
        message: 'the dashboard never re-read its snapshot on its own after the outage',
      })
      .not.toBe('')

    // The freshness line arrives with the data and says when the data is from.
    const sentence = await updatedSentence(dash)
    expect(sentence, 'the header lost its last-updated line').toContain('updated')
    expect(sentence).not.toContain('out of date')

    // One document, whole episode — and the word "Offline" was never displayed.
    expect(loads(), 'a second document was fetched; recovery was not in place').toBe(1)
    expect(await identityIntact(dash), 'the page\u2019s JS context was thrown away').toBe(true)
    const labels = await chipLabels(dash)
    expect(labels, `chip label log: ${labels.join(' → ')}`).not.toContain('Offline')
    expect(labels.some((l) => RETRYING_LABELS.test(l))).toBe(true)

    await dash.close()
    await device.close()
  })

  test('a report page whose read kept failing picks up a change made during the outage', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Own contexts; run once')
    test.setTimeout(240_000)

    /*
     * Budgets rather than the dashboard, because this is the other half of item
     * 1c: the page is on `usePolling(..., { error })`, so every failed attempt
     * arms the capped ladder and the screen is entitled to heal even if the
     * realtime layer never tells it anything. The row below is the evidence that
     * a retry actually happened — not a timer that was always going to fire.
     */
    const device = await browser.newContext({ storageState: FOUNDER_STATE })
    const budgets = await device.newPage()
    const loads = countDocumentLoads(budgets)

    await blackout(budgets, ['**/api/budgets**'])
    await budgets.goto('/budgets')
    await pinIdentity(budgets)

    const name = `Outage budget ${uid()}`
    const start = new Date()
    const end = new Date(start.getTime() + 6 * 86_400_000)
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    await asFounder(device, '/api/budgets', {
      name,
      periodStart: iso(start),
      periodEnd: iso(end),
      categories: [{ category: 'meta_ads', budgeted: 100_000 }],
    })

    /*
     * `:visible` because the budgets screen renders its rows twice on purpose —
     * a card list below `sm` and a table from `sm` up, both carrying
     * `p[title={budget.name}]`. A bare selector resolves to two nodes per row and
     * a count assertion on it says nothing about the data; the same duplication
     * the Live chip has (see `chip` above).
     */
    const row = budgets.locator(`p[title="${name}"]:visible`)
    await expect(
      row,
      'the outage was not actually an outage — the list synced through'
    ).toHaveCount(0)

    // Half a minute of refusal: the ladder has to have spent 2s, 4s, 8s and 16s
    // of failing attempts inside this window before anything is restored.
    await budgets.waitForTimeout(30_000)
    await expect(row, 'a page rebuilt its list while its endpoint was down').toHaveCount(0)

    await lift(budgets, ['**/api/budgets**'])

    // One of the page's own retries, with no click and no reload, finds the row.
    await expect(row, 'the failed page never recovered its data on its own').toHaveCount(1, {
      timeout: 90_000,
    })
    expect(loads(), 'a second document was fetched; recovery was not in place').toBe(1)
    expect(await identityIntact(budgets), 'the page’s JS context was thrown away').toBe(true)

    await budgets.close()
    await device.close()
  })

  test('an ordinary navigation never puts Offline on the chip while the browser is online', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Own contexts; run once')
    test.setTimeout(120_000)

    const device = await browser.newContext({ storageState: FOUNDER_STATE })
    const page = await device.newPage()
    await page.goto('/')
    await expect(chip(page)).toHaveText(/^(Live|Updating every few seconds)$/, { timeout: 20_000 })
    await watchChip(page)

    /*
     * The original mismatch came from teardown, not from the network: the sync
     * coordinator stops the transport the moment its last subscriber unmounts,
     * which an ordinary client-side route change does, and `stop()` reported that
     * as `offline`. A connected device was shown a red Offline chip on the page it
     * had just navigated back to. So: leave the dashboard, come back, and read the
     * whole log.
     */
    await page.locator('a[href="/inventory"]').first().click()
    await expect(page).toHaveURL(/\/inventory$/)
    await page.locator('a[href="/"]').first().click()
    await expect(page).toHaveURL(/\/$/)

    /*
     * Whatever the transport is doing on the way back up, none of its honest
     * words is "Offline": the label a connected device may be shown is limited by
     * `connection-view.ts`, and the log above is what actually proves it.
     */
    await expect(chip(page)).toHaveText(
      /^(Live|Updating every few seconds|Connecting…|Reconnecting…|Server is waking up…)$/,
      { timeout: 20_000 }
    )
    const labels = await chipLabels(page)
    expect(labels, `chip label log: ${labels.join(' → ')}`).not.toContain('Offline')

    await page.close()
    await device.close()
  })
})
