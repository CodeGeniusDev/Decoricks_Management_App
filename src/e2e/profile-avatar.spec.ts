import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import {
  AFNAN_EMAIL,
  AFNAN_STATE,
  BASE_URL,
  CSRF_HEADER,
  E2E_PASSWORD,
  FOUNDER_STATE,
  clientIpHeaders,
  csrfFromState,
} from './helpers'

/**
 * Profile picture — the upload feature against the real server, real MongoDB and
 * a real browser.
 *
 * The unit suites in `src/lib/__tests__` call the handlers directly against an
 * in-memory database, which is the only place the content sniffing, the write
 * ordering and the ownership query can be examined closely. What only this file
 * can prove is the part that needs a browser and a socket: the file chooser →
 * preview → save round trip, the picture appearing in the header without a
 * reload, an `<img>` actually fetching its bytes through a session-protected
 * route, and persistence across a fresh sign-in on a second device.
 *
 * WHY THE SUBJECT IS AFNAN AND NOT THE FOUNDER
 *
 * Every project in `playwright.config.ts` runs as the Founder, and
 * `layout.spec.ts` navigates `/profile` while treating any `/api/` response of
 * 400 or more as a layout fault. With two workers those files interleave. A
 * picture being replaced or removed mid-sweep would momentarily point the
 * Founder's record at a document that no longer exists — a 404 on an `<img>`, and
 * a failure of an unrelated spec caused by this one. So every write here belongs
 * to a different member, which also makes "other team members' pictures remain
 * unchanged" a property of the setup rather than only an assertion.
 *
 * Serial, and chromium-only: the specs mutate one shared record in
 * `decoricks_test` in a fixed order, and the Mobile/Tablet projects would replay
 * that order concurrently against the same record.
 */
test.describe.configure({ mode: 'serial' })

const REPO = path.join(__dirname, '..', '..')
/** Real images already in the repository — no binary fixtures added for tests. */
const PICTURE_A = path.join(REPO, 'public', 'icons', 'icon-192.png')
const PICTURE_B = path.join(REPO, 'public', 'brand-mark.png')
/** A genuine HTML file, for the "not an image at all" path. */
const NOT_AN_IMAGE = path.join(REPO, 'public', 'offline.html')

const AVATAR_URL = /\/api\/profile\/avatar\/[0-9a-f]{24}$/
/** The bytes are never shared-cache material. */
const PRIVATE_CACHE = 'private, max-age=31536000, immutable'

/** A context with no cookies at all. `storageState` must be passed explicitly. */
const ANON_STATE = { cookies: [], origins: [] }

/**
 * `@playwright/test` does not re-export the `Playwright` interface, so the
 * fixture's type is spelled out the way `phase10-security.spec.ts` spells it.
 */
type Playwright = typeof import('playwright-core')

/** An API client holding one member's saved session, on a source address of its own. */
const openAs = (playwright: Playwright, state: string): Promise<APIRequestContext> =>
  playwright.request.newContext({
    baseURL: BASE_URL,
    storageState: state,
    extraHTTPHeaders: clientIpHeaders(),
  })

const profileAvatarImage = (page: Page) => page.locator('#main-content [data-avatar-image]')
const profileAvatarInitial = (page: Page) => page.locator('#main-content [data-avatar-fallback]')
const headerAvatarImage = (page: Page) => page.locator('header [data-avatar-image]')
const avatarButton = (page: Page) =>
  page.getByRole('button', { name: /Add profile picture|Change profile picture/ })

/** Opens the picker through the avatar button and answers it with `file`. */
const choosePicture = async (page: Page, file: string): Promise<void> => {
  const picking = page.waitForEvent('filechooser')
  await avatarButton(page).click()
  await (await picking).setFiles(file)
}

const previewDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Profile picture', exact: true })
const removeDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Remove profile picture?', exact: true })

/**
 * The feature's own feedback line.
 *
 * `role="status"` alone is ambiguous on this screen — the header's connection
 * pill announces itself the same way — so the message is part of the locator
 * rather than an assertion that whichever live region spoke first would satisfy.
 */
const notice = (page: Page, message: string) =>
  page.locator('[role="status"]').filter({ hasText: message })

/**
 * Waits for a picture to actually decode, which is a different fact from its
 * `src` attribute being right.
 *
 * A second device has an empty HTTP cache, so the bytes are still in flight when
 * the markup lands; and a load that fails swaps the initial back in, detaching
 * the `<img>`. Polling the width covers both — it either grows past zero or the
 * element disappears and the poll runs out.
 */
