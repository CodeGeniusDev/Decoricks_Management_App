import { test, expect } from '@playwright/test'
import {
  AFNAN_STATE,
  BASE_URL,
  CSRF_HEADER,
  E2E_PASSWORD,
  FOUNDER_EMAIL,
  FOUNDER_STATE,
  csrfFromState,
} from './helpers'

/**
 * Phase 2 acceptance: authentication, role-gated navigation, and the
 * "revocable, effective on the next request" permission requirement.
 *
 * The permission grant/revoke test mutates global role state, so it is
 * restricted to a single project to avoid three device projects racing on the
 * same role document.
 */

test.describe('authentication flow', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('rejects a wrong password, signs in, and signs out', async ({ page }) => {
    await page.goto('/login')

    await page.getByLabel('Email', { exact: true }).fill('nobody@decoricks.com')
    await page.getByLabel('Password', { exact: true }).fill('WrongPassword123')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)

    // Reload for a clean form: the failed attempt clears the password field
    // asynchronously, which can race the next `.fill()`.
    await page.goto('/login')
    await page.getByLabel('Email', { exact: true }).fill(FOUNDER_EMAIL)
    await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL((url) => url.pathname === '/', { timeout: 15_000 })
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: /account menu/i }).click()
    await page.getByRole('menuitem', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
  })
})

test.describe('role-gated navigation', () => {
  test.use({ storageState: AFNAN_STATE })

  test('a Partner does not see the Settings entry', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')
    const sidebar = page.getByRole('complementary', { name: 'Main navigation' })
    await expect(sidebar.getByRole('link', { name: /^Settings$/ })).toHaveCount(0)
  })

  test('a Partner calling a Founder-only API is refused', async ({ playwright }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Global state; run once')
    const partner = await playwright.request.newContext({ baseURL: BASE_URL, storageState: AFNAN_STATE })
    const response = await partner.get('/api/users')
    expect(response.status()).toBe(403)
    await partner.dispose()
  })
})

test.describe('Founder-granted permission is effective on the next request', () => {
  test('grant makes the Partner able to act; revoke blocks them again', async ({
    playwright,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Global state; run once')

    const founder = await playwright.request.newContext({ baseURL: BASE_URL, storageState: FOUNDER_STATE })
    const partner = await playwright.request.newContext({ baseURL: BASE_URL, storageState: AFNAN_STATE })
    const csrf = csrfFromState(FOUNDER_STATE)

    // Default SPEC §4.2: Afnan cannot view users.
    expect((await partner.get('/api/users')).status()).toBe(403)

    const rolesResponse = await founder.get('/api/roles')
    expect(rolesResponse.ok()).toBeTruthy()
    const roles = (
      (await rolesResponse.json()) as {
        data: { roles: Array<{ _id: string; name: string }> }
      }
    ).data.roles
    const afnanRole = roles.find((role) => role.name === 'partner_afnan')
    expect(afnanRole).toBeTruthy()

    const setUsersView = (view: boolean) =>
      founder.put(`/api/roles/${afnanRole!._id}`, {
        headers: { [CSRF_HEADER]: csrf },
        data: { permissions: { users: { view } } },
      })

    try {
      const grant = await setUsersView(true)
      expect(grant.status()).toBe(200)
      expect((await partner.get('/api/users')).status()).toBe(200)

      const revoke = await setUsersView(false)
      expect(revoke.status()).toBe(200)
      // Effective immediately: the very next request is denied.
      expect((await partner.get('/api/users')).status()).toBe(403)
    } finally {
      await setUsersView(false)
      await founder.dispose()
      await partner.dispose()
    }
  })
})
