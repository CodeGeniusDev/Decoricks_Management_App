import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { AFNAN_STATE, CSRF_HEADER, FOUNDER_STATE, csrfFromState } from './helpers'

/**
 * Phase 3 — chat collaboration, verified in two live sessions.
 *
 * The unit suite proves the server rules (structured mentions, per-viewer
 * reference chips, non-destructive archiving, deduped notifications). What only
 * a browser can prove is the part the brief keeps insisting on: that a person
 * typing `@` gets a real teammate out of MongoDB, that a chip actually opens the
 * record it points at, that an archived room is findable and restorable, and
 * that all of it survives a refresh and reaches a second device without one.
 *
 * Two browser contexts are two devices: separate cookie jars, separate live SSE
 * streams, one shared `decoricks_test` database. Everything here goes through
 * the real HTTP surface with real `authorize()` gates.
 *
 * Scoped to the `chromium` project because each test opens its own contexts and
 * writes to the shared test DB; one deterministic sequence per test keeps channel
 * auto-selection and unread counts unambiguous.
 */

const founderCsrf = () => csrfFromState(FOUNDER_STATE)

/* Each test holds two live sessions and waits for one to observe the other over
 * a free-tier change stream (or its poll fallback). The 30s default is a budget
 * for a single page, not for a conversation between two devices. */
test.describe.configure({ timeout: 120_000 })

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true })

const railButton = (page: Page, name: string) =>
  page.locator('nav[aria-label="Chat channels"] button', { hasText: `#${name}` }).first()

const unique = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`

/** Open chat and land on a specific channel through the real rail. */
async function openChatOn(page: Page, channelName: string): Promise<void> {
  await page.goto('/chat')
  // `main` is not decoration. The header's connectivity pill is a live region
  // too, so a bare `getByRole('status')` is two elements and a strict-mode
  // failure — and the state worth waiting for is the chat's own, which only
  // appears once the room has a stream.
  await expect(page.locator('main [role="status"]')).toBeVisible({ timeout: 20_000 })
  await railButton(page, channelName).click()
  await expect(page.getByRole('heading', { name: `#${channelName}`, exact: true })).toBeVisible()
}

/** Founder-only channel created through the real endpoint; returns its id. */
async function createChannel(ctx: BrowserContext, name: string): Promise<string> {
  const res = await ctx.request.post('/api/chat/channels', {
    data: { name, description: 'Phase 3 collaboration e2e' },
    headers: { [CSRF_HEADER]: founderCsrf() },
  })
  expect(res.status(), `channel create should be 201, got ${res.status()}`).toBe(201)
  return (await res.json()).data._id as string
}

async function postMessage(
  ctx: BrowserContext,
  channelId: string,
  content: string,
  clientId = crypto.randomUUID()
): Promise<{ status: number; body: SendEnvelope }> {
  const res = await ctx.request.post(`/api/chat/channels/${channelId}/messages`, {
    data: { content, clientId },
    headers: { [CSRF_HEADER]: founderCsrf() },
  })
  return { status: res.status(), body: (await res.json()) as SendEnvelope }
}

/** The send endpoint's envelope, narrowed to what these specs read. */
interface SendEnvelope {
  success: boolean
  data?: { _id: string; content: string; mentions?: Array<{ userId: string; name: string }> }
  error?: { message?: string }
}

/** A row as the history endpoint serialises it. */
interface StoredRow {
  _id: string
  content: string | null
  mentions?: Array<{ userId: string; name: string }>
  /** Read-time chips: the pointer plus the label re-resolved for this viewer. */
  references?: Array<{
    state?: string
    entityType: string
    entityId: string
    label?: string
    href?: string
  }>
}

/**
 * Read a message back out of MongoDB once the send has committed.
 *
 * The POST is a real round trip to a real database and this suite runs against a
 * free-tier instance, so the history is polled until the row appears rather than
 * read once and assumed. The assertion is unchanged — it only refuses to pass on
 * a partial document or fail on a slow network.
 */
