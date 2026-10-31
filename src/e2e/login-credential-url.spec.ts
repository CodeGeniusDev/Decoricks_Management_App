import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from '@playwright/test'
import { BASE_URL, FOUNDER_STATE, clientIpHeaders } from './helpers'

/**
 * Credentials must never reach a URL.
 *
 * The construction that invited it: a `<form>` with no method is a GET form, and a
 * GET submit puts every NAMED field into the URL, the history entry, every Referer
 * header the page then sends, and the access log of every proxy in front of the app.
 * Of the app's five forms only the login form named its inputs (`email`,
 * `password`), so only it could ever have serialised a value.
 *
 * What actually ships was measured rather than assumed, and it changes the shape of
 * the guarantee — so the measurements are asserted here, against the production
 * bundle, and a regression in any of them turns this file red:
 *
 *   - `/login` is prerendered down to its Suspense FALLBACK: the HTML a browser
 *     parses contains no `<form>` at all. A visitor whose JavaScript has not loaded
 *     therefore has nothing to submit, which is why the sign-in screen cannot leak a
 *     URL today even though it is the one form with named inputs;
 *   - `/change-password` IS fully server-rendered — it is the form in the first HTML
 *     — and its submit arrives `disabled` and its inputs arrive without `name`, so a
 *     native submit there can neither fire nor serialise anything. `method="post"`
 *     and the hydration gate are what keep it that way after an edit;
 *   - a POST to a page route is served by the page (200, body unread and unreflected)
 *     rather than by a handler, so even a native submit that did win would put its
 *     values in a request body, never in a URL;
 *   - and a credential URL that already EXISTS — from an older build, a bookmark, a
 *     pasted link, a tab reopened while the free instance slept — is refused at the
 *     edge and answered with a clean URL, with the value in no response, no history
 *     entry and no outgoing header. That is the part that fixes a leak that has
 *     already happened, and it is the bulk of this file.
 *
 * `SENTINEL` is invented for this file — no real credential, not a dev one, appears
 * anywhere in it, so a failure message can quote it safely.
 */
const SENTINEL = 'Url-Leak-Sentinel-4f9c11'
const LEAKY_LOGIN = `/login?email=nobody@decoricks.test&password=${SENTINEL}`

/** Key names are what a URL is allowed to be checked against; values are not. */
const credentialKeysIn = (url: string): string[] =>
  [...new URL(url).searchParams.keys()].filter((key) =>
    /password|passwd|pwd|token|secret|authorization|cookie|apikey|otp/i.test(
      key.toLowerCase().replace(/[^a-z0-9]/g, '')
    )
  )

const expectClean = (url: string): void => {
  expect(url, 'value in the URL').not.toContain(SENTINEL)
  // A key-name check, not a substring one: `/login?next=%2Fchange-password` is a
  // clean URL that happens to contain the word "password".
  expect(credentialKeysIn(url), 'credential key in the URL').toEqual([])
}

test.describe('a credential URL that already exists', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('is refused at the edge and lands on a clean login URL', async ({ page }) => {
    const outgoing: string[] = []
    page.on('request', (request) => {
      outgoing.push(...Object.entries(request.headers()).map(([name, value]) => `${name}:${value}`))
    })

    await page.goto(LEAKY_LOGIN)

    expectClean(page.url())
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
    await expect(page.locator('form')).toHaveAttribute('method', 'post')
    expect(await page.content(), 'value echoed in the HTML').not.toContain(SENTINEL)
    expect(outgoing.join('\n'), 'secret in an outgoing request header').not.toContain(SENTINEL)
  })

  test('leaves no credential behind in the history entry', async ({ page }) => {
    /*
     * The point of answering with a redirect: a server-side redirect REPLACES the
     * history entry instead of adding one, so the tainted URL is not what the back
     * button and a session-restoring bookmark hold. Without the guard this entry
     * would be `/login?email=…&password=…` for the whole life of the tab.
     */
    await page.goto('/login')
    await page.goto(LEAKY_LOGIN)
    expectClean(page.url())

    await page.goBack()
    expectClean(page.url())
    expect(page.url(), 'back went somewhere other than the login screen').toContain('/login')
  })

  test('a tainted app URL goes to sign-in without carrying the secret', async ({ page }) => {
    await page.goto(`/tasks?password=${SENTINEL}&search=sofa`)
    const target = new URL(page.url())
    expect(target.pathname).toBe('/login')
    // The destination survives; the query string it arrived with does not.
    expect(target.searchParams.get('next')).toBe('/tasks')
    expect(target.searchParams.get('search')).toBeNull()
    expectClean(page.url())
  })

  test('a change-password URL stripped of both secrets still resolves cleanly', async ({
    page,
  }) => {
    /*
     * Anonymous. The credential guard answers first, so the clean
     * `/change-password` is what the session rule then sees, and that sends the
     * visitor to sign-in for the ordinary reason — with a URL naming no secret.
     */
    const response = await page.goto(
      `/change-password?currentPassword=${SENTINEL}&newPassword=${SENTINEL}`
    )
    expectClean(page.url())
    expect(new URL(page.url()).pathname).toBe('/login')
    expect(response?.status(), 'the redirect chain failed').toBeLessThan(400)
  })
})

