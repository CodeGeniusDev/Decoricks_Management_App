import { test, expect, type Page, type Locator, type APIRequestContext } from '@playwright/test'
import { BASE_URL, FOUNDER_STATE, CSRF_HEADER, csrfFromState } from './helpers'

/**
 * Phase 6 acceptance: the Trello-style board journey.
 *
 * A Founder signs in, creates a card on the live board, moves it into the
 * Done column, and the server-side `completedAt` is verified through the API —
 * the exact field the completion transition writes. The move is exercised two
 * ways, because both drive the same guarded `POST /api/tasks/[id]/move`:
 *
 *   1. a real pointer drag of the card via its dnd-kit grip (the primary
 *      interaction), and
 *   2. the per-card "Move to…" dropdown, which is the deterministic fallback
 *      the accessibility story relies on and the path most robust to drag
 *      physics in a headless browser.
 *
 * These specs are NOT part of `npm run test`; they run against a live dev
 * server via `npm run test:e2e`. A board (with the default To Do / … / Done
 * columns) is ensured through the API in `beforeAll` so the run is hermetic.
 */

let founder: APIRequestContext
let csrf = ''
let boardId = ''
let doneColumnId = ''

interface BoardTask {
  _id: string
  title: string
  columnId: string
  completedAt: string | null
}
interface BoardColumn {
  _id: string
  name: string
  isDoneColumn: boolean
}

const fetchBoard = async (): Promise<{
  columns: BoardColumn[]
  tasks: Record<string, BoardTask[]>
}> => {
  const res = await founder.get(`/api/boards/${boardId}`)
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as {
    data: { columns: BoardColumn[]; tasksByColumn: Record<string, BoardTask[]> }
  }
  return { columns: body.data.columns, tasks: body.data.tasksByColumn }
}

/**
 * A card's title button inside `scope`, matched by the start of its accessible
 * name. Each card also renders its `taskNumber` (e.g. "TASK-202610-0007")
 * inside the same button, so the accessible name is `"<title> <taskNumber>"`
 * — a `exact: true` title match can never be correct. Anchoring on the title
 * still distinguishes it from the drag handle, whose name starts with "Drag".
 */
const cardButtonIn = (scope: Page | Locator, title: string) =>
  scope.getByRole('button', {
    name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  })

