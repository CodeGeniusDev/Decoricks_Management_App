import { test, expect, type BrowserContext } from '@playwright/test'
import { AFNAN_STATE, CSRF_HEADER, FOUNDER_STATE, csrfFromState } from './helpers'

/**
 * Realtime cross-device verification (Part 3).
 *
 * These specs run against the isolated `decoricks_test` database through the
 * *real* HTTP surface — real auth sessions, real `authorize()` gates, real
 * MongoDB writes — and prove the exact mechanism behind "Abdullah edits a task
 * on his laptop and a teammate's device updates without a refresh":
 *
 *   1. A write committed by one session advances the sync cursor that a
 *      *different* session (different browser context = different cookie jar =
 *      a different device) reads from the poll endpoint. That advance is what
 *      fires the subscriber's silent refresh.
 *   2. The poll endpoint is auth-gated and returns only modules the caller may
 *      view; a malformed module name is dropped, never leaked or 500.
 *   3. A second, genuinely independent session repaints the Tasks board with a
 *      remotely-created card with NO page reload — the end-to-end behaviour the
 *      requirement asks for, observed in a live browser.
 *
 * The transport is a server-backed cursor poll, so this is real cross-device
 * sync, not a tab-local `BroadcastChannel` trick: it survives a refresh and
 * works between separate browsers.
 *
 * Deliberately scoped to the `chromium` project (invoke with
 * `--project=chromium`) so a single deterministic sequence writes to the test
 * DB and board auto-selection stays unambiguous.
 */

const founderCsrf = () => csrfFromState(FOUNDER_STATE)

/** Read the tasks-module cursor as an arbitrary third-party session (device B). */
async function readTasksCursor(ctx: BrowserContext): Promise<number> {
  const res = await ctx.request.get('/api/sync/cursor?modules=tasks')
  expect(res.ok(), `cursor poll failed: ${res.status()}`).toBeTruthy()
  const body = await res.json()
  return body.data.tasks as number
}

/** Create a board (Founder-only) and return its id plus the first column id. */
async function createBoardWithColumn(
  ctx: BrowserContext,
  name: string
): Promise<{ boardId: string; columnId: string }> {
  const boardRes = await ctx.request.post('/api/boards', {
    data: { name },
    headers: { [CSRF_HEADER]: founderCsrf() },
  })
  expect(boardRes.status(), 'board create should be 201').toBe(201)
  const board = (await boardRes.json()).data
  const detail = await ctx.request.get(`/api/boards/${board._id}`)
  const columns = (await detail.json()).data.columns as Array<{ _id: string }>
  expect(columns.length).toBeGreaterThan(0)
  return { boardId: board._id as string, columnId: columns[0]._id }
}

async function createTask(
  ctx: BrowserContext,
  input: { boardId: string; columnId: string; title: string }
): Promise<void> {
  const res = await ctx.request.post('/api/tasks', {
    data: input,
    headers: { [CSRF_HEADER]: founderCsrf() },
  })
  expect(res.status(), 'task create should be 201').toBe(201)
}

test('a task written by one session advances the cursor observed by another session', async ({
  browser,
}) => {
  const deviceA = await browser.newContext({ storageState: FOUNDER_STATE }) // Abdullah — writes
  const deviceB = await browser.newContext({ storageState: AFNAN_STATE }) // teammate — reads

  const before = await readTasksCursor(deviceB)

  const { boardId, columnId } = await createBoardWithColumn(deviceA, `Sync Board ${Date.now()}`)
  await createTask(deviceA, { boardId, columnId, title: `Remote card ${Date.now()}` })

  // Device B's poll must now report a strictly newer tasks cursor. This is the
  // signal that drives its auto-refresh — no manual reload involved.
  await expect
    .poll(() => readTasksCursor(deviceB), { timeout: 15_000, message: 'cursor did not advance' })
    .toBeGreaterThan(before)

  await deviceA.close()
  await deviceB.close()
})

test('the cursor endpoint is auth-gated and scoped to permitted modules', async ({
  browser,
  request,
}) => {
  // Anonymous poll: the middleware answers /api with 401 JSON, never data.
  const anon = await request.get('/api/sync/cursor?modules=tasks,finance')
  expect(anon.status()).toBe(401)
  const anonBody = await anon.json().catch(() => null)
  expect(anonBody?.data).toBeUndefined()

  // An authenticated Partner poll: permitted modules come back as numbers, and
  // a made-up module is silently dropped rather than leaking or erroring.
  const partner = await browser.newContext({ storageState: AFNAN_STATE })
  const res = await partner.request.get('/api/sync/cursor?modules=tasks,finance,not_a_module')
  expect(res.ok()).toBeTruthy()
  const data = (await res.json()).data as Record<string, unknown>
  expect(typeof data.tasks).toBe('number')
  expect(typeof data.finance).toBe('number')
  expect(data.not_a_module).toBeUndefined()

  await partner.close()
})

test('a second device repaints the board with a remote task without any reload', async ({
  browser,
}) => {
  const deviceA = await browser.newContext({ storageState: FOUNDER_STATE }) // Abdullah — writes
  const deviceB = await browser.newContext({ storageState: AFNAN_STATE }) // teammate — watches

  // The board exists before the teammate ever opens it.
  const boardName = `Live Board ${Date.now()}`
  const { boardId, columnId } = await createBoardWithColumn(deviceA, boardName)

  // Teammate opens Tasks and selects this specific board (deterministic even if
  // other test boards exist), then waits for the columns to paint.
  const pageB = await deviceB.newPage()
  await pageB.goto('/tasks')
  await pageB.getByLabel('Select board').selectOption(boardId)

  const title = `Auto-painted ${Date.now()}`
  await expect(pageB.getByText(title)).toHaveCount(0) // genuinely absent first

  // Abdullah creates the card on a *different* session/device.
  await createTask(deviceA, { boardId, columnId, title })

  // The teammate's board shows it on its own — no navigation, no reload. The
  // polling transport (floor 3s / default 6s) reconciles within a couple ticks.
  await expect(pageB.getByText(title, { exact: false })).toBeVisible({ timeout: 20_000 })

  await pageB.close()
  await deviceA.close()
  await deviceB.close()
})
