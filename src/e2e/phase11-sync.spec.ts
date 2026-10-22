import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { AFNAN_STATE, CSRF_HEADER, FOUNDER_STATE, csrfFromState } from './helpers'

/**
 * Phase 5 §3 — cross-device synchronisation, verified in the shipped bundle.
 *
 * `phase7-realtime.spec.ts` proved the *tasks* path. These specs cover the
 * modules that had never been observed in two simultaneous authenticated
 * sessions: Inventory, Sales, Finance and the permission-scoping of the sync
 * transport itself, plus the two claims the brief refuses to accept on trust:
 *
 *   1. **The live path really is the SSE stream** (not the poll). The connection
 *      chip reads exactly "Live" only when a frame arrives over `/api/events`;
 *      a poll that is carrying updates reads "Live · syncing", and only a
 *      carrier that has delivered nothing yet reads "Reconnecting…". Reading the
 *      `hello` frame directly additionally proves the stream is authorised per
 *      caller, not per deployment.
 *   2. **Nothing is lost when the stream dies.** With `/api/events` blocked the
 *      page must still converge through the polling carrier, and the update
 *      made during the outage must still be there once the stream returns.
 *
 * Everything here goes through the real HTTP surface: separate browser contexts
 * are separate cookie jars = separate devices, `authorize()` gates run for real,
 * writes land in the isolated `decoricks_test` MongoDB, and the reading session
 * never reloads or navigates after its first `goto`.
 *
 * Scoped to the `chromium` project (the other two projects skip) for the same
 * reason as the other multi-context suites: each spec drives two sessions and
 * writes shared state, so one deterministic sequence per run keeps the row
 * counts, cursor values and role mutations unambiguous.
 */

const founderCsrf = () => csrfFromState(FOUNDER_STATE)
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * The chat page's connection chip, the only UI that reports the delivery mode.
 * It is reached through the conversation panel's header because the app shell's
 * fixed page header carries its own `role="status"` indicator reading "Online"
 * — a bare `header [role="status"]` matches both and fails strict mode.
 */
const statusChip = (page: Page) => page.locator('section > header > [role="status"]')

/** A `PKR 1234.56` string for paisa, matching `formatPaisa` exactly. */
const pkr = (paisa: number): string => `PKR ${(paisa / 100).toFixed(2)}`

/** Authenticated write as the Founder through the real API; returns `.data`. */
async function asFounder(
  ctx: BrowserContext,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  data?: unknown
) {
  const res = await ctx.request.fetch(path, {
    method,
    data,
    headers: { [CSRF_HEADER]: founderCsrf() },
  })
  const body = await res.json().catch(() => null)
  expect(res.ok(), `${method} ${path} → ${res.status()} ${JSON.stringify(body)}`).toBeTruthy()
  return body?.data
}

/**
 * Open a second, independent SSE stream from inside `page` and return the
 * parsed `hello` frame — the server's own statement of which modules it will
 * signal to *this* caller. The reader is cancelled immediately so a test never
 * leaks a stream (each one holds a bus subscription on the free-tier host).
 */
async function readHello(page: Page): Promise<{ modules: string[] }> {
  const text = await page.evaluate(async () => {
    const res = await fetch('/api/events', { credentials: 'same-origin' })
    if (!res.ok || !res.body) return `HTTP ${res.status}`
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // eslint-disable-next-line no-await-in-loop
    while (!buffer.includes('event: hello')) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
    void reader.cancel()
    return buffer
  })
  const data = /event: hello\ndata: (.+)/.exec(text)?.[1]
  expect(data, `no hello frame in stream head: ${text.slice(0, 300)}`).toBeTruthy()
  return JSON.parse(data!) as { modules: string[] }
}

/** Poll a numeric cursor for one module, as an unrelated third session would. */
async function cursorFor(ctx: BrowserContext, module: string): Promise<number | undefined> {
  const res = await ctx.request.get(`/api/sync/cursor?modules=${module}`)
  expect(res.ok(), `cursor poll ${module} → ${res.status()}`).toBeTruthy()
  const data = (await res.json()).data as Record<string, number>
  return data[module]
}

