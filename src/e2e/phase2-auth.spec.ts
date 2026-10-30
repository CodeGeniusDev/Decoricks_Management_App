import { test, expect } from '@playwright/test'
import {
  AFNAN_STATE,
  BASE_URL,
  CSRF_HEADER,
  E2E_PASSWORD,
  FOUNDER_EMAIL,
  FOUNDER_STATE,
  clientIpHeaders,
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
    /*
     * Own source address for this page's logins. The login endpoint allows 10
     * attempts a minute per IP; every browser in the suite otherwise arrives as
     * 127.0.0.1 and spends the same budget as the other worker's tests and as
     * `phase10-security.spec.ts`, which is how this test started receiving
     * "Too many login attempts" in place of the credential error it asserts.
     */
    await page.setExtraHTTPHeaders(clientIpHeaders())
    await page.goto('/login')

    /*
     * A unique unknown address, for the same reason `phase10-security.spec.ts`
     * creates a uniquely-emailed probe: the lockout is keyed by EMAIL in the
     * database, not by device. This test records one failed attempt per project
     * per run, so a fixed address reaches the 5-attempt threshold after two full
     * runs (or one full run plus a re-run of this file alone) and the next
     * answer is a 429 lockout instead of the credential error asserted below —
     * measured, not theoretical: it is exactly how this test went red on Mobile
     * Chrome and Tablet while the identical chromium test passed.
     */
    await page
      .getByLabel('Email', { exact: true })
      .fill(`nobody-${Date.now().toString(36)}@decoricks.test`)
    await page.getByLabel('Password', { exact: true }).fill('WrongPassword123')
    await page.getByRole('button', { name: 'Sign in' }).click()
    /*
     * Scoped to the message, not `getByRole('alert')`. Next mounts its own
     * `<p id="__next-route-announcer__" role="alert" aria-live="assertive">`
     * outside `<main>` on every page (`next/dist/client/route-announcer.js:70-76`),
     * so an unscoped locator is a strict-mode violation on any form that has just
     * failed — and naming the text also proves the refusal was about the
     * credential rather than about how many logins this run has already made.
     */
    await expect(
      page.locator('[role="alert"]').filter({ hasText: 'Invalid email or password' })
    ).toBeVisible()
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

  /*
   * Item 4 — the login screen follows `?next=` after accepting a password, and
   * the query string is whatever a link in an email said. The unit test
   * (`src/lib/__tests__/safe-redirect.test.ts`) pins the parser rule; this proves
   * the shipped bundle actually refuses to leave the origin, because the only
   * place the rule matters is the moment a real session exists.
   *
   * `.test` is reserved (RFC 6761), so a regression cannot turn into a request to
   * somebody's real domain — it fails to resolve and the assertion below fails on
   * the URL instead.
   */
  for (const [label, hostile] of [
    ['protocol-relative', '//evil.test'],
    ['backslash-normalised', '/\\evil.test'],
    ['absolute', 'https://evil.test/tasks'],
  ] as const) {
    test(`a hostile ?next (${label}) cannot carry a signed-in user off this origin`, async ({
      page,
    }) => {
      await page.setExtraHTTPHeaders(clientIpHeaders())
      await page.goto(`${BASE_URL}/login?next=${hostile}`)
      await page.getByLabel('Email', { exact: true }).fill(FOUNDER_EMAIL)
      await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD)
      await page.getByRole('button', { name: 'Sign in' }).click()

      // Signed in, and still on this app: `/login?next=…` must not have been
      // followed to `evil.test`, and the fallback destination is the dashboard.
      await expect(page.locator('#main-content')).toBeVisible({ timeout: 15_000 })
      const url = new URL(page.url())
      expect(url.origin, `sign-in with next=${hostile} left the origin`).toBe(BASE_URL)
      expect(url.pathname).toBe('/')
    })
  }

  test('a friendly ?next still returns the user to where they were headed', async ({ page }) => {
    // The guard is not a blanket "always go home": refusing a legitimate
    // destination would be the regression that actually breaks daily use.
    await page.setExtraHTTPHeaders(clientIpHeaders())
    await page.goto(`${BASE_URL}/login?next=/tasks`)
    await page.getByLabel('Email', { exact: true }).fill(FOUNDER_EMAIL)
    await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL((url) => url.pathname === '/tasks', { timeout: 15_000 })
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
    const partner = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: AFNAN_STATE,
    })
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

    const founder = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: FOUNDER_STATE,
    })
    const partner = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: AFNAN_STATE,
    })
    const csrf = csrfFromState(FOUNDER_STATE)

    // Default SPEC §4.2: Afnan cannot view users.
    expect((await partner.get('/api/users')).status()).toBe(403)

    const rolesResponse = await founder.get('/api/roles')
    expect(rolesResponse.ok()).toBeTruthy()
    const roles = (
      (await rolesResponse.json()) as {
        data: {
          roles: Array<{
            _id: string
            name: string
            permissions?: Record<string, Record<string, boolean>>
          }>
        }
      }
    ).data.roles
    const afnanRole = roles.find((role) => role.name === 'partner_afnan')
    expect(afnanRole).toBeTruthy()

    // Snapshot Afnan's real board permissions so the mutation below can be
    // undone exactly, leaving the shared test role no driftier than it started.
    const originalTasks = afnanRole!.permissions?.tasks ?? {}

    // The Phase 1 regression: the settings screen PUTs the FULL stored matrix,
    // and `tasks` legitimately carries the board-only actions (editOthers,
    // deleteOthers, comment, manage). The write schema used to validate only the
    // five generic actions, so a payload like this returned 400 and nothing
    // persisted — the "granted but not received" bug. A `users.view`-only save
    // (below) never touched that path, which is why the original test passed
    // against the broken code. Saving board actions must now return 200.
    const withBoardActions = {
      users: { view: true },
      tasks: { ...originalTasks, manage: true, editOthers: true },
    }
    const restore = () =>
      founder.put(`/api/roles/${afnanRole!._id}`, {
        headers: { [CSRF_HEADER]: csrf },
        data: { permissions: { users: { view: false }, tasks: originalTasks } },
      })

    const grant = await founder.put(`/api/roles/${afnanRole!._id}`, {
      headers: { [CSRF_HEADER]: csrf },
      data: { permissions: withBoardActions },
    })

    try {
      expect(grant.status()).toBe(200)

      // The board grant is not just acknowledged — it is stored. Read it back.
      const reread = await founder.get('/api/roles')
      const storedTasks =
        (
          (await reread.json()) as {
            data: {
              roles: Array<{
                name: string
                permissions?: Record<string, Record<string, boolean>>
              }>
            }
          }
        ).data.roles.find((role) => role.name === 'partner_afnan')?.permissions?.tasks ?? {}
      expect(storedTasks.manage).toBe(true)
      expect(storedTasks.editOthers).toBe(true)

      // users.view grant is effective on the very next request.
      expect((await partner.get('/api/users')).status()).toBe(200)

      const revoke = await restore()
      expect(revoke.status()).toBe(200)
      // Effective immediately: the very next request is denied.
      expect((await partner.get('/api/users')).status()).toBe(403)
    } finally {
      await restore()
      await founder.dispose()
      await partner.dispose()
    }
  })
})