async function storedMessage(
  ctx: BrowserContext,
  channelId: string,
  needle: string
): Promise<StoredRow> {
  let row: StoredRow | undefined
  await expect
    .poll(
      async () => {
        const res = await ctx.request.get(`/api/chat/channels/${channelId}/messages?limit=50`)
        const body = (await res.json()) as { data?: StoredRow[] }
        row = body.data?.find((m) => (m.content ?? '').includes(needle))
        return row ? 'stored' : 'pending'
      },
      { timeout: 30_000, message: `a message containing "${needle}" never reached MongoDB` }
    )
    .toBe('stored')
  return row!
}

/** Type a trigger and wait for the autocomplete to be its own listbox. */
async function openMentionMenu(page: Page): Promise<Locator> {
  const input = composer(page)
  await input.click()
  await input.type('@', { delay: 40 })
  const listbox = page.getByRole('listbox', { name: 'Team members' })
  await expect(listbox).toBeVisible({ timeout: 10_000 })
  return listbox
}

/**
 * Keyboard-select a member from the open menu.
 *
 * The index is read from the live list rather than assumed, so the assertion is
 * about the composer's behaviour (ArrowDown walks the list, Enter completes the
 * active row) and not about the order `/api/chat/members` happens to return.
 */
async function pickMemberByKeyboard(page: Page, listbox: Locator, name: string) {
  const options = listbox.getByRole('option')
  const labels = await options.allTextContents()
  const index = labels.findIndex((text) => text.includes(name))
  expect(
    index,
    `"${name}" should be offered. Options: ${labels.join(' | ')}`
  ).toBeGreaterThanOrEqual(0)
  const input = composer(page)
  for (let i = 0; i < index; i += 1) await input.press('ArrowDown')
  await input.press('Enter')
  return labels
}

async function createBoardWithTask(ctx: BrowserContext, title: string): Promise<void> {
  const boardRes = await ctx.request.post('/api/boards', {
    data: { name: `Collab Board ${title}` },
    headers: { [CSRF_HEADER]: founderCsrf() },
  })
  expect(boardRes.status(), 'board create should be 201').toBe(201)
  const board = (await boardRes.json()).data
  const columns = (await (await ctx.request.get(`/api/boards/${board._id}`)).json()).data
    .columns as Array<{ _id: string }>
  const res = await ctx.request.post('/api/tasks', {
    data: { boardId: board._id, columnId: columns[0]._id, title },
    headers: { [CSRF_HEADER]: founderCsrf() },
  })
  expect(res.status(), 'task create should be 201').toBe(201)
}

