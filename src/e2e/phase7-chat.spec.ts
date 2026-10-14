import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { AFNAN_STATE, CSRF_HEADER, FOUNDER_STATE, csrfFromState } from './helpers'

/**
 * Phase 7 chat — real cross-device verification.
 *
 * Runs against the isolated `decoricks_test` database through the *live* HTTP
 * surface: two genuinely separate browser contexts (different cookie jars = two
 * different devices on two different sessions), real `authorize()` gates and real
 * MongoDB writes. A message committed by the Founder on device A must appear on
 * the Partner's open channel on device B with no reload and no duplicate; an
 * offline period must show the banner, disable sending, keep the draft, and then
 * resume cleanly. This is the behaviour the brief insists cannot be claimed
 * until it is observed in two sessions at once.
 *
 * The transport is SSE with an automatic cursor-poll fallback, so these
 * assertions hold whether or not the host's change stream is available: in a
 * local standalone mongod (no change stream) the poll reconciles, on Atlas the
 * stream does. Both paths are the *same* client store, so the UI reads
 * identically.
 *
 * Scoped to the `chromium` project: each spec opens its own contexts with fixed
 * storage states and writes to the shared test DB, so a single deterministic
 * sequence keeps channel selection and unread counts unambiguous. The mobile
 * layout check builds its own mobile-capable context rather than relying on the
 * Mobile Chrome project, so it too runs exactly once.
 */

const founderCsrf = () => csrfFromState(FOUNDER_STATE)

/**
 * The message composer textarea.
 *
 * Must be matched by an exact accessible name: once a user's own messages are
 * rendered they expose "Edit message" / "Delete message" action buttons, and a
 * substring `getByLabel('Message')` (case-insensitive by default) would then
 * resolve to 5 elements and trip Playwright strict mode intermittently, purely
 * depending on whether those buttons are in the DOM at that instant.
 */
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true })

/** Resolve a channel's id by display name through the real, auth-gated list. */
async function channelIdByName(ctx: BrowserContext, name: string): Promise<string> {
  const res = await ctx.request.get('/api/chat/channels')
  expect(res.ok(), `channels list failed: ${res.status()}`).toBeTruthy()
  const list = (await res.json()).data as Array<{ _id: string; name: string }>
  const found = list.find((c) => c.name === name)
  expect(found, `channel "${name}" should be seeded`).toBeTruthy()
  return found!._id
}

/** Post a message as device A through the real send endpoint (idempotent). */
async function sendMessage(
  ctx: BrowserContext,
  channelName: string,
  content: string
): Promise<void> {
  const id = await channelIdByName(ctx, channelName)
  const res = await ctx.request.post(`/api/chat/channels/${id}/messages`, {
    data: { content, clientId: crypto.randomUUID() },
    headers: { [CSRF_HEADER]: founderCsrf() },
  })
  expect(res.ok(), `send should be 2xx, got ${res.status()}`).toBeTruthy()
}

/** Create a Founder-only channel and return its id (unique name → hermetic). */
async function createChannel(ctx: BrowserContext, name: string): Promise<string> {
  const res = await ctx.request.post('/api/chat/channels', {
    data: { name, description: 'Ephemeral e2e channel' },
    headers: { [CSRF_HEADER]: founderCsrf() },
  })
  expect(res.status(), `channel create should be 201, got ${res.status()}`).toBe(201)
  return (await res.json()).data._id as string
}

/** Post a message directly by channel id (idempotent). */
async function sendToChannelId(
  ctx: BrowserContext,
  channelId: string,
  content: string
): Promise<void> {
  const res = await ctx.request.post(`/api/chat/channels/${channelId}/messages`, {
    data: { content, clientId: crypto.randomUUID() },
    headers: { [CSRF_HEADER]: founderCsrf() },
  })
  expect(res.ok(), `send should be 2xx, got ${res.status()}`).toBeTruthy()
}

/**
 * The channel's button inside the rail. Matched by its visible `#Name` text
 * rather than the exact accessible name, because an unread badge appends a
 * count to the button's accessible name ("#General 3") and would break an
 * `exact` role-name match.
 */
const railButton = (page: Page, name: string) =>
  page.locator('nav[aria-label="Chat channels"] button', { hasText: `#${name}` }).first()

/** Wait for the conversation panel to be live on the given channel. */
async function openChatOn(page: Page, channelName: string): Promise<void> {
  await page.goto('/chat')
  await expect(page.getByRole('status')).toBeVisible({ timeout: 20_000 })
  // The rail selects the first channel automatically; pick the target explicitly.
  await railButton(page, channelName).click()
  await expect(page.getByRole('heading', { name: `#${channelName}`, exact: true })).toBeVisible()
}