test.describe('the markup a browser parses before hydration', () => {
  test.use({ javaScriptEnabled: false })

  test('offers the sign-in screen nothing to submit', async ({ page }) => {
    await page.goto('/login')

    // Measured: the prerendered HTML is the shell and the Suspense fallback. With no
    // form and no button in the document, a GET submit is not merely prevented — the
    // browser has nothing to fire, which is why this file can assert an empty URL
    // below rather than a redirected one.
    await expect(page.locator('form')).toHaveCount(0)
    await expect(page.locator('input')).toHaveCount(0)
    await expect(page.locator('[class*="animate-pulse"]')).toBeVisible()

    // The auth layout is the one piece of auth markup that IS server-rendered, so it
    // is where the explanation for a never-finishing screen belongs.
    await expect(page.locator('noscript')).toBeVisible()
    // The text is read off the serialized document, not with a text matcher:
    // Playwright's extractor skips NOSCRIPT subtrees the way it skips SCRIPT and
    // STYLE (`shouldSkipForTextMatching`), so `textContent` and `innerText` are both
    // permanently empty for this element whatever it displays. `toBeVisible()` above
    // is the proof it is rendered — it measures the layout box, not the text.
    expect(await page.content(), 'no-JS notice is missing its wording').toContain(
      'These screens need JavaScript'
    )

    // And whatever a no-JS visitor does to the address from here, the URL they are on
    // names no credential: the guard answers before any page logic.
    await page.goto(LEAKY_LOGIN)
    expectClean(page.url())
    await expect(page.locator('form')).toHaveCount(0)
  })

  test('the server-rendered change-password form arrives inert and unserialisable', async () => {
    // This is the auth form that IS in the first HTML, so this is the markup whose
    // attributes have to be right on their own — no script has run to fix them.
    // Asserted against the raw response text, which is the parsed-HTML source.
    const session = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      storageState: FOUNDER_STATE,
    })
    try {
      const html = await (await session.get('/change-password')).text()
      const form = html.match(/<form[^>]*>/)?.[0] ?? ''
      expect(form, 'the server-rendered form must declare its method').toContain('method="post"')
      expect(form).toContain('action="/change-password"')

      const submit = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? ''
      expect(submit, 'the submit must not be clickable before hydration').toContain('disabled')

      // No field carries a name, so a native submit has nothing to serialise.
      expect(html).not.toMatch(/<input[^>]+name="(currentPassword|newPassword|confirmPassword)"/)
    } finally {
      await session.dispose()
    }
  })
})

test.describe('a submit that reaches the server natively', () => {
  let api: APIRequestContext

  test.use({ storageState: { cookies: [], origins: [] } })

  test.beforeAll(async () => {
    /*
     * `maxRedirects: 0` because the assertions are about the answer to the request
     * itself; following it would let a redirect hide what the server did with the
     * form body.
     */
    api = await playwrightRequest.newContext({ baseURL: BASE_URL, maxRedirects: 0 })
  })

  test.afterAll(async () => {
    await api.dispose()
  })

  test('a POST with the values in the body is not a leak', async () => {
    const response = await api.post('/login', {
      data: `email=nobody@decoricks.test&password=${SENTINEL}`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...clientIpHeaders(),
      },
    })

    /*
     * Measured: 200. A page route has no POST handler, so Next renders the page and
     * the body is never read — and a body is exactly where a value belongs, because
     * it goes nowhere else: no URL, no history entry, no Referer, no access log.
     * What this assertion is really holding is that the answer is not a redirect
     * that replays the request somewhere, and not an error page quoting the payload.
     */
    expect(response.status()).toBe(200)
    const text = await response.text()
    expect(text, 'value echoed back').not.toContain(SENTINEL)
    expect(response.headers()['location'], 'POST answered with a redirect').toBeUndefined()
  })

  test('and a credential in the query string is refused as JSON on the API', async () => {
    const response = await api.post(`/api/auth/login?password=${SENTINEL}`, {
      data: '{}',
      headers: { 'content-type': 'application/json', ...clientIpHeaders() },
    })
    expect(response.status()).toBe(400)
    const body = await response.text()
    expect(JSON.parse(body).error.code).toBe('CREDENTIALS_IN_QUERY')
    expect(body).not.toContain(SENTINEL)
    expect(response.headers()['location'], 'redirect instead of a refusal').toBeUndefined()
  })

  test('a credential on the login page over HTTP is redirected, not served', async () => {
    const response = await api.get(LEAKY_LOGIN)
    expect(response.status()).toBe(302)
    const location = response.headers()['location'] ?? ''
    expect(new URL(location, BASE_URL).pathname).toBe('/login')
    expect(location, 'value forwarded into a redirect target').not.toContain(SENTINEL)
  })

  test('a state-changing request with a credential URL is answered with 303', async () => {
    // 303 instructs the browser to follow with a GET, so a POST that carried a
    // tainted query string cannot be replayed against the clean URL.
    const response = await api.post(`/login?password=${SENTINEL}`, { data: '' })
    expect(response.status()).toBe(303)
    // Measured: Next emits a path-relative Location, so it is parsed against the
    // base rather than compared as a string.
    const location = response.headers()['location'] ?? ''
    expect(new URL(location, BASE_URL).pathname).toBe('/login')
    expect(location, 'a query string on the redirect target').not.toContain('?')
  })
})