test('a mention picked from the autocomplete persists, alerts the teammate, and deep-links the room', async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Opens own contexts; run once')

  const deviceA = await browser.newContext({ storageState: FOUNDER_STATE })
  const deviceB = await browser.newContext({ storageState: AFNAN_STATE })
  const name = unique('mention-room')
  const channelId = await createChannel(deviceA, name)

  const pageA = await deviceA.newPage()
  const pageB = await deviceB.newPage()
  // §7.11: a document navigation is the thing the brief forbids. Counting main-
  // frame navigations makes "no unnecessary refresh" an assertion, not a hope.
  let navigations = 0
  pageA.on('framenavigated', (frame) => {
    if (frame === pageA.mainFrame()) navigations += 1
  })
  await openChatOn(pageA, name)
  await openChatOn(pageB, 'General')

  const listbox = await openMentionMenu(pageA)
  // The directory is real: the seeded Afnan account is offered by its database
  // name, and the list carries no email addresses or role labels.
  const offered = await pickMemberByKeyboard(pageA, listbox, 'E2E Afnan')
  expect(offered.join(' ')).not.toContain('@decoricks')

  await expect(composer(pageA)).toHaveValue('@E2E Afnan ')
  // Selecting twice must not write a second copy of the same teammate: the
  // fragment collapses and the composer says so instead of silently eating it.
  await composer(pageA).type('@', { delay: 40 })
  const again = pageA.getByRole('listbox', { name: 'Team members' })
  await expect(again).toBeVisible()
  await pickMemberByKeyboard(pageA, again, 'E2E Afnan')
  await expect(composer(pageA)).toHaveValue('@E2E Afnan ')
  await expect(pageA.getByText('E2E Afnan is already mentioned')).toBeVisible()

  await composer(pageA).type('please check the delivery')
  const navigationsBeforeSend = navigations
  await pageA.getByRole('button', { name: 'Send' }).click()

  // Rendered as a mention, and it survives a hard reload (it came from Mongo).
  await expect(pageA.getByText('please check the delivery')).toBeVisible({ timeout: 15_000 })
  await expect(
    pageA.locator('span[title="Mentioned E2E Afnan"]', { hasText: '@E2E Afnan' })
  ).toBeVisible()
  // The message arrived the same way it always did: one fetch, no reload, and no
  // second navigation on the way.
  expect(navigations).toBe(navigationsBeforeSend)

  await pageA.reload()
  await openChatOn(pageA, name)
  await expect(pageA.getByText('please check the delivery')).toBeVisible({ timeout: 20_000 })
  await expect(
    pageA.locator('span[title="Mentioned E2E Afnan"]', { hasText: '@E2E Afnan' })
  ).toBeVisible()

  // The stored row carries a user id, not just the display text.
  const sent = await storedMessage(deviceA, channelId, 'please check the delivery')
  expect(sent.mentions).toEqual([{ userId: expect.any(String), name: 'E2E Afnan' }])

  // Afnan is alerted, with a link to this conversation and no message body.
  // The room link is what makes the wait mean THIS alert: `decoricks_test` is
  // not wiped between runs, so a bare "any mention is unread" poll can already
  // be true before this message is delivered, return instantly, and read
  // `alerts[0]` as a leftover row from an earlier suite.
  //
  // If this poll times out at zero, read "Known failure on a re-seeded test DB"
  // in docs/E2E_RUNBOOK.md before touching the filter. Mentions are resolved by
  // DISPLAY NAME, so a test DB with two active "E2E Afnan" accounts sends the
  // alert to the one nobody logs in as — the fix there is the data, not this
  // assertion, whose entire claim is that the named teammate is the one alerted.
  const link = `/chat?channel=${channelId}`
  const fetchMentionAlerts = async () => {
    const list = (await (await deviceB.request.get('/api/notifications?unread=only')).json()) as {
      data?: { notifications?: Array<{ type: string; data?: { link?: string } }> }
    }
    return (list.data?.notifications ?? []).filter(
      (n) => n.type === 'mention' && n.data?.link === link
    )
  }

  await expect
    .poll(async () => (await fetchMentionAlerts()).length, {
      timeout: 20_000,
      message: `no mention notification for Afnan linking to ${link}`,
    })
    .toBeGreaterThan(0)

  const alerts = await fetchMentionAlerts()
  expect(alerts[0]?.data?.link).toBe(link)
  // The alert names the room, never what was said in it.
  const alertBodies = await (await deviceB.request.get('/api/notifications?unread=only')).json()
  expect(JSON.stringify(alertBodies)).not.toContain('please check the delivery')

  // Following that link lands on the right room, not on the default channel.
  await pageB.goto(`/chat?channel=${channelId}`)
  await expect(pageB.getByRole('heading', { name: `#${name}`, exact: true })).toBeVisible({
    timeout: 20_000,
  })

  await pageA.close()
  await pageB.close()
  await deviceA.close()
  await deviceB.close()
})