const waitForDecode = async (locator: ReturnType<typeof profileAvatarImage>) => {
  await expect
    .poll(() => locator.evaluate((el) => (el as HTMLImageElement).naturalWidth).catch(() => 0), {
      timeout: 15_000,
      message: 'the profile picture did not decode',
    })
    .toBeGreaterThan(0)
}

/**
 * A multipart body built by hand rather than through `FormData`.
 *
 * The forged-content-type case needs the part's `Content-Type` to disagree with
 * the bytes on purpose, and the oversized case needs a body of an exact length.
 * Writing the bytes makes both explicit instead of depending on how a particular
 * runtime chooses to serialise a `Blob`.
 */
const multipart = (
  bytes: Buffer,
  options: { filename: string; type: string }
): { body: Buffer; headers: Record<string, string> } => {
  const boundary = `----DecoricksUpload${process.pid}`
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${options.filename}"\r\n` +
      `Content-Type: ${options.type}\r\n\r\n`
  )
  return {
    body: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

type Envelope = {
  success?: boolean
  data?: Record<string, unknown>
  error?: { message?: string; code?: string; details?: unknown }
}

test.describe('Profile picture', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'One shared record; run once')
  })

  /** Afnan's own API client: the direct HTTP cases, and the state assertions. */
  let afnan: APIRequestContext | null = null
  /** Afnan's screen, re-opened per test so no dialog survives between them. */
  let page: Page

  /*
   * Read lazily, not at describe time: test files are collected before the
   * `setup` project has written the storage states, so reading the file here
   * would throw on a checkout that has never run the suite.
   */
  const csrf = (): Record<string, string> => ({ [CSRF_HEADER]: csrfFromState(AFNAN_STATE) })

  const client = (): APIRequestContext => {
    if (!afnan) throw new Error('the beforeAll context was never created')
    return afnan
  }

  const me = async (context: APIRequestContext): Promise<Record<string, unknown>> => {
    const res = await context.get('/api/auth/me')
    expect(res.ok()).toBeTruthy()
    return (await res.json()).data.user as Record<string, unknown>
  }

  /** Where the member's picture is served from right now, or `undefined`. */
  const storedUrl = async (): Promise<string | undefined> =>
    (await me(client())).avatarUrl as string | undefined

  /** Uploads through the API and reports what the server answered. */
  const upload = async (
    file: string,
    options: { type?: string; filename?: string } = {}
  ): Promise<{ status: number; body: Envelope | null }> => {
    const part = multipart(fs.readFileSync(file), {
      filename: options.filename ?? path.basename(file),
      type: options.type ?? 'image/png',
    })
    const res = await client().put('/api/profile/avatar', {
      data: part.body,
      headers: { ...part.headers, ...csrf() },
    })
    return { status: res.status(), body: await res.json().catch(() => null) }
  }

  test.beforeAll(async ({ playwright }, testInfo) => {
    // Only the chromium project runs any of this; see the beforeEach skip.
    if (testInfo.project.name !== 'chromium') return

    /*
     * The webServer reuses `decoricks_test` between runs, so the member is put
     * back to the initial avatar first. Every expectation below about "the button
     * says Add" depends on a known starting point, and the run has to be
     * repeatable after an interruption halfway through.
     */
    afnan = await openAs(playwright, AFNAN_STATE)
    await afnan.delete('/api/profile/avatar', { headers: csrf() }).catch(() => undefined)
  })

  test.afterAll(async () => {
    // Leave the test database as it was found: no pointer, no picture.
    if (!afnan) return
    await afnan.delete('/api/profile/avatar', { headers: csrf() }).catch(() => undefined)
    await afnan.dispose()
    afnan = null
  })

  test.beforeEach(async ({ browser }) => {
    const context = await browser.newContext({ storageState: AFNAN_STATE })
    page = await context.newPage()
    await page.goto('/profile')
    // Until the session has been read the screen is a skeleton, and every
    // expectation below is about the profile that has actually rendered.
    await expect(page.getByRole('heading', { name: 'My profile' })).toBeVisible()
  })

  test.afterEach(async () => {
    await page?.context().close()
  })

  test('starts on the initial avatar, with the edit affordance on it', async () => {
    // Requirement: no picture means the pre-existing rendering, unchanged.
    await expect(profileAvatarInitial(page)).toBeVisible()
    await expect(profileAvatarInitial(page)).toHaveText('E')
    await expect(profileAvatarImage(page)).toHaveCount(0)
    await expect(headerAvatarImage(page)).toHaveCount(0)

    await expect(avatarButton(page)).toBeVisible()
    await expect(avatarButton(page)).toHaveAccessibleName('Add profile picture')
    // The camera badge is decoration inside the button — hidden from assistive
    // tech, which gets the action's name from the button itself — and there is
    // nothing to remove yet. The glyph inside it is hidden for the same reason,
    // so the badge span is the one element to look for.
    await expect(avatarButton(page).locator('span[aria-hidden="true"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Remove picture', exact: true })).toHaveCount(0)
  })

  test('the picker opens from the keyboard, and cancelling stores nothing', async () => {
    // Tab order reaches the avatar button and Enter is a real activation.
    await avatarButton(page).focus()
    const picking = page.waitForEvent('filechooser')
    await page.keyboard.press('Enter')
    await (await picking).setFiles(PICTURE_A)

    const dialog = previewDialog(page)
    await expect(dialog).toBeVisible()
    // A preview of the chosen file, before anything has been uploaded anywhere.
    await expect(dialog.getByRole('img', { name: 'icon-192.png' })).toBeVisible()
    await expect(dialog.getByText('icon-192.png · 6 KB')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    expect(await storedUrl()).toBeUndefined()
    await expect(profileAvatarInitial(page)).toBeVisible()
  })

  test('uploads a picture, shows it everywhere and keeps it in MongoDB', async () => {
    await choosePicture(page, PICTURE_A)
    await expect(previewDialog(page)).toBeVisible()

    await previewDialog(page).getByRole('button', { name: 'Save' }).click()
    await expect(notice(page, 'Profile picture updated')).toBeVisible()
    await expect(previewDialog(page)).toHaveCount(0)

    const expected = fs.readFileSync(PICTURE_A)
    const url = await storedUrl()
    expect(url).toMatch(AVATAR_URL)

    // The profile circle and the header show the same picture at the same time,
    // with no reload in between: one session record, rendered everywhere.
    await expect(profileAvatarImage(page)).toHaveAttribute('src', url!)
    await expect(headerAvatarImage(page)).toHaveAttribute('src', url!)
    await expect(profileAvatarImage(page)).toHaveAttribute('alt', 'E2E Afnan')

    // The reference resolves to the uploaded bytes, served out of the database.
    const fetched = await client().get(url!)
    expect(fetched.status()).toBe(200)
    expect(fetched.headers()['content-type']).toBe('image/png')
    expect(fetched.headers()['cache-control']).toBe(PRIVATE_CACHE)
    /*
     * The route sets only Content-Type and Cache-Control; `nosniff` comes from
     * next.config's catch-all group. Asserting it on the served response — rather
     * than only reading it out of the config — is what proves the two layers meet:
     * bytes uploaded as one thing can never be re-interpreted by the browser as
     * another, because the type the route returns is the one sniffed from them.
     */
    expect(fetched.headers()['x-content-type-options']).toBe('nosniff')
    const bytes = await fetched.body()
    expect(bytes.length).toBe(expected.length)
    expect(bytes.equals(expected)).toBeTruthy()
  })

  test('the picture survives a reload and a fresh sign-in on another device', async ({
    browser,
  }) => {
    test.setTimeout(90_000)
    const before = await storedUrl()
    expect(before).toMatch(AVATAR_URL)

    // A real reload: the server decides what renders, not anything the tab kept.
    await page.reload()
    await expect(profileAvatarImage(page)).toHaveAttribute('src', before!)
    await waitForDecode(profileAvatarImage(page))

    // A second device: a context with no cookies, signing in through the form.
    const other = await browser.newContext({
      storageState: ANON_STATE,
      extraHTTPHeaders: clientIpHeaders(),
    })
    const otherPage = await other.newPage()
    await otherPage.goto('/login')
    await otherPage.getByLabel('Email', { exact: true }).fill(AFNAN_EMAIL)
    await otherPage.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD)
    await otherPage.getByRole('button', { name: 'Sign in' }).click()
    await otherPage.waitForURL((url) => !url.pathname.startsWith('/login'))

    await otherPage.goto('/profile')
    // The screen reads its own identity from the server before it renders any of
    // the profile, so the first honest moment to look for the picture is after
    // that heading appears — anything earlier is the session still loading.
    await expect(otherPage.getByRole('heading', { name: 'My profile' })).toBeVisible()
    await expect(profileAvatarImage(otherPage)).toHaveAttribute('src', before!)
    await expect(headerAvatarImage(otherPage)).toHaveAttribute('src', before!)
    // Decoded, not merely referenced: a broken `src` would fall back to the initial.
    await waitForDecode(profileAvatarImage(otherPage))

    // And the original session still reads the same reference from the server.
    expect(await storedUrl()).toBe(before!)

    await other.close()
  })

  test('replacing a picture moves the reference and reclaims the old one', async () => {
    const previous = await storedUrl()
    expect(previous).toMatch(AVATAR_URL)

    await choosePicture(page, PICTURE_B)
    // The control already offers replacement, and the current picture stays on
    // screen while the new one is only a preview — replacing is never a gap.
    await expect(avatarButton(page)).toHaveAccessibleName('Change profile picture')
    await expect(previewDialog(page)).toBeVisible()
    await expect(profileAvatarImage(page)).toHaveAttribute('src', previous!)

    await previewDialog(page).getByRole('button', { name: 'Save' }).click()
    await expect(notice(page, 'Profile picture updated')).toBeVisible()

    const current = await storedUrl()
    expect(current).toMatch(AVATAR_URL)
    expect(current).not.toBe(previous)
    await expect(profileAvatarImage(page)).toHaveAttribute('src', current!)
    await expect(headerAvatarImage(page)).toHaveAttribute('src', current!)

    const superseded = await client().get(previous!)
    expect(superseded.status(), 'the replaced picture was left behind instead of reclaimed').toBe(
      404
    )

    // And the reference that remains serves the new file, not the old one.
    const fresh = await client().get(current!)
    expect(fresh.status()).toBe(200)
    expect((await fresh.body()).equals(fs.readFileSync(PICTURE_B))).toBeTruthy()
  })

  test('a file whose name lies about it is refused on its contents', async () => {
    const before = await storedUrl()
    expect(before).toMatch(AVATAR_URL)

    /*
     * HTML bytes behind a `.png` name. Chromium reports `image/png` for that file,
     * so the client's fast-path pre-check lets it through and the server's
     * sniffing is what has to stop it — which is exactly the requirement that
     * validation look at the file content and not the extension.
     */
    const disguised = test.info().outputPath('not-really-a-png.png')
    fs.writeFileSync(disguised, fs.readFileSync(NOT_AN_IMAGE))

    await choosePicture(page, disguised)
    await expect(previewDialog(page)).toBeVisible()
    await previewDialog(page).getByRole('button', { name: 'Save' }).click()

    // The reason appears beside the preview that is still open, so the file can
    // be swapped without starting the flow again.
    await expect(previewDialog(page).getByRole('alert')).toContainText(
      'Only JPEG, PNG and WebP images are supported.'
    )
    await previewDialog(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(previewDialog(page)).toHaveCount(0)

    expect(await storedUrl()).toBe(before)
    await expect(profileAvatarImage(page)).toHaveAttribute('src', before!)
  })

  test('an unsupported type and an oversized file are refused before anything is sent', async () => {
    const before = await storedUrl()

    await choosePicture(page, NOT_AN_IMAGE)
    await expect(notice(page, 'Only JPEG, PNG and WebP images are supported.')).toBeVisible()
    await expect(previewDialog(page)).toHaveCount(0)

    // 3 MB of genuine PNG bytes glued on: over the cap on size alone.
    const huge = test.info().outputPath('huge.png')
    fs.writeFileSync(
      huge,
      Buffer.concat([fs.readFileSync(PICTURE_A), Buffer.alloc(3 * 1024 * 1024)])
    )
    await choosePicture(page, huge)
    await expect(notice(page, 'The maximum size is 2 MB')).toBeVisible()
    await expect(previewDialog(page)).toHaveCount(0)

    expect(await storedUrl()).toBe(before)

    // The same cap holds for a client that skips the UI, measured on the bytes.
    const oversized = await upload(huge)
    expect(oversized.status).toBe(413)
    expect(oversized.body?.error?.message).toContain('maximum size is 2 MB')
    expect(await storedUrl()).toBe(before)

    // A body with no file part is a clear instruction, not a crash.
    const withoutFile = await client().put('/api/profile/avatar', {
      data: Buffer.from('this is not a multipart body'),
      headers: { 'content-type': 'text/plain', ...csrf() },
    })
    expect(withoutFile.status()).toBe(400)
    expect((await withoutFile.json()).error?.code).toBe('NO_IMAGE')
    expect(await storedUrl()).toBe(before)
  })

  test("one member cannot reach or aim another member's picture", async ({ playwright }) => {
    const afnanUrl = await storedUrl()
    expect(afnanUrl).toMatch(AVATAR_URL)
    const founder = await openAs(playwright, FOUNDER_STATE)
    const founderId = String((await me(founder))._id ?? '')
    expect(founderId).toMatch(/^[0-9a-f]{24}$/)

    const anonymous = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: ANON_STATE,
      extraHTTPHeaders: clientIpHeaders(),
    })

    // A teammate who knows the id still cannot read the bytes.
    const stolen = await founder.get(afnanUrl!)
    expect(stolen.status()).toBe(404)

    // The answer is identical to an id that exists nowhere — apart from the
    // moment it was written — so the response cannot be used to find out whether
    // another member has a picture at all.
    const stranger = await founder.get('/api/profile/avatar/507f1f77bcf86cd799439099')
    expect(stranger.status()).toBe(404)
    const withoutTimestamp = (body: Record<string, unknown>) => {
      const copy = { ...body }
      delete copy.timestamp
      return copy
    }
    expect(withoutTimestamp(await stolen.json())).toEqual(withoutTimestamp(await stranger.json()))

    // No session, no bytes.
    expect((await anonymous.get(afnanUrl!)).status()).toBe(401)

    /*
     * Naming the Founder in the request — as a query parameter, the place a client
     * might try to aim a write — changes nothing about who is written to. The
     * subject comes from the session, so the upload lands on Afnan, the Founder's
     * own record keeps whatever it had, and no picture of theirs appears.
     */
    const founderBefore = ((await me(founder)).avatarUrl as string | undefined) ?? undefined
    const part = multipart(fs.readFileSync(PICTURE_A), {
      filename: 'icon-192.png',
      type: 'image/png',
    })
    const aimed = await client().put('/api/profile/avatar', {
      data: part.body,
      headers: { ...part.headers, ...csrf() },
      params: { userId: founderId },
    })
    expect(aimed.status()).toBe(200)

    const afnanAfter = await storedUrl()
    expect(afnanAfter).toMatch(AVATAR_URL)
    expect(afnanAfter).not.toBe(afnanUrl)
    const founderAfter = ((await me(founder)).avatarUrl as string | undefined) ?? undefined
    expect(founderAfter).toBe(founderBefore)
    expect(founderAfter).not.toBe(afnanAfter)

    await founder.dispose()
    await anonymous.dispose()
  })

  test('removing the picture returns the avatar to the initial', async () => {
    const current = await storedUrl()
    expect(current).toMatch(AVATAR_URL)

    await page.getByRole('button', { name: 'Remove picture', exact: true }).click()
    const dialog = removeDialog(page)
    await expect(dialog).toBeVisible()

    // The confirmation is a real choice: backing out changes nothing.
    await dialog.getByRole('button', { name: 'Keep it' }).click()
    await expect(dialog).toHaveCount(0)
    expect(await storedUrl()).toBe(current)

    await page.getByRole('button', { name: 'Remove picture', exact: true }).click()
    await expect(removeDialog(page)).toBeVisible()
    await removeDialog(page).getByRole('button', { name: 'Remove picture' }).click()
    await expect(notice(page, 'Profile picture removed')).toBeVisible()
    await expect(removeDialog(page)).toHaveCount(0)

    // Back to the original rendering everywhere, with nothing left to remove.
    await expect(profileAvatarImage(page)).toHaveCount(0)
    await expect(headerAvatarImage(page)).toHaveCount(0)
    await expect(profileAvatarInitial(page)).toBeVisible()
    await expect(avatarButton(page)).toHaveAccessibleName('Add profile picture')
    expect(await storedUrl()).toBeUndefined()
    expect((await client().get(current!)).status()).toBe(404)
  })

  test('the rest of the profile page is untouched', async () => {
    // The identity block, the details grid and both account actions still render.
    await expect(page.getByRole('heading', { name: 'My profile' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'E2E Afnan' })).toBeVisible()
    // The details grid is the one Playwright's role engine cannot name for:
    // a `dt`/`term` takes no accessible name, so the labels are matched on the
    // elements themselves rather than `getByRole('term', { name })`.
    await expect(page.locator('#main-content dl dt')).toHaveText([
      'Email',
      'Role',
      'Partner',
      'Status',
    ])
    await expect(page.locator('#main-content dl dd').first()).toHaveText(AFNAN_EMAIL)
    await expect(page.locator('#main-content dl dd').nth(3)).toHaveText('Active')
    await expect(page.getByRole('heading', { name: 'What this role can do' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Change password' })).toBeVisible()
  })
})
