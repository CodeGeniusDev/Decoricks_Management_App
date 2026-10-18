import { test, expect } from '@playwright/test'

/**
 * Phase 9 — Step 2 acceptance: the notification bell and its unread count.
 *
 * This spec is deliberately READ-ONLY. The three device projects (desktop,
 * Mobile Chrome, Tablet) run the whole suite concurrently against ONE shared
 * test database, and the parallel write specs (stock / ledger) can raise extra
 * notifications at any moment — so asserting an EXACT count would flake. What
 * is stable and what the brief actually requires is proven instead:
 *
 *   1. The bell is present in the header for an authenticated Founder.
 *   2. It reflects a non-zero unread count (the seed guarantees at least one),
 *      and — the "no glitch" requirement — the numeric badge and the accessible
 *      label are SELF-CONSISTENT (the same N, capped at 99+), so a screen
 *      reader and the pixel badge can never disagree.
 *   3. Opening it reveals the in-app centre: the seeded row is listed and the
 *      "Notification settings" door links to the preferences tab.
 *   4. No uncaught page errors during the flow (hydration / render crashes).
 *
 * It never clicks "mark all read" (that would zero the shared count out from
 * under the concurrent copies of this same test).
 */

test.describe('Phase 9 — notification bell', () => {
  test('shows a self-consistent unread count and opens the in-app centre', async ({ page }) => {
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => pageErrors.push(error))

    await page.goto('/')
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 20_000 })

    // The bell matches either the "no unread" or "N unread" accessible name.
    const bell = page.getByRole('button', { name: /^Notifications(, \d+ unread)?$/ })
    await expect(bell).toBeVisible()

    // Live fetch resolves to an unread-bearing label (the seed guarantees >= 1).
    await expect(bell).toHaveAttribute('aria-label', /^Notifications, \d+ unread$/, {
      timeout: 15_000,
    })

    // Badge and label agree on the SAME number (99+ beyond 99) — no drift.
    const label = (await bell.getAttribute('aria-label')) as string
    const count = Number(/(\d+) unread/.exec(label)?.[1] ?? '0')
    expect(count).toBeGreaterThan(0)
    const badge = bell.locator('span[aria-hidden="true"]')
    await expect(badge).toHaveText(count > 99 ? '99+' : String(count))

    // Open the in-app centre and confirm the seeded row + settings door render.
    await bell.click()
    const dialog = page.getByRole('dialog', { name: 'Notifications' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('E2E bell notification')).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Mark all read/ })).toBeVisible()
    await expect(
      dialog.getByRole('link', { name: /Notification settings/ })
    ).toHaveAttribute('href', /\/settings\?tab=notifications/)

    expect(pageErrors, `uncaught page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(
      0
    )
  })
})