test('a record reference searches real records, renders a live chip and opens the actual record', async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Opens own contexts; run once')

  const deviceA = await browser.newContext({ storageState: FOUNDER_STATE })
  const room = unique('reference-room')
  const channelId = await createChannel(deviceA, room)
  const taskTitle = unique('Collab Task')
  await createBoardWithTask(deviceA, taskTitle)

  const page = await deviceA.newPage()
  await openChatOn(page, room)

  const input = composer(page)
  await input.click()
  // The search is one regex over the real title fields — no type keyword, no
  // truncation — so this is the same query a person would type.
  await input.type(`/${taskTitle}`, { delay: 15 })

  const listbox = page.getByRole('listbox', { name: 'Records' })
  await expect(listbox).toBeVisible({ timeout: 15_000 })
  await expect(listbox.getByRole('option', { name: new RegExp(taskTitle) })).toBeVisible({
    timeout: 15_000,
  })
  // Walking down and back up leaves the top-ranked (exact-prefix) record active,
  // which is the one Enter then completes.
  await input.press('ArrowDown')
  await input.press('ArrowUp')
  await input.press('Enter')

  // The fragment is consumed — the record lives in the tray, not in the prose.
  await expect(input).toHaveValue('')
  const tray = page.getByRole('list', { name: 'Records attached to this message' })
  await expect(tray.getByText(taskTitle).first()).toBeVisible()

  await input.type(' blocking on this one')
  await page.getByRole('button', { name: 'Send' }).click()
  // Wait for the provisional row to be replaced by the one the server wrote, so
  // every assertion below is about stored data, not the optimistic placeholder.
  await expect(page.getByText('sending…')).toHaveCount(0, { timeout: 20_000 })

  // The chip is a link to the record, and it is rendered from the live document.
  const chips = page.getByRole('list', { name: 'Referenced records' })
  const chip = chips.getByRole('link', { name: new RegExp(taskTitle) }).first()
  await expect(chip).toBeVisible({ timeout: 15_000 })

  // The message stores a pointer and only a pointer — the body carries none of
  // the record's name, so there is nothing here that can go stale.
  const sent = await storedMessage(deviceA, channelId, 'blocking on this')
  const refs = sent.references ?? []
  expect(refs).toHaveLength(1)
  expect(refs[0]?.entityType).toBe('task')
  expect(refs[0]?.entityId).toBeTruthy()
  expect(sent.content).toBe('blocking on this one')

  // Rename the real record. The chip follows it because the label is resolved out
  // of the document every time the message is read. Copied text cannot do this,
  // and that difference is the entire point of a reference over a quote.
  const renamed = unique('Renamed Task')
  // Task writes are version-guarded, so the rename reads the live document's
  // version instead of assuming the one the create response returned.
  const liveRes = await deviceA.request.get(`/api/tasks/${refs[0]?.entityId}`)
  expect(liveRes.status(), 'the referenced task should resolve to a real record').toBe(200)
  const live = (await liveRes.json()) as { data?: { task?: { version?: number; title?: string } } }
  expect(typeof live.data?.task?.version, 'the live task should carry its version').toBe('number')

  const patch = await deviceA.request.patch(`/api/tasks/${refs[0]?.entityId}`, {
    data: { title: renamed, version: live.data?.task?.version },
    headers: { [CSRF_HEADER]: founderCsrf() },
  })
  expect(patch.status(), 'the referenced task should be renamable').toBe(200)

  const afterRename = await storedMessage(deviceA, channelId, 'blocking on this')
  expect(afterRename.references?.[0]?.label).toBe(renamed)
  expect(JSON.stringify(afterRename)).not.toContain(taskTitle)

  // The same on screen: after a reload the chip carries the new name, and nothing
  // of the old one is left in the message.
  await page.reload()
  await openChatOn(page, room)
  const chipList = page.getByRole('list', { name: 'Referenced records' })
  const liveChip = chipList.getByRole('link', { name: new RegExp(renamed) }).first()
  await expect(liveChip).toBeVisible({ timeout: 15_000 })
  await expect(chipList.getByText(taskTitle)).toHaveCount(0)

  // Clicking it opens the list filtered to the live record — the `?q=` the chip
  // carries is the task's CURRENT title, consumed by the screen's own search box
  // and then cleaned from the URL.
  await liveChip.click()
  await expect(page).toHaveURL(/\/tasks/, { timeout: 20_000 })
  await expect(page.getByLabel('Search tasks')).toHaveValue(renamed, { timeout: 20_000 })
  await expect(page.getByText(renamed).first()).toBeVisible({ timeout: 20_000 })

  await page.close()
  await deviceA.close()
})

