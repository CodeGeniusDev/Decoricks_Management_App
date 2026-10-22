import { expect, test, type Page } from '@playwright/test'

/**
 * Phase 2 — contextual help and guided workflows.
 *
 * Each assertion here maps to an acceptance criterion from the usability brief:
 *  - Finance, Budgets, Profit Distribution, Reconciliation and Sync each own a
 *    `HelpPanel` explaining the behaviour that is actually implemented.
 *  - The panel opens on a first visit and stays dismissed once closed (per-page
 *    key in localStorage), so it informs without nagging.
 *  - The disclosure is a real button: keyboard operable, `aria-expanded` /
 *    `aria-controls` correct, and opening it reloads nothing and refetches nothing.
 *  - Field-level help in the transaction form follows the selected entry type.
 *  - Shorthand terms are programmatically described, not only visually tooltiped.
 *  - Reconciliation's checks stay readable on a phone.
 *
 * The suite runs against a production build, and nothing here writes data — the
 * panels are read-only UI.
 */

const PANELS: Array<{ path: string; title: string }> = [
  { path: '/finance', title: 'How to read this page' },
  { path: '/budgets', title: 'How budgeting works here' },
  { path: '/distributions', title: 'How a distribution works' },
  { path: '/reconciliation', title: 'What this page actually checks' },
  // Curly quotes are the real label: the app writes “sync”, not "sync".
  { path: '/sync', title: 'What “sync” means here' },
]

/** Drops remembered help state so "first visit" behaviour is reproducible. */
async function resetHelpPreferences(page: Page) {
  await page.goto('/finance')
  await page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('decoricks:help:')) window.localStorage.removeItem(key)
    }
  })
}

const panel = (page: Page, title: string) => page.locator(`[data-help-title="${title}"]`)
const panelToggle = (page: Page, title: string) => panel(page, title).getByRole('button')

test.describe('contextual help panels', () => {
  for (const { path, title } of PANELS) {
    test(`${path} explains itself instead of leaving the page a puzzle`, async ({ page }) => {
      await resetHelpPreferences(page)
      await page.goto(path)

      const toggle = panelToggle(page, title)
      await expect(toggle).toBeVisible()
      // Purpose panels open on the first visit.
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(toggle).toHaveText(/Hide this explanation/)
      // What it discloses is a workflow or a set of definitions, not filler text.
      await expect(panel(page, title).locator('ol, dl').first()).toBeVisible()
    })
  }

  test('a dismissed panel stays dismissed, and re-opening is remembered too', async ({ page }) => {
    await resetHelpPreferences(page)
    await page.goto('/budgets')

    const toggle = panelToggle(page, 'How budgeting works here')
    await toggle.click()

    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toHaveText('How budgeting works here')
    expect(await page.evaluate(() => localStorage.getItem('decoricks:help:budgets'))).toBe('0')

    await page.reload()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await page.evaluate(() => localStorage.getItem('decoricks:help:budgets'))).toBe('1')
  })

  test('the disclosure is keyboard operable and never reloads the page', async ({ page }) => {
    await resetHelpPreferences(page)
    await page.goto('/sync')

    // A marker on window survives toggles; a page reload would wipe it.
    await page.evaluate(() => {
      ;(window as unknown as { __helpMarker?: string }).__helpMarker = 'alive'
    })

    const toggle = panelToggle(page, 'What “sync” means here')
    await toggle.focus()
    await expect(toggle).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Space')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // Focus stays where the reader put it rather than being stolen or reset.
    await expect(toggle).toBeFocused()

    const regionId = (await toggle.getAttribute('aria-controls'))!
    expect(regionId, 'toggle labels the region it controls').toBeTruthy()
    await expect(page.locator(`#${regionId}`)).toBeVisible()
    expect(
      await page.evaluate(() => (window as unknown as { __helpMarker?: string }).__helpMarker)
    ).toBe('alive')
  })
})

test.describe('transaction form guidance', () => {
  test('the type explanation follows the type that is selected', async ({ page }) => {
    await resetHelpPreferences(page)
    await page.goto('/finance/transactions?new=1')

    const dialog = page.getByRole('dialog', { name: /New transaction/ })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Type')).toBeVisible()

    await expect(dialog.getByRole('button', { name: 'What does “Income” mean?' })).toBeVisible()
    await expect(dialog.getByText('This decides what the entry does to your money')).toBeVisible()

    await dialog.getByLabel('Type').selectOption('expense')

    // The help is about the type now on screen, and the dialog never re-opened.
    const typeHelp = dialog.getByRole('button', { name: 'What does “Expense” mean?' })
    await expect(typeHelp).toBeVisible()
    await expect(dialog).toBeVisible()

    await typeHelp.click()
    await expect(dialog.getByText(/only Income and Expense affect profit/)).toBeVisible()
  })
})

test.describe('accessible terminology', () => {
  test('a focused term is described by its tooltip', async ({ page }) => {
    await page.goto('/finance')

    const term = page.locator('span[tabindex="0"]').filter({ hasText: 'Operating profit' }).first()
    await expect(term).toBeVisible()

    await term.focus()
    const describedBy = await term.getAttribute('aria-describedby')
    expect(describedBy, 'a focused term points at its tooltip').toBeTruthy()

    const tooltip = page.locator(`[id="${describedBy}"]`)
    await expect(tooltip).toHaveAttribute('role', 'tooltip')
    await expect(tooltip).toContainText('Revenue minus expenses')

    // Out of focus there is no dangling description for a screen reader to read.
    await term.evaluate((element) => element.blur())
    await expect(term).not.toBeFocused()
    expect(await term.getAttribute('aria-describedby')).toBeNull()
  })
})

test.describe('reconciliation on a phone', () => {
  test('the same checks are readable without a scrolling table', async ({ page }) => {
    await resetHelpPreferences(page)
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto('/reconciliation')

    await expect(panelToggle(page, 'What this page actually checks')).toBeVisible()

    // Mobile gets the row cards; the seven-column table is hidden, not scrolled.
    await expect(page.getByRole('table')).toBeHidden()
    await expect(page.locator('ul.md\\:hidden > li').first()).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(0)

    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(page.getByRole('table')).toBeVisible()
  })
})
