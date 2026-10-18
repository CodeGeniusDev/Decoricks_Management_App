import { test, expect, type Locator, type Page } from '@playwright/test'

/**
 * Phase 9 — Step 3 offline entry acceptance (design §9 test matrix):
 *
 *   1. Create while offline → the queue holds it → back online syncs it
 *      EXACTLY ONCE → exactly one ledger row.
 *   2. Mid-sync kill → the server had already applied the write while the
 *      tab died → crash-replay sends the SAME idempotency key → the ledger
 *      dedupes → still exactly one row (D3: exactly-once is structural).
 *   3. Two tabs share one queue: the row is visible in both, one drain wins
 *      the leader lock, and the entry lands once.
 *
 * Chromium only, serially: these tests are stateful and timing-sensitive
 * (offline emulation, the leader lock, the drain triggers), and the free-
 * tier test DB cannot take three device projects replaying them in parallel
 * without contention flakes. IndexedDB is per-context, so every test starts
 * with a genuinely empty queue.
 */

const setNativeValue = async (locator: Locator, value: string) => {
  await locator.evaluate((el, next) => {
    const input = el as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
  await expect(locator).toHaveValue(value)
}

// The transactions list sorts newest-first and the seeded E2E ledger lives
// in 2032 — post offline entries past everything so the row is on page one.
const entryDate = () => '2033-06-15'

/** Opens the create dialog while still ONLINE and waits for the reference
 *  data to arrive — going offline afterwards can never race the account or
 *  category fetches the form needs. */
const openEntryDialog = async (page: Page) => {
  await page.goto('/finance/transactions')
  await expect(page.getByRole('button', { name: 'New transaction' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'New transaction' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New transaction' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Account').locator('option', { hasText: 'Cash' })).toBeAttached({
    timeout: 15_000,
  })
  await expect(
    dialog.getByLabel('Category').locator('option', { hasText: 'Sales Revenue' })
  ).toBeAttached()
}

/** Fills the already-open create form and expects the offline toast. */
const createOfflineEntry = async (page: Page, note: string) => {
  const dialog = page.getByRole('dialog', { name: 'New transaction' })
  await dialog.getByLabel('Type').selectOption('income')
  await dialog.getByLabel('Amount (PKR)').fill('250')
  await setNativeValue(dialog.getByLabel('Date'), entryDate())
  await dialog.getByLabel('Account').selectOption({ label: 'Cash' })
  await dialog.getByLabel('Category').selectOption('sales_revenue')
  await dialog.getByLabel('Note').fill(note)
  await dialog.getByRole('button', { name: 'Save transaction' }).click()
  await expect(dialog).toHaveCount(0)
  // The queue accepted it — and the wording never says "saved" to the ledger.
  await expect(page.getByText('Saved offline')).toBeVisible()
}

const pendingChip = (page: Page): Locator =>
  page.getByRole('link', { name: /entries pending sync/ })

test.describe('phase 9 — offline financial entry', () => {
  test.describe.configure({ mode: 'serial' })

  test('an offline create syncs exactly once when the device comes back', async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Global state; run once')
    const note = `off-sync-${Date.now()}`

    // Wall off the sync endpoint BEFORE reconnecting: the automatic drain
    // parks on the gate, giving a deterministic window to observe the queue
    // between "created offline" and "server confirmed".
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let applied!: () => void
    const syncApplied = new Promise<void>((resolve) => (applied = resolve))
    await page.route('**/api/offline/sync', async (route) => {
      await gate
      await route.continue()
      applied()
    })

    await openEntryDialog(page)
    await context.setOffline(true)
    await createOfflineEntry(page, note)
    await expect(pendingChip(page)).toBeVisible()

    // Reconnect: the online trigger drains, the held POST completes.
    await context.setOffline(false)
    release()
    await syncApplied

    // The queue remembers: the row shows as Synced inside the display grace.
    await page.goto('/sync')
    await expect(page.getByText(note)).toBeVisible()
    await expect(page.getByText('Synced', { exact: true })).toBeVisible()

    // Server truth: exactly one ledger row for that note.
    await page.goto('/finance/transactions')
    await expect(page.getByRole('table').getByText(note)).toHaveCount(1)
  })

  test('a mid-sync kill replays with the same key — still one row', async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Global state; run once')
    const note = `off-crash-${Date.now()}`

    // First attempt: forward the POST so the SERVER applies the write, then
    // never answer the tab — the client's view of that request hangs until
    // the reload kills it. The stored row stays `syncing`: the crash trace
    // the next drain replays with the SAME idempotency key.
    let first = true
    let serverApplied!: () => void
    const applied = new Promise<void>((resolve) => (serverApplied = resolve))
    await page.route('**/api/offline/sync', async (route) => {
      if (first) {
        first = false
        await route.fetch()
        serverApplied()
        await new Promise(() => undefined) // the tab never learns the answer
        return
      }
      await route.continue() // the replay gets the honest dedupe answer
    })

    await openEntryDialog(page)
    await context.setOffline(true)
    await createOfflineEntry(page, note)
    await context.setOffline(false)

    await applied // the write is on the server; the client is about to die
    await page.reload()

    // Crash-recovery: the mount-time drain re-picks the `syncing` row, the
    // ledger's unique index replays the key, and the row lands as Synced.
    await page.goto('/sync')
    await expect(page.getByText(note)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Synced', { exact: true })).toBeVisible({ timeout: 30_000 })

    await page.goto('/finance/transactions')
    await expect(page.getByRole('table').getByText(note)).toHaveCount(1) // deduped, never doubled
  })

  test('two tabs share one queue: a single drain, one landed row', async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Global state; run once')
    const note = `off-tabs-${Date.now()}`

    // Count every sync POST that carries THIS entry (both tabs are caught).
    const posts: string[] = []
    await context.route('**/api/offline/sync', async (route) => {
      if (route.request().method() === 'POST') {
        try {
          const body = JSON.parse(route.request().postData() ?? '{}') as {
            idempotencyKey?: string
            payload?: { note?: string }
          }
          if (body.payload?.note === note && body.idempotencyKey) posts.push(body.idempotencyKey)
        } catch {
          // Not our envelope; let it continue below.
        }
      }
      await route.continue()
    })

    await openEntryDialog(page)
    await context.setOffline(true)
    await createOfflineEntry(page, note)

    // Tab B opens the Sync screen after reconnect — the queue is shared
    // device state, not per-tab memory, so B sees A's entry.
    const pageB = await context.newPage()
    await context.setOffline(false)
    await pageB.goto('/sync')
    await expect(pageB.getByText(note)).toBeVisible({ timeout: 30_000 })
    await expect(pageB.getByText('Synced', { exact: true })).toBeVisible({ timeout: 30_000 })

    // Leader lock: both tabs' triggers fired, only one ever got to POST.
    expect(new Set(posts).size).toBeLessThanOrEqual(1)
    expect(posts.length).toBe(1)

    // Tab A's chip resolves via the cross-tab event, and the row is singular.
    await expect(pendingChip(page)).toBeHidden()
    await pageB.goto('/finance/transactions')
    await expect(pageB.getByRole('table').getByText(note)).toHaveCount(1)
  })
})
