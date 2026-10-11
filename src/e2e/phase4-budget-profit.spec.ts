import { test, expect, type Locator, type Page } from '@playwright/test'
import { FOUNDER_STATE } from './helpers'

/**
 * Phase 4 acceptance: budgeting and profit tracking (brief TESTS section).
 *
 * Covered here, at desktop, mobile and tablet widths (the config runs every
 * spec in three device projects):
 *  1. Create a budget, add a ledger transaction, watch actual-vs-budget move,
 *     and open the "Show calculation" panel behind the figure.
 *  2. Run a monthly distribution end to end: calculate → adjustment →
 *     approve-and-lock → mark distributed, with the "adds up exactly" proof.
 *  3. Every Phase 4 screen loads with no console errors, no hydration
 *     warnings and no horizontal scroll.
 *
 * Parallel-safety: the three device projects run simultaneously against one
 * MongoDB, so each project owns its own far-future months (budgets in one,
 * distributions in another) and never touches another project's data. Spent
 * figures are asserted as deltas, so re-running the suite is deterministic
 * even though the seeded database is persistent.
 */

const MONTHS: Record<string, { budget: string; distribution: string }> = {
  chromium: { budget: '2031-01', distribution: '2032-01' },
  'Mobile Chrome': { budget: '2031-02', distribution: '2032-02' },
  Tablet: { budget: '2031-03', distribution: '2032-03' },
}

