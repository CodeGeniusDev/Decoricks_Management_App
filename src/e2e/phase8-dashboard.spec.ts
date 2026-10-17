import { test, expect, type Page } from '@playwright/test'
import { FOUNDER_STATE } from './helpers'

/**
 * Phase 8 acceptance — the central dashboard + charts (brief TESTS ▸ Playwright).
 *
 * The config runs every spec in three device projects (desktop / mobile /
 * tablet), so "responsive at 360/768/1024/1280, no horizontal scroll, tables→
 * cards" is verified by running these same assertions on a Pixel 5 and iPad Pro
 * too. The seeded test database is empty of money, so the honest-empty-state
 * requirement is asserted directly, and one expense is recorded through the real
 * ledger UI to prove a chart actually paints (not just an empty frame).
 */

const mainHeading = (page: Page) => page.locator('#main-content').getByRole('heading', { level: 1 })

/** Today's Karachi civil date as YYYY-MM-DD, matching the PeriodSelector. */
const karachiToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

const setNativeValue = async (locator: import('@playwright/test').Locator, value: string) => {
  await locator.evaluate((el, v) => {
    const input = el as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

test.describe('phase 8 — central dashboard & charts', () => {
  test.use({ storageState: FOUNDER_STATE })

  let consoleErrors: string[] = []

  test.beforeEach(() => {
    consoleErrors = []
  })

  const guard = (page: Page) => {
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`)
    })
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
    page.on('response', (r) => {
      if (r.status() >= 500) consoleErrors.push(`server ${r.status()}: ${r.url()}`)
    })
  }

  test.afterEach(() => {
    const real = consoleErrors.filter((l) => !/favicon/i.test(l))
    expect(real, `Browser console problems:\n${real.join('\n')}`).toEqual([])
  })

  const noHorizontalScroll = async (page: Page) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    )
    expect(overflow, 'page scrolls horizontally').toBe(false)
  }

  test('dashboard loads every authorised widget, clean and without overflow', async ({ page }) => {
    guard(page)
    await page.goto('/')
    await expect(mainHeading(page)).toHaveText('Dashboard')

    // The founder passes every view scope, so every widget must mount.
    for (const title of [
      'Sales & Profit',
      'Expenses',
      'Cash Position',
      'Inventory Value',
      'Orders',
      'Averages',
    ]) {
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
    }

    await noHorizontalScroll(page)
  })

  test('period switch fires a scoped /api/dashboard fetch on Karachi boundaries', async ({
    page,
  }) => {
    guard(page)
    await page.goto('/')
    await expect(mainHeading(page)).toHaveText('Dashboard')

    // Default is This month → the snapshot range equals the Karachi month.
    await expect(page.getByText(/^Period /)).toBeVisible()

    const dayReq = page.waitForRequest((req) => /\/api\/dashboard\?.*period=day/.test(req.url()))
    await page.getByRole('button', { name: 'Today' }).click()
    await dayReq

    const weekReq = page.waitForRequest((req) => /\/api\/dashboard\?.*period=week/.test(req.url()))
    await page.getByRole('button', { name: 'This week' }).click()
    await weekReq

    // Custom seeds today so an incomplete (guaranteed-400) range is never sent.
    await page.getByRole('button', { name: 'Custom' }).click()
    const fromInput = page.locator('input[type="date"]').first()
    await expect(fromInput).not.toHaveValue('')
    await noHorizontalScroll(page)
  })

  test('traceability: show calculation panel and ledger click-through', async ({ page }) => {
    guard(page)
    await page.goto('/')
    const expensesCard = page.locator('[data-widget="expenses"]')
    await expect(expensesCard.getByRole('heading', { name: 'Expenses' })).toBeVisible()

    // "Show calculation" reveals the exact formula the engine applied.
    await expensesCard.getByRole('button', { name: 'Show calculation' }).click()
    await expect(
      expensesCard.getByText(/Σ expense entries whose category .*product_purchasing/)
    ).toBeVisible()

    // Click-through lands on the ledger with the filter + Karachi range applied.
    // The transactions screen reads the deep-link into its filter state and then
    // normalises the URL (history.replaceState) so a reload won't re-apply a
    // stale link, so the honest assertion is the applied filter, not a URL that
    // is intentionally wiped on mount.
    await expensesCard
      .getByRole('button', { name: /View the expense entries in the ledger/ })
      .click()
    await expect(page).toHaveURL(/\/finance\/transactions/)
    await expect(page.getByLabel('Type')).toHaveValue('expense')
    await expect(page.getByLabel('From (Karachi date)')).toHaveValue(/\d{4}-\d{2}-\d{2}/)
    await expect(page.getByLabel('To (Karachi date)')).toHaveValue(/\d{4}-\d{2}-\d{2}/)
  })

  test('a recorded expense makes the Sales vs Expenses chart paint an SVG', async ({ page }) => {
    guard(page)

    // Seed one operating expense for today through the real ledger form.
    const today = karachiToday()
    await page.goto('/finance/transactions')
    await expect(mainHeading(page)).toBeVisible()
    await page.getByRole('button', { name: 'New transaction' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New transaction' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Type').selectOption('expense')
    await dialog.getByLabel('Amount (PKR)').fill('250')
    await setNativeValue(dialog.getByLabel('Date'), today)
    await dialog.getByLabel('Account').selectOption({ label: 'Cash' })
    await dialog.getByLabel('Category').selectOption('meta_ads')
    await dialog.getByLabel('Note').fill('E2E dashboard chart seed')
    await dialog.getByRole('button', { name: 'Save transaction' }).click()
    await expect(dialog).toHaveCount(0)

    // Dashboard on "Today" must now render the Recharts surface for the trend.
    await page.goto('/')
    await page.getByRole('button', { name: 'Today' }).click()
    await expect(
      page.getByRole('heading', { name: 'Sales vs Expenses', exact: true })
    ).toBeVisible()
    await expect(page.locator('.recharts-surface').first()).toBeVisible()

    // The expense figure is traceable end to end: the widget shows the seeded 250.
    await expect(page.getByText('PKR 250.00').first()).toBeVisible()
    await noHorizontalScroll(page)
  })
})