test.describe('phase 5 — cross-device synchronisation', () => {
  test.describe.configure({ mode: 'serial' })

  test("the live path is an open SSE stream, scoped to the caller's own permissions", async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Opens own contexts; run once')
    const device = await browser.newContext({ storageState: FOUNDER_STATE })
    const page = await device.newPage()
    await page.goto('/chat')

    // Exactly "Live" (not "Live · syncing", not "Reconnecting…") can only be
    // produced by a frame received on the EventSource: the change-stream
    // watcher is therefore alive on this host and the stream is the carrier.
    await expect(statusChip(page)).toHaveText('Live', { timeout: 20_000 })

    // And the scope the server agreed to serve is the caller's permission set.
    const hello = await readHello(page)
    expect(hello.modules.sort()).toEqual(
      ['tasks', 'chat', 'sales', 'inventory', 'finance', 'notifications'].sort()
    )

    await page.close()
    await device.close()
  })

  test('inventory: a remote create, count and archive update the open list with no reload', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Opens own contexts; run once')
    test.setTimeout(120_000)

    const writer = await browser.newContext({ storageState: FOUNDER_STATE }) // Abdullah
    const watcher = await browser.newContext({ storageState: AFNAN_STATE }) // teammate, view-only
    const page = await watcher.newPage()
    await page.goto('/inventory')

    const sku = `SYNC-${uid()}`
    const name = `Sync product ${sku}`
    const row = page.locator('tr:visible').filter({ hasText: sku })
    const sheikhupuraCell = row.locator('td').nth(1)

    // 1. CREATE — the row does not exist, then appears on its own.
    await expect(row).toHaveCount(0)
    const product = await asFounder(writer, 'POST', '/api/products', {
      sku,
      name,
      category: 'Accessories',
      cost: 10000,
      sellingPrice: 25000,
    })
    await expect(row, 'remote product never appeared without a reload').toHaveCount(1)

    // 2. EDIT — a counted stock movement changes a figure in the same row.
    await expect(sheikhupuraCell).toHaveText('0')
    await asFounder(writer, 'POST', '/api/stock', {
      productId: product._id,
      location: 'sheikhupura',
      countedQuantity: 7,
      reason: 'Phase 5 sync verification',
    })
    await expect(sheikhupuraCell, 'remote stock count never propagated').toHaveText('7')

    // 3. DELETE — count back to zero, then archive. The overview drops rows for
    //    archived products with nothing left on hand, so a live removal is the
    //    observable contract for a record leaving a module.
    await asFounder(writer, 'POST', '/api/stock', {
      productId: product._id,
      location: 'sheikhupura',
      countedQuantity: 0,
      reason: 'Phase 5 sync verification — cleared before archive',
    })
    await expect(sheikhupuraCell).toHaveText('0')
    await asFounder(writer, 'DELETE', `/api/products/${product._id}`)
    await expect(row, 'archived empty product was never removed from the list').toHaveCount(0)

    await page.close()
    await writer.close()
    await watcher.close()
  })

  test('sales: a remote order and its cancellation reach the watching session live', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Opens own contexts; run once')
    test.setTimeout(120_000)

    const writer = await browser.newContext({ storageState: FOUNDER_STATE })
    const watcher = await browser.newContext({ storageState: AFNAN_STATE })

    // Stock has to exist before an order can reserve it.
    const product = await asFounder(writer, 'POST', '/api/products', {
      sku: `SORD-${uid()}`,
      name: 'Sync order product',
      category: 'Accessories',
      cost: 10000,
      sellingPrice: 45000,
    })
    await asFounder(writer, 'POST', '/api/stock', {
      productId: product._id,
      location: 'sheikhupura',
      countedQuantity: 10,
      reason: 'Phase 5 sync verification',
    })

    const page = await watcher.newPage()
    await page.goto('/sales')

    const customer = `Sync Customer ${uid()}`
    const row = page.locator('tr:visible').filter({ hasText: customer })
    await expect(row).toHaveCount(0)

    const order = await asFounder(writer, 'POST', '/api/orders', {
      customerName: customer,
      customerPhone: '0300-0000000',
      customerCity: 'Lahore',
      customerAddress: '1 Test Street',
      items: [{ productId: product._id, quantity: 2 }],
      salesChannel: 'E2E Sync',
      shipFromLocation: 'sheikhupura',
    })
    await expect(row, 'remote order never appeared').toHaveCount(1)
    await expect(row).toContainText('Pending')

    // A status transition is the "editing" half of the requirement: the badge
    // must move on the other device without it touching the page.
    // POST /api/orders answers `{ order, replay }`, not the document itself.
    await asFounder(writer, 'PATCH', `/api/orders/${order.order._id}`, {
      orderStatus: 'cancelled',
    })
    await expect(row, 'remote cancellation never propagated').toContainText('Cancelled')
    // Selective update: the row moved, it was not duplicated by the refresh.
    await expect(row).toHaveCount(1)

    await page.close()
    await writer.close()
    await watcher.close()
  })

  test('finance: a remote ledger entry moves the on-screen balance to the authoritative figure', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Opens own contexts; run once')
    test.setTimeout(120_000)

    const writer = await browser.newContext({ storageState: FOUNDER_STATE })
    const watcher = await browser.newContext({ storageState: AFNAN_STATE })

    const accountName = `Sync Account ${uid()}`
    const opening = 100000 // PKR 1,000.00
    const account = await asFounder(writer, 'POST', '/api/finance/accounts', {
      name: accountName,
      kind: 'cash',
      openingBalance: opening,
    })

    const page = await watcher.newPage()
    await page.goto('/finance')
    // The overview lists accounts as cards *and* the newest entries below, and
    // an entry names its account — so a card is matched on name plus balance.
    const card = (balance: string) =>
      page.locator('li').filter({ hasText: accountName }).filter({ hasText: balance })
    // The account itself arriving with no reload is already the sync proof.
    await expect(card(pkr(opening)), 'remote account never appeared on the overview').toHaveCount(1)

    const income = 543210
    await asFounder(writer, 'POST', '/api/finance/transactions', {
      type: 'income',
      amount: income,
      date: new Date().toISOString().slice(0, 10),
      accountId: account._id,
      // The API takes the stored category name (`sales_revenue`); 'Sales
      // Revenue' is the label the UI select shows and nothing else.
      category: 'sales_revenue',
      note: `e2e sync income ${uid()}`,
    })

    // The figure the teammate sees must equal opening + the posted entry. This
    // is sync and ledger arithmetic checked in the same assertion.
    await expect(
      card(pkr(opening + income)),
      'remote ledger entry never moved the balance'
    ).toHaveCount(1)

    // …and it is the same number the API holds, i.e. the screen is not inventing
    // a client-side running total.
    const overview = await watcher.request.get('/api/finance/overview')
    expect(overview.ok()).toBeTruthy()
    const accounts = (await overview.json()).data.accounts as Array<{
      name: string
      balanceDisplay: string
    }>
    expect(accounts.find((a) => a.name === accountName)?.balanceDisplay).toBe(pkr(opening + income))

    await page.close()
    await writer.close()
    await watcher.close()
  })

  test('a revoked permission leaves the module out of a new stream and out of the cursor', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Mutates a shared role; run once')
    test.setTimeout(90_000)

    const founder = await browser.newContext({ storageState: FOUNDER_STATE })
    const partner = await browser.newContext({ storageState: AFNAN_STATE })
    const page = await partner.newPage()
    await page.goto('/chat') // a live session that is already connected

    const rolesRes = await founder.request.get('/api/roles')
    const roles = (await rolesRes.json()).data.roles as Array<{
      _id: string
      name: string
      permissions?: Record<string, Record<string, boolean>>
    }>
    const afnan = roles.find((r) => r.name === 'partner_afnan')!
    const originalInventory = afnan.permissions?.inventory ?? {}
    expect(originalInventory.view, 'fixture: Afnan starts able to view inventory').toBe(true)

    const setView = (view: boolean) =>
      founder.request.put(`/api/roles/${afnan._id}`, {
        headers: { [CSRF_HEADER]: founderCsrf() },
        data: { permissions: { inventory: { ...originalInventory, view } } },
      })

    try {
      // Baseline: a fresh stream for Afnan is offered the inventory module.
      expect((await readHello(page)).modules).toContain('inventory')

      const revoke = await setView(false)
      expect(revoke.status(), 'Founder must be able to revoke inventory.view').toBe(200)

      // The data behind the signal is unreachable on the very next request,
      // with the same session — no re-login, and the session itself survives.
      expect((await partner.request.get('/api/stock/summary')).status()).toBe(403)
      expect((await partner.request.get('/api/auth/me')).status()).toBe(200)

      // A stream opened *after* the revocation is never offered the module, so
      // not even a dataless "inventory changed" signal reaches it. (A stream
      // opened *before* keeps its connect-time scope until it reconnects — it
      // can only ever trigger a refetch, which is gated above.)
      await expect
        .poll(() => readHello(page).then((h) => h.modules.includes('inventory')), {
          timeout: 30_000,
          message: 'a new stream still included the revoked module',
        })
        .toBe(false)
      const cursor = await partner.request.get('/api/sync/cursor?modules=inventory,finance')
      expect(cursor.ok()).toBeTruthy()
      const data = (await cursor.json()).data as Record<string, number>
      expect(data.inventory).toBeUndefined()
      expect(typeof data.finance).toBe('number')
    } finally {
      const restore = await setView(true)
      expect(restore.status(), 'the revoked grant must be restored exactly').toBe(200)
      // Prove the restore took effect, so a later suite never sees a half-set role.
      await expect
        .poll(() => cursorFor(partner, 'inventory'), { timeout: 20_000 })
        .toBeGreaterThan(0)
      await page.close()
      await founder.close()
      await partner.close()
    }
  })

  test('with the stream blocked the page still syncs, and returns to Live without losing a change', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Opens own contexts; run once')
    test.setTimeout(150_000)

    const writer = await browser.newContext({ storageState: FOUNDER_STATE })
    const watcher = await browser.newContext({ storageState: AFNAN_STATE })
    // Two pages on one device: the connection chip only exists in the Chat
    // header, while the change it should carry is a stock row.
    const chatPage = await watcher.newPage()
    const stockPage = await watcher.newPage()

    // Simulate a host/proxy that will not carry a long-lived stream: every
    // /api/events attempt fails, so the transport must fall back to the cursor
    // poll and stay honest about it in the UI.
    await chatPage.route('**/api/events**', (route) => route.abort())
    await stockPage.route('**/api/events**', (route) => route.abort())
    await chatPage.goto('/chat')
    // "Live · syncing" is the polling carrier: sync is working, delivery is not
    // instant, and the UI says so instead of crying reconnecting forever.
    await expect(statusChip(chatPage)).toHaveText('Live · syncing', { timeout: 20_000 })

    await stockPage.goto('/inventory')
    const sku = `SB-${uid()}`
    const row = stockPage.locator('tr:visible').filter({ hasText: sku })
    await asFounder(writer, 'POST', '/api/products', {
      sku,
      name: `Blocked stream product ${sku}`,
      category: 'Accessories',
      cost: 1000,
      sellingPrice: 2000,
    })
    // The polling carrier advances on a 6 s interval (`createPollingTransport`),
    // so its guarantee is "within a couple of intervals", not "instantly". The
    // global 10 s expect budget is shorter than one interval plus an Atlas round
    // trip, which is why this line failed mid-suite (two workers hammering one
    // free-tier cluster) while passing with the spec run alone.
    await expect(row, 'polling fallback did not carry a remote change').toHaveCount(1, {
      timeout: 20_000,
    })

    // Recovery: the stream becomes reachable again, the transport re-opens it,
    // and a change made after recovery still arrives with no reload. Exact
    // "Live" again means the EventSource, not the poll, is now the carrier.
    await chatPage.unroute('**/api/events**')
    await stockPage.unroute('**/api/events**')
    await expect(statusChip(chatPage)).toHaveText('Live', { timeout: 45_000 })

    const secondSku = `SB2-${uid()}`
    const secondRow = stockPage.locator('tr:visible').filter({ hasText: secondSku })
    await asFounder(writer, 'POST', '/api/products', {
      sku: secondSku,
      name: `Recovered product ${secondSku}`,
      category: 'Accessories',
      cost: 1000,
      sellingPrice: 2000,
    })
    await expect(secondRow, 'nothing was lost across the reconnect').toHaveCount(1)

    await chatPage.close()
    await stockPage.close()
    await writer.close()
    await watcher.close()
  })
})