const uniqueTag = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`

test('device B receives a message from device A live, exactly once, with a clean console', async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Opens own contexts; run once')

  const deviceA = await browser.newContext({ storageState: FOUNDER_STATE })
  const deviceB = await browser.newContext({ storageState: AFNAN_STATE })

  // Watch device B for the failure the brief calls out explicitly: any console
  // error or React hydration warning while a live session is idle-but-connected.
  const consoleErrors: string[] = []
  const pageB = await deviceB.newPage()
  pageB.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  pageB.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

  await openChatOn(pageB, 'General')

  const text = uniqueTag('hello')
  await sendMessage(deviceA, 'General', text)

  // It appears without any reload…
  const bubble = pageB.getByText(text, { exact: false })
  await expect(bubble).toBeVisible({ timeout: 20_000 })

  // …and there is exactly one copy. Give the SSE signal and the poll fallback a
  // window to both fire — the dedupe by clientId/_id must collapse them to one.
  await pageB.waitForTimeout(3_000)
  await expect(pageB.getByText(text, { exact: true })).toHaveCount(1)

  // No hydration warnings or console errors observed across the live session.
  const hydration = consoleErrors.filter((e) => /hydrat/i.test(e))
  expect(hydration, `hydration warnings: ${hydration.join('\n')}`).toHaveLength(0)
  expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toHaveLength(0)

  await pageB.close()
  await deviceA.close()
  await deviceB.close()
})

test('unread badge counts messages in a channel device B is not viewing', async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Opens own contexts; run once')

  const deviceA = await browser.newContext({ storageState: FOUNDER_STATE })
  const deviceB = await browser.newContext({ storageState: AFNAN_STATE })

  // A brand-new channel has no read watermark for anyone, so its unread count
  // is exactly the messages device A posts now — deterministic regardless of
  // what earlier runs left in the seeded channels.
  const name = `e2e unread ${Date.now()}`
  const channelId = await createChannel(deviceA, name)

  const pageB = await deviceB.newPage()
  // B is reading General; the new channel stays in the background and accrues unread.
  await openChatOn(pageB, 'General')

  await sendToChannelId(deviceA, channelId, uniqueTag('unread-1'))
  await sendToChannelId(deviceA, channelId, uniqueTag('unread-2'))

  // The rail entry grows an unread badge as the channel list reconciles.
  const channelButton = railButton(pageB, name)
  await expect(channelButton.getByText('2', { exact: true })).toBeVisible({ timeout: 20_000 })

  // Opening it marks the channel read and paints the messages.
  await channelButton.click()
  await expect(pageB.getByText('unread-1', { exact: false }).first()).toBeVisible()
  await expect(pageB.getByText('unread-2', { exact: false }).first()).toBeVisible()
  await expect(channelButton.getByText('2', { exact: true })).toHaveCount(0)

  await pageB.close()
  await deviceA.close()
  await deviceB.close()
})

test('going offline shows the banner and disables sending, then resumes and delivers', async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Opens own contexts; run once')

  const deviceA = await browser.newContext({ storageState: FOUNDER_STATE })
  const deviceB = await browser.newContext({ storageState: AFNAN_STATE })

  const pageB = await deviceB.newPage()
  await openChatOn(pageB, 'General')

  const draft = uniqueTag('draft')
  await composer(pageB).fill(draft)

  // Cut device B's network: the banner appears, sending is disabled, and the
  // typed draft must survive the offline period untouched.
  await deviceB.setOffline(true)
  await expect(pageB.getByText('You are offline')).toBeVisible({ timeout: 10_000 })
  await expect(composer(pageB)).toBeDisabled()
  await expect(composer(pageB)).toHaveValue(draft)

  // A writes while B is dark; this message must arrive only on reconnect.
  const whileAway = uniqueTag('while-away')
  await sendMessage(deviceA, 'General', whileAway)

  // Restore the connection: banner clears, the composer re-enables, and B
  // resumes from its last cursor to pick up the message it missed.
  await deviceB.setOffline(false)
  await expect(pageB.getByText('You are offline')).toHaveCount(0, { timeout: 10_000 })
  await expect(composer(pageB)).toBeEnabled()
  await expect(pageB.getByText(whileAway, { exact: false })).toBeVisible({ timeout: 20_000 })

  // The preserved draft is still there and now sends cleanly.
  await expect(composer(pageB)).toHaveValue(draft)
  await pageB.getByRole('button', { name: 'Send' }).click()
  await expect(pageB.getByText(draft, { exact: false })).toBeVisible({ timeout: 15_000 })

  await pageB.close()
  await deviceA.close()
  await deviceB.close()
})

test('on a phone-width viewport the chat is full-screen with the composer pinned at the bottom', async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Opens own contexts; run once')

  // A self-contained mobile context so this check runs exactly once, regardless
  // of the Mobile Chrome project (which reuses the Founder state globally).
  const mobile = await browser.newContext({
    storageState: FOUNDER_STATE,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  })
  const page = await mobile.newPage()
  await page.goto('/chat')
  await expect(page.getByRole('status')).toBeVisible({ timeout: 20_000 })

  // The rail collapses behind a menu button on <md; the conversation fills the
  // width. Opening the drawer selects a channel (scoped to the dialog so the
  // hidden desktop rail is never matched).
  await page.getByLabel('Open channels').click()
  const drawerButton = page
    .locator('div[role="dialog"] nav[aria-label="Chat channels"] button', { hasText: '#General' })
    .first()
  await drawerButton.click()
  await expect(page.getByRole('heading', { name: '#General', exact: true })).toBeVisible()

  // The composer sits at the bottom of the viewport, not scrolled off-screen.
  const composerInput = composer(page)
  const box = await composerInput.boundingBox()
  expect(box, 'composer should be laid out').not.toBeNull()
  const viewport = page.viewportSize()!
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1)
  expect(box!.y).toBeGreaterThan(viewport.height * 0.5)

  // No horizontal page scroll at 390px.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)

  // A message sent from the phone shows up in its own transcript.
  const text = uniqueTag('from-phone')
  await composerInput.fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(text, { exact: false })).toBeVisible({ timeout: 15_000 })

  await page.close()
  await mobile.close()
})