const monthBounds = (month: string) => {
  const [year, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate()
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}`, mid: `${month}-15` }
}

/**
 * React owns these inputs; `.fill()` on type=date/month can fight the browser
 * picker UI (and WebKit renders type=month as a plain field). Setting the
 * value through the native setter and dispatching `input` is what React's
 * onChange listens for, and it works identically in all three engines.
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

/** Reads a Metric's value paragraph — the sibling <p> under the label <p>. */
const readMetric = async (page: Page, label: string): Promise<string> => {
  const value = page
    .locator(`p:text-is("${label}")`)
    .locator('xpath=following-sibling::p[1]')
  return (await value.textContent()) ?? ''
}

/** 'PKR 1234.50' → 1234.5. formatPaisa never emits thousands separators. */
const parsePkr = (text: string): number => {
  const match = text.match(/PKR\s*(-?[\d.]+)/)
  if (!match) throw new Error(`Not a PKR amount: ${text}`)
  return parseFloat(match[1])
}

/** The page's own h1. The sticky Header mirrors the title, so scope to main. */
const mainHeading = (page: Page): Locator =>
  page.locator('#main-content').getByRole('heading', { level: 1 })

const postTransaction = async (
  page: Page,
  opts: { type: 'income' | 'expense'; amount: string; date: string; category: string; note: string },
) => {
  await page.goto('/finance/transactions')
  await expect(mainHeading(page)).toBeVisible()
  // .first(): on an empty ledger the EmptyState offers the same action.
  await page.getByRole('button', { name: 'New transaction' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New transaction' })
  await expect(dialog).toBeVisible()
  // Everything is scoped to the dialog — the page behind has its own
  // Type/Account/Category filters with the same labels.
  await dialog.getByLabel('Type').selectOption(opts.type)
  await dialog.getByLabel('Amount (PKR)').fill(opts.amount)
  await setNativeValue(dialog.getByLabel('Date'), opts.date)
  await dialog.getByLabel('Account').selectOption({ label: 'Cash' })
  await dialog.getByLabel('Category').selectOption(opts.category)
  await dialog.getByLabel('Note').fill(opts.note)
  await dialog.getByRole('button', { name: 'Save transaction' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText(/recorded/)).toBeVisible()
}

test.describe('phase 4 — budgeting and profit tracking', () => {
  test.use({ storageState: FOUNDER_STATE })

  let consoleErrors: string[] = []

  test.beforeEach(() => {
    consoleErrors = []
  })

  const guard = (page: Page) => {
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`console.error: ${message.text()}`)
    })
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
    // Pin any 4xx/5xx to its URL — 'Failed to load resource' alone is not
    // debuggable. GET reads of fresh data legitimately 401 before the session
    // cookie applies, so only 5xx are treated as defects.
    page.on('response', (response) => {
      if (response.status() >= 500) {
        consoleErrors.push(`server ${response.status()}: ${response.url()}`)
      }
    })
  }

  test.afterEach(() => {
    // Hydration warnings surface as console errors in a production build;
    // favicon 404 noise is the only tolerated message.
    const real = consoleErrors.filter((line) => !/favicon/i.test(line))
    expect(real, `Browser console problems:\n${real.join('\n')}`).toEqual([])
  })

  test('create a budget, add transactions, watch actuals move, open the calculation panel', async ({
    page,
  }, testInfo) => {
    guard(page)
    const month = (MONTHS[testInfo.project.name] ?? MONTHS.chromium).budget
    const bounds = monthBounds(month)
    const budgetName = `E2E ${month} ops budget`

    // Create — Founder-only form on the Budgets screen.
    await page.goto('/budgets')
    await expect(mainHeading(page)).toBeVisible()
    // .first(): with zero budgets the EmptyState offers the same action.
    await page.getByRole('button', { name: 'New budget' }).first().click()
    const createDialog = page.getByRole('dialog', { name: 'Create budget' })
    await expect(createDialog).toBeVisible()
    await createDialog.getByLabel('Name').fill(budgetName)
    await setNativeValue(createDialog.getByLabel('Start (Karachi)'), bounds.start)
    await setNativeValue(createDialog.getByLabel('End (Karachi)'), bounds.end)
    // exact: the allocation input's label contains 'category 1' too.
    await createDialog.getByLabel('Category 1', { exact: true }).selectOption('meta_ads')
    await createDialog.getByLabel('Allocation in PKR for category 1').fill('5000')
    await createDialog.getByRole('button', { name: 'Create budget' }).click()
    await expect(page.getByText(/created as a draft/)).toBeVisible()
    await expect(createDialog).toHaveCount(0)

    // Open the detail page from the row (table on desktop, card on mobile).
    await page.getByText(budgetName, { exact: true }).locator('visible=true').first().click()
    await expect(page).toHaveURL(/\/budgets\/[a-f0-9]{24}/)
    const detailUrl = page.url()

    // Allocated is exactly the typed PKR; spent comes from the ledger only.
    await expect
      .poll(async () => parsePkr(await readMetric(page, 'Allocated')), { timeout: 15_000 })
      .toBeCloseTo(5000, 2)
    const spentBefore = parsePkr(await readMetric(page, 'Spent (from ledger)'))

    // One ledger expense moves the actual figure — nothing was typed in.
    await postTransaction(page, {
      type: 'expense',
      amount: '1234.50',
      date: bounds.mid,
      category: 'meta_ads',
      note: 'E2E meta ads spend',
    })

    await page.goto(detailUrl)
    await expect
      .poll(async () => parsePkr(await readMetric(page, 'Spent (from ledger)')), { timeout: 15_000 })
      .toBeCloseTo(spentBefore + 1234.5, 2)
    const remaining = parsePkr(await readMetric(page, 'Remaining'))
    expect(remaining).toBeCloseTo(5000 - (spentBefore + 1234.5), 2)

    // Transparent calculation: the panel states the formula and the inputs.
    await page.getByRole('button', { name: /Show calculation · Total spent/ }).click()
    await expect(page.getByText('Formula:')).toBeVisible()
    await expect(page.getByText('Σ ledger expense entries dated inside the period')).toBeVisible()
    await expect(page.getByText('Period start (Karachi)')).toBeVisible()
    await page.getByRole('button', { name: /Hide calculation · Total spent/ }).click()
    await expect(page.getByText('Formula:')).toHaveCount(0)

    // Mobile layout guard: the table must not force horizontal page scroll.
    const scrolls = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    )
    expect(scrolls, 'budget detail page scrolls horizontally').toBe(false)
  })

  test('run a monthly distribution end to end', async ({ page }, testInfo) => {
    guard(page)
    const month = (MONTHS[testInfo.project.name] ?? MONTHS.chromium).distribution
    const bounds = monthBounds(month)

    // A month with real profit: income above expenses, all through the form.
    await postTransaction(page, {
      type: 'income',
      amount: '10000',
      date: bounds.mid,
      category: 'sales_revenue',
      note: 'E2E order revenue',
    })
    await postTransaction(page, {
      type: 'expense',
      amount: '4000',
      date: bounds.start,
      category: 'meta_ads',
      note: 'E2E ads for the distribution month',
    })

    // Calculate — a proposal, never automated: it only exists because the
    // Founder pressed the button for this Karachi month.
    await page.goto('/distributions')
    await expect(mainHeading(page)).toBeVisible()
    await setNativeValue(page.getByLabel('Month (Karachi)'), month)
    await page.getByRole('button', { name: 'Calculate distribution' }).click()
    await expect(page).toHaveURL(/\/distributions\/[a-f0-9]{24}/, { timeout: 20_000 })

    // The grand total must close no matter the run count: this line is the
    // UI-side rounding invariant (charity + finals + retained = net profit).
    const proof = page.getByText('Adds up exactly — no paisa lost or invented by rounding.')
    await expect(proof).toBeVisible()
    await expect(page.getByText('Mismatch — do not approve')).toHaveCount(0)

    // Net profit calculation panel.
    await page.getByRole('button', { name: /Show calculation · Net profit/ }).click()
    await expect(page.getByText('Net profit = net sales − COGS − operating expenses')).toBeVisible()
    await expect(page.getByRole('link', { name: /Verify against the ledger/ })).toBeVisible()
    await page.getByRole('button', { name: /Hide calculation · Net profit/ }).click()

    // A previously run month replays its stored record — mutation steps then
    // do not apply, and the suite stays re-runnable against one database.
    const isProposal = await page.getByText('Calculated — not approved').isVisible()
    if (isProposal) {
      // Adjustment: deduction from one partner, reason mandatory, whole month
      // re-split from the stored snapshot.
      await page.getByRole('button', { name: 'Add profit-share adjustment' }).click()
      const adjustDialog = page.getByRole('dialog', { name: 'Profit-share adjustment' })
      await expect(adjustDialog).toBeVisible()
      const partnerSelect = adjustDialog.getByLabel('Partner')
      const firstPartner = await partnerSelect.locator('option').first().textContent()
      await partnerSelect.selectOption({ label: firstPartner ?? '' })
      await adjustDialog.getByLabel('Direction').selectOption('deduction')
      await adjustDialog.getByLabel('Amount (PKR)').fill('100')
      await adjustDialog.getByLabel('Reason (required, audit-logged)').fill('E2E: test deduction')
      await adjustDialog.getByRole('button', { name: 'Apply adjustment' }).click()
      await expect(adjustDialog).toHaveCount(0)
      await expect(page.getByText('Adjustments were applied after the first calculation.')).toBeVisible()
      // No stale numbers: the proof still closes after the re-split.
      await expect(proof).toBeVisible()

      // Approve & lock — confirmed through the dialog, never one-click.
      await page.getByRole('button', { name: 'Approve & lock' }).click()
      const approveDialog = page.getByRole('dialog', { name: 'Approve and lock this distribution?' })
      await expect(approveDialog).toBeVisible()
      await approveDialog.getByRole('button', { name: 'Approve & lock' }).click()
      await expect(approveDialog).toHaveCount(0)
    }

    const isApproved = await page.getByText('Approved · locked').isVisible()
    if (isApproved) {
      await page.getByRole('button', { name: 'Mark distributed' }).click()
      const payDialog = page.getByRole('dialog', { name: 'Mark this distribution as paid out?' })
      await expect(payDialog).toBeVisible()
      await payDialog.getByRole('button', { name: 'Mark distributed' }).click()
      await expect(payDialog).toHaveCount(0)
    }

    // Locked for good: the proposal actions are gone.
    await expect(page.getByText('Distributed', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add profit-share adjustment' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Approve & lock' })).toHaveCount(0)
    await expect(proof).toBeVisible()

    const scrolls = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    )
    expect(scrolls, 'distribution detail page scrolls horizontally').toBe(false)
  })

  test('every phase 4 screen loads clean at this width', async ({ page }) => {
    guard(page)
    for (const route of ['/budgets', '/profit-loss', '/cash-flow', '/distributions']) {
      await page.goto(route)
      await expect(page.locator('#main-content')).toBeVisible()
      // Each screen renders its skeleton while loading and swaps it for the
      // real PageHeader once data (or an empty/error state) arrives.
      await expect(mainHeading(page)).toBeVisible({ timeout: 15_000 })
      const scrolls = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      )
      expect(scrolls, `${route} scrolls horizontally at ${page.viewportSize()?.width}px`).toBe(false)
    }
  })
})
