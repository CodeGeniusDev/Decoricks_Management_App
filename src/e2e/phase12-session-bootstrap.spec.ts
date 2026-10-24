import { expect, test, type Page, type Route } from '@playwright/test'

/**
 * Session bootstrap resilience (Phase 2.1 / 8.4).
 *
 * `AuthProvider` validates the cookie against `/api/auth/me` on mount, and
 * `RequireAuth` renders nothing until it has an answer. The bug these tests
 * pin: any response that was not an explicit 401/403 — a 500 from a database
 * blip, a dev-server recompile that outlives the request, a dropped connection
 * — left `user === null`, which the guard read as "signed out" and answered
 * with a redirect to `/login`. A valid session was therefore destroyed by a
 * transient failure, and the only way back was to sign in again. That is the
 * mechanism behind "the app sometimes does not load" and "navigation only works
 * after a reload".
 *
 * The fix separates *no session* from *could not tell*. These assertions run
 * against a production build (`scripts/start-prod-test.sh`), so the interception
 * below is the only variable: the route is mocked at the browser boundary, the
 * real cookie and the real server-side checks are untouched.
 */
const failingMe = (status: number) => (route: Route) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { message: 'temporary failure' } }),
  })

test.describe('session bootstrap', () => {
  // Next's route announcer also carries `role="alert"`, so the guard's panel is
  // addressed by its text rather than by the role alone.
  const guardFailure = (page: Page) => page.getByText('Could not verify your session')

  test('an unreachable /api/auth/me offers retry and keeps the user on the page', async ({
    page,
  }) => {
    await page.route('**/api/auth/me', failingMe(500))
    await page.goto('/finance')

    // The guard must say what happened instead of either hanging on a skeleton
    // or bouncing through the door.
    await expect(guardFailure(page)).toBeVisible()

    // ...and must not have signed the user out: still on /finance, never /login.
    expect(page.url()).not.toContain('/login')

    // Recovery in place: the server is reachable again, Retry re-asks, and the
    // page's own content mounts without a reload or a sign-in. 'New transaction'
    // is rendered by the Finance page itself, so it proves `children` mounted
    // rather than merely that the error panel went away.
    await page.unroute('**/api/auth/me')
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(guardFailure(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'New transaction' })).toBeVisible()
  })

  test('a real 401 from /api/auth/me still redirects to the login screen', async ({ page }) => {
    // The opposite half: an authoritative "no session" must keep redirecting.
    // Without this assertion the fix above could silently become "never leave
    // the app", which is how a revoked cookie turns into an authenticated-looking
    // shell that every API call then rejects.
    await page.route('**/api/auth/me', failingMe(401))
    await page.goto('/finance')
    await page.waitForURL('**/login')
    expect(page.url()).toContain('/login')
  })
})