test.describe('phase 6 board journey', () => {
  test.use({ storageState: FOUNDER_STATE })
  // Board mutations round-trip through the shared Atlas test DB while up to 12
  // browser contexts run concurrently in the default (non-CI) config, so a
  // single create/move can legitimately take several seconds. Give the journey
  // headroom rather than failing on network latency alone.
  test.setTimeout(90_000)

  test.beforeAll(async ({ playwright }) => {
    founder = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: FOUNDER_STATE,
    })
    csrf = csrfFromState(FOUNDER_STATE)

    // Ensure at least one board exists; the create route seeds default columns.
    const list = await founder.get('/api/boards')
    const boards =
      ((await list.json()) as { data: { boards: Array<{ _id: string }> } }).data.boards ?? []
    if (boards.length === 0) {
      const created = await founder.post('/api/boards', {
        headers: { [CSRF_HEADER]: csrf },
        data: { name: 'E2E Operations Board' },
      })
      expect(created.status()).toBe(200)
    }
    const after = await founder.get('/api/boards')
    const first = ((await after.json()) as { data: { boards: Array<{ _id: string }> } }).data
      .boards[0]
    boardId = first._id

    // Remember the board's Done column so we can assert `completedAt` after a move.
    const detail = await fetchBoardForSetup()
    const done = detail.columns.find((c) => c.isDoneColumn)
    expect(done, 'board must expose a done column').toBeTruthy()
    doneColumnId = done!._id
  })

  const fetchBoardForSetup = async () => {
    const res = await founder.get(`/api/boards/${boardId}`)
    const body = (await res.json()) as {
      data: { columns: BoardColumn[]; tasksByColumn: Record<string, BoardTask[]> }
    }
    return { columns: body.data.columns, tasks: body.data.tasksByColumn }
  }

  test.afterAll(async () => {
    await founder?.dispose()
  })

  const openBoard = async (page: Page) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/tasks')
    await expect(page.getByRole('button', { name: 'Board' })).toBeVisible({ timeout: 15_000 })
    // Wait for the default columns to render before interacting.
    await expect(page.getByRole('heading', { name: 'To Do', exact: true })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByRole('heading', { name: 'Done', exact: true })).toBeVisible({
      timeout: 15_000,
    })
  }

  /** Creates a uniquely-titled card in the To Do column through the UI modal. */
  const createCard = async (page: Page, title: string) => {
    const todoColumn = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'To Do', exact: true }) })
    await todoColumn.getByLabel('Add card').click()

    const modal = page.getByRole('dialog')
    await expect(modal.getByText('New task')).toBeVisible()
    await modal.getByLabel('Title').fill(title)

    // The authoritative success signal is the card landing on the board — the
    // guarded POST is idempotent and returns 201 — not the exact frame the
    // modal's exit animation clears, which races the realtime refresh. Two
    // phases, so a slow-but-successful POST (common when 12 browser contexts
    // share one Atlas instance) is never mistaken for a dropped click and
    // retried into a duplicate:
    //   1. wait a generous window for the single click to land;
    //   2. only if the card is STILL absent (the click was swallowed by load)
    //      re-issue it once and wait again. The retry is unreachable once the
    //      card exists, so it can never double-create.
    const waitCreated = (ms: number) =>
      expect.poll(async () => await cardOnBoard(title), { timeout: ms }).toBe(true)
    await modal.getByRole('button', { name: 'Create task' }).click()
    await waitCreated(6_000).catch(() => {})
    if (!(await cardOnBoard(title))) {
      await modal
        .getByRole('button', { name: 'Create task' })
        .click({ timeout: 3_000 })
        .catch(() => {})
      await waitCreated(20_000)
    }

    await modal
      .getByRole('button', { name: 'Close dialog' })
      .click({ timeout: 5_000 })
      .catch(() => {})
    await expect(cardButtonIn(todoColumn, title)).toBeVisible({ timeout: 15_000 })
  }

  /** Whether a task with this exact title exists anywhere on the active board. */
  const cardOnBoard = async (title: string): Promise<boolean> => {
    const res = await founder.get(`/api/boards/${boardId}`)
    if (!res.ok()) return false
    const body = (await res.json()) as {
      data: { tasksByColumn: Record<string, Array<{ title: string }>> }
    }
    return Object.values(body.data.tasksByColumn)
      .flat()
      .some((t) => t.title === title)
  }

  test('create a card, move it to Done, and the server stamps completedAt', async ({ page }) => {
    await openBoard(page)
    const title = `E2E ship ${Date.now()}`
    await createCard(page, title)

    // Move the card into Done via the per-card "Move to…" dropdown — the
    // deterministic board mutation that calls the same guarded /move endpoint.
    const card = page.locator('div.group').filter({ has: cardButtonIn(page, title) })
    await card.getByLabel('Move task to another column').selectOption({ label: 'Move to Done' })

    // Optimistically the card re-appears under the Done column.
    const doneColumn = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Done', exact: true }) })
    await expect(cardButtonIn(doneColumn, title)).toBeVisible({
      timeout: 15_000,
    })

    // And authoritatively the server recorded the completion.
    await expect
      .poll(
        async () => {
          const { tasks } = await fetchBoard()
          const flat = Object.entries(tasks).flatMap(([col, list]) =>
            list.filter((t) => t.title === title).map((t) => ({ col, completedAt: t.completedAt }))
          )
          const inDone = flat.find((t) => t.col === doneColumnId)
          return inDone && inDone.completedAt ? 'completed' : `${flat.length} / done?${!!inDone}`
        },
        { timeout: 15_000, message: 'card should be in the Done column with completedAt set' }
      )
      .toBe('completed')
  })

  test('a pointer drag of the grip moves the card to the Done column', async ({ page }) => {
    await openBoard(page)
    const title = `E2E drag ${Date.now()}`
    await createCard(page, title)

    const grip = page.getByLabel(`Drag ${title} to another column`, { exact: true })
    await expect(grip).toBeVisible()

    const doneBody = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Done', exact: true }) })

    const from = await grip.boundingBox()
    const to = await doneBody.boundingBox()
    expect(from && to).toBeTruthy()

    // dnd-kit's PointerSensor activates after a small move, then follows the
    // pointer until release over a droppable. We release over the target
    // column's *visible* header near the top of the board, not the bottom of
    // its (potentially very tall) droppable rect: the columns stretch to the
    // full board height, so dropping at the section's bottom lands far below
    // the viewport where dnd-kit's default rect-intersection resolver sees no
    // overlap and dispatches no move. Stepping the move past the 4px
    // activation distance keeps the sensor happy in a headless browser.
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
    await page.mouse.down()
    await page.mouse.move((from!.x + to!.x) / 2 + to!.width / 4, from!.y, { steps: 6 })
    await page.mouse.move(to!.x + to!.width / 2, to!.y + 12, { steps: 8 })
    await page.mouse.up()

    // The drag posts the same guarded /move; verify the completion server-side.
    await expect
      .poll(
        async () => {
          const { tasks } = await fetchBoard()
          const flat = Object.values(tasks).flat()
          const moved = flat.find((t) => t.title === title)
          return moved && moved.columnId === doneColumnId && moved.completedAt
            ? 'completed'
            : 'pending'
        },
        { timeout: 15_000, message: 'drag should move the card to Done' }
      )
      .toBe('completed')
  })
})
