import { test, expect, type Page, type Route } from '@playwright/test'
import { FOUNDER_STATE, AFNAN_STATE } from './helpers'

/**
 * The "Create board" fix (Phase 10 checkpoint 5).
 *
 * At `/tasks` with zero boards a Founder previously saw "No boards yet" with no
 * way forward. The fix puts a Create board button in both the header and the
 * empty state; it POSTs /api/boards with an idempotency key and the server seeds
 * the four default columns. A Partner must not see the affordance.
 *
 * Determinism note: the Create board button only renders when the board LIST is
 * empty, but the shared e2e database (`decoricks_test`) may hold boards left
 * behind by other specs (e.g. phase6-board ensures one exists). Rather than
 * mutate global board state and fight those specs, we render the real UI from a
 * mocked empty list — GET /api/boards is fulfilled with zero boards, while every
 * POST still falls through to the live e2e server, which is backed by
 * `decoricks_test` (E2E_TEST_MODE + MONGODB_TEST_DB, see playwright.config.ts).
 * So the permission gating, the double-click guard and the create call are all
 * exercised against the real backend; only the "am I empty?" read is stubbed.
 *
 * The DB-level idempotency guarantee (partial unique index on `idempotencyKey`,
 * four default columns) is covered by the real-mongod unit test
 * `src/lib/__tests__/board-idempotency-index.test.ts`; here we prove the UI
 * never issues a second create on a double click.
 */

const emptyBoardList = (route: Route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: { boards: [] },
      timestamp: new Date().toISOString(),
    }),
  })

/** Founder + Partner in one test, each in its own authenticated context. */
test('Founder sees Create board; a Partner does not', async ({ browser }) => {
  const openTasksWithZeroBoards = async (storageState: string): Promise<Page> => {
    const context = await browser.newContext({ storageState })
    const page = await context.newPage()
    // GET the empty list; POST everything else to the real server.
    await page.route('**/api/boards', async (route) => {
      if (route.request().method() === 'GET') return emptyBoardList(route)
      return route.fallback()
    })
    await page.goto('/tasks')
    await expect(page.getByText('No boards yet')).toBeVisible({ timeout: 15_000 })
    return page
  }

  const founder = await openTasksWithZeroBoards(FOUNDER_STATE)
  // Both the header action and the empty-state action render a Create board
  // button for the Founder.
  await expect(
    founder.getByRole('button', { name: 'Create board', exact: true }).first()
  ).toBeVisible()
  await expect(founder.getByRole('button', { name: 'Create board', exact: true })).not.toHaveCount(
    0
  )

  const partner = await openTasksWithZeroBoards(AFNAN_STATE)
  await expect(partner.getByText('No boards yet')).toBeVisible({ timeout: 15_000 })
  await expect(partner.getByRole('button', { name: 'Create board', exact: true })).toHaveCount(0)

  await founder.context().close()
  await partner.context().close()
})

test('a double click on Create board issues exactly one create', async ({ browser }) => {
  const context = await browser.newContext({ storageState: FOUNDER_STATE })
  const page = await context.newPage()

  // Render the empty state; let POSTs fall through to the live e2e server.
  await page.route('**/api/boards', (route) => {
    if (route.request().method() === 'GET') return emptyBoardList(route)
    return route.fallback()
  })

  // Count real create calls that reach the backend and capture the status.
  let postCount = 0
  let createdStatus = 0
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/boards')) postCount += 1
  })
  page.on('response', (res) => {
    if (res.request().method() === 'POST' && res.url().includes('/api/boards'))
      createdStatus = res.status()
  })

  await page.goto('/tasks')
  await expect(page.getByText('No boards yet')).toBeVisible({ timeout: 15_000 })

  // Open the modal via the empty-state Create board button.
  await page.getByRole('button', { name: 'Create board', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  // The modal is up once its unique "Board name" field is present (a text match
  // on "Create board" would be ambiguous — the heading, the description and the
  // submit button all carry it).
  await expect(dialog.getByLabel('Board name')).toBeVisible()

  const name = `E2E double-click ${Date.now()}`
  await dialog.getByLabel('Board name').fill(name)

  // One rapid double click on the submit. The synchronous creatingBoardRef
  // guard (and the disabled state it sets) must collapse it into a single POST.
  await dialog.getByRole('button', { name: 'Create board', exact: true }).dblclick()

  await expect
    .poll(() => postCount, { timeout: 15_000, message: 'the create POST should reach the server' })
    .toBe(1)
  // Give any stray second request a window to appear before asserting the cap.
  await page.waitForTimeout(1_500)
  expect(postCount).toBe(1)
  expect(createdStatus).toBe(201)

  await context.close()
})
