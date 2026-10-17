import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { AFNAN_STATE, BASE_URL } from './helpers'

/**
 * Phase 8 Checkpoint 3 acceptance: report exports and the Founder-only
 * reconciliation panel.
 *
 *  - Export (METRICS §L): the weekly-summary screen offers CSV and PDF
 *    downloads; each is permission-checked + audit-logged server-side and
 *    carries the report's own figures ("export what I'm looking at").
 *  - Reconciliation (§H.2): the Founder sees the equality checks re-computed
 *    from the ledger; a Partner is refused both the screen and the API. The
 *    isolated test DB is seeded with no money, so the honest result is that
 *    every identity reconciles.
 */

const NAV = (page: import('@playwright/test').Page) =>
  page.getByRole('complementary', { name: 'Main navigation' })

test.describe('report exports (Founder)', () => {
  test('downloads a CSV carrying the report table', async ({ page }) => {
    await page.goto('/weekly-summary')
    await expect(page.getByRole('heading', { name: 'Weekly Summary' })).toBeVisible()

    const button = page.getByTestId('export-csv')
    await expect(button).toBeVisible()

    const download = await Promise.all([
      page.waitForEvent('download'),
      button.click(),
    ]).then(([d]) => d)

    expect(download.suggestedFilename()).toMatch(/decoricks-(week|month)-report-\d{4}-\d{2}-\d{2}\.csv/)
    const path = await download.path()
    const text = readFileSync(path!, 'utf8')
    expect(text).toContain('Section,Item,Value')
    expect(text).toMatch(/Sales,Revenue,PKR [\d.]+/)
  })

  test('downloads real PDF bytes', async ({ page }) => {
    await page.goto('/weekly-summary')
    const button = page.getByTestId('export-pdf')
    await expect(button).toBeVisible()

    const download = await Promise.all([
      page.waitForEvent('download'),
      button.click(),
    ]).then(([d]) => d)

    expect(download.suggestedFilename()).toMatch(/\.pdf$/)
    const buf = (await download.createReadStream())!
    const chunks: Buffer[] = []
    for await (const c of buf) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).subarray(0, 4).toString()).toBe('%PDF')
  })
})

test.describe('reconciliation (Founder)', () => {
  test('the Founder sees the equality checks reconcile on an empty ledger', async ({ page }) => {
    await page.goto('/reconciliation')
    await expect(page.getByRole('heading', { name: 'Reconciliation' })).toBeVisible()

    // With no money seeded, every cross-module identity is 0 = 0, so the panel
    // reports a clean pass rather than hiding behind an empty board.
    await expect(page.getByText(/All checks pass/i)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Pass').first()).toBeVisible()
  })

  test('the Reconciliation entry is in the Founder nav', async ({ page }) => {
    // Desktop width: below the `md` breakpoint the nav lives in an off-canvas
    // drawer, so the persistent `complementary` sidebar is not in the DOM.
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')
    await expect(NAV(page).getByRole('link', { name: /^Reconciliation$/ })).toBeVisible()
  })
})

test.describe('reconciliation denied (Partner)', () => {
  test.use({ storageState: AFNAN_STATE })

  test('a Partner does not see the Reconciliation entry', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')
    await expect(NAV(page).getByRole('link', { name: /^Reconciliation$/ })).toHaveCount(0)
  })

  test('a Partner opening the screen is refused', async ({ page }) => {
    await page.goto('/reconciliation')
    await expect(page.getByText('Founder-only screen')).toBeVisible()
  })

  test('a Partner calling the reconciliation API gets 403', async ({ playwright }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Server-side check; run once')
    const partner = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: AFNAN_STATE,
    })
    const res = await partner.get('/api/dashboard/reconciliation?period=month')
    expect(res.status()).toBe(403)
    await partner.dispose()
  })
})