test('archiving hides a channel without deleting it, and Archived Chats restores it everywhere', async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Opens own contexts; run once')

  const deviceA = await browser.newContext({ storageState: FOUNDER_STATE })
  const deviceB = await browser.newContext({ storageState: AFNAN_STATE })

  const name = unique('archive-room')
  const channelId = await createChannel(deviceA, name)
  const history = unique('kept-message')
  await postMessage(deviceA, channelId, history)

  const pageA = await deviceA.newPage()
  const pageB = await deviceB.newPage()
  // Device B is watching this very room when A closes it.
  await openChatOn(pageA, 'General')
  await openChatOn(pageB, name)

  await railButton(pageA, name).click()
  await pageA.locator('nav[aria-label="Chat channels"] button', { hasText: `#${name}` }).hover()
  await pageA.getByRole('button', { name: `Archive ${name}` }).click()

  // It leaves the list, with feedback that says where it went.
  await expect(railButton(pageA, name)).toHaveCount(0, { timeout: 15_000 })
  await expect(
    pageA.getByText('Channel archived — find it again under Archived Chats.')
  ).toBeVisible()

  // …and on the OTHER device, which was reading it, the conversation does not
  // turn into a dead end: it goes read-only in place, with the history still on
  // screen and the reason stated. `chatChannels` is a synced collection.
  await expect(railButton(pageB, name)).toHaveCount(0, { timeout: 25_000 })
  await expect(pageB.getByText('This channel was archived while you were reading it')).toBeVisible({
    timeout: 15_000,
  })
  await expect(pageB.getByText(history, { exact: false })).toBeVisible()
  await expect(pageB.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0)
  // A Partner is told who can reopen it, rather than handed a button that would 403.
  await expect(pageB.getByRole('button', { name: 'Restore channel' })).toHaveCount(0)

  // Archived Chats is a permanent entry, not a hover trick.
  await pageA.getByRole('button', { name: 'Open archived chats' }).click()
  const dialog = pageA.getByRole('dialog', { name: 'Archived Chats' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(`#${name}`)).toBeVisible()
  await expect(dialog.getByText('1 message', { exact: false })).toBeVisible()

  // Search filters the archive; a non-matching query has its own empty state.
  await dialog.getByLabel('Search archived channels').fill('nothing-matches')
  await expect(dialog.getByText('No matches')).toBeVisible()
  await dialog.getByRole('button', { name: 'Clear search' }).click()
  await expect(dialog.getByText(`#${name}`)).toBeVisible()

  // Opening it reads the preserved history, read-only.
  await dialog.getByRole('button', { name: 'View' }).click()
  await expect(pageA.getByRole('heading', { name: `#${name} Archived` })).toBeVisible()
  await expect(pageA.locator('header').getByText('Archived', { exact: true })).toBeVisible()
  await expect(pageA.getByText(history, { exact: false })).toBeVisible()
  await expect(pageA.getByText('Archived channel — restore it to post here.')).toBeVisible()
  await expect(composer(pageA)).toHaveCount(0)

  await pageA.getByRole('button', { name: 'Restore channel' }).click()
  await expect(pageA.getByRole('heading', { name: new RegExp(`#${name}`) })).toBeVisible({
    timeout: 15_000,
  })
  await expect(pageA.getByText(`Restored #${name} to the channel list`)).toBeVisible()
  await expect(composer(pageA)).toBeVisible()
  await expect(railButton(pageA, name)).toHaveCount(1)

  // It came back exactly once, still holding its original message, and the other
  // device stops being read-only the moment the room is open again.
  await expect(railButton(pageB, name)).toBeVisible({ timeout: 25_000 })
  await expect(railButton(pageB, name)).toHaveCount(1)
  await expect(pageB.getByText('This channel was archived while you were reading it')).toHaveCount(
    0
  )
  await expect(composer(pageB)).toBeVisible()

  // Persisted in MongoDB, not in component state: a fresh session sees the
  // restored room and the archive list is empty again.
  await pageA.reload()
  await expect(railButton(pageA, name)).toBeVisible({ timeout: 20_000 })
  await pageA.getByRole('button', { name: 'Open archived chats' }).click()
  const reopened = pageA.getByRole('dialog', { name: 'Archived Chats' })
  await expect(reopened.getByText(`#${name}`)).toHaveCount(0)

  await pageA.close()
  await pageB.close()
  await deviceA.close()
  await deviceB.close()
})

test('a mention of someone who is not an active chat member stores text but alerts nobody', async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Opens own contexts; run once')

  const deviceA = await browser.newContext({ storageState: FOUNDER_STATE })
  const name = unique('stranger-room')
  const channelId = await createChannel(deviceA, name)

  const res = await postMessage(
    deviceA,
    channelId,
    '@Someone Gone @E2E Hasnat nothing for you here'
  )
  expect(res.status).toBe(201)
  expect(res.body.data?.mentions ?? []).toEqual([])

  // The composer never offers a name that is not in the active directory.
  const page = await deviceA.newPage()
  await openChatOn(page, name)
  const listbox = await openMentionMenu(page)
  const offered = (await listbox.getByRole('option').allTextContents()).join(' ')
  expect(offered).not.toContain('Someone Gone')

  await page.close()
  await deviceA.close()
})
