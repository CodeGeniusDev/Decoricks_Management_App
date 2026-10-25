/**
 * The cron trigger against the REAL notification sweep.
 *
 * `cron-notifications-route.test.ts` mocks the sweep so each case can control one
 * variable. That is the wrong shape for the two claims the brief actually asks
 * for, which are about behaviour over TIME:
 *
 *   • THROTTLED — the route must not be able to turn a 15-minute job into a
 *     per-minute one. Nothing here re-implements a throttle: the timer is moved
 *     forward 14 and 16 minutes and the existing `maybeRunNotificationSweep`
 *     decides, while a counter on the stock read proves how many sweeps actually
 *     happened.
 *   • DEDUPED — a sweep that runs again must create no second alert for the same
 *     event. That property lives in the unique `{ userId, dedupeKey }` index, so
 *     these tests run against the real emit layer with the fake MongoDB enforcing
 *     that composite index for real (see `helpers/mem-mongo.ts`).
 *
 * Everything else about the request is real too: the actual route module, the
 * actual secret check, the actual notification rows. Only the things that would
 * make this a network test are stubbed — the database handle (in-memory fake),
 * the stock catalogue read (a fixed set of items, so "low" is deterministic
 * without rebuilding Phase 5), the live-delivery bus and Web Push.
 *
 * The leak assertion is written as a positive control: the task title, product
 * name and recipient identity must appear in the rows the sweep created and must
 * NOT appear in the response. Proving the second half without the first would
 * only prove the sweep did nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import type { NextRequest } from 'next/server'
import { invalidateRoleCache } from '@/lib/authorization'
import { __resetEnvForTests } from '@/lib/env'
import { GET } from '@/app/api/cron/notifications/route'
import { __resetSweepForTests } from '@/lib/notifications/sweep'
import { createMemDb, type Doc, type MemDb } from './helpers/mem-mongo'

const mocks = vi.hoisted(() => ({ buildStockSummary: vi.fn() }))

let mem: MemDb

vi.mock('@/lib/stock-summary', () => ({ buildStockSummary: mocks.buildStockSummary }))

vi.mock('@/lib/realtime/bus', () => ({
  realtimeBus: { publish: vi.fn(), latestId: vi.fn(() => '0'), since: vi.fn(() => []) },
}))

vi.mock('@/lib/notifications/push', () => ({
  deliverPush: vi.fn(async () => undefined),
  getVapidPublicKey: vi.fn(() => null),
}))

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => mem.handle),
  getMongoClient: vi.fn(async () => mem.client),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

/* --------------------------------- fixtures -------------------------------- */

const SECRET = 'cron-integration-secret-0123456789abcdef'
const HEADER = { 'x-cron-secret': SECRET, 'x-forwarded-for': '203.0.113.9' }

/** 09:00 UTC = 14:00 in Karachi, so the business day cannot roll over mid-test. */
const BASE = new Date('2026-10-26T09:00:00.000Z')

const FOUNDER_ID = new ObjectId('507f1f77bcf86cd799439021')
const OPEN_COLUMN = new ObjectId('507f1f77bcf86cd799439022')
const DONE_COLUMN = new ObjectId('507f1f77bcf86cd799439023')

/** Markers chosen so a leak into a response would be unmistakable. */
const OVERDUE_TITLE = 'LEAKCANARY handover velvet drapes'
const PRODUCT_NAME = 'LEAKCANARY Velvet Fabric'
const FOUNDER_NAME = 'LEAKCANARY Founder'
const FOUNDER_EMAIL = 'leakcanary@decoricks.test'

const task = (overrides: Partial<Doc>): Doc => ({
  _id: new ObjectId(),
  boardId: new ObjectId(),
  columnId: OPEN_COLUMN,
  position: 1,
  title: 'untitled',
  assigneeIds: [FOUNDER_ID],
  priority: 'medium',
  dueDate: null,
  labelIds: [],
  checklist: [],
  version: 1,
  isArchived: false,
  ...overrides,
})

const seedWorld = (): void => {
  mem.db.roles.push({
    _id: new ObjectId(),
    name: 'founder',
    displayName: 'Founder',
    permissions: {
      tasks: { view: true },
      inventory: { view: true },
      finance: { view: true },
      budget: { view: true },
    },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  })
  mem.db.users.push({
    _id: FOUNDER_ID,
    email: FOUNDER_EMAIL,
    name: FOUNDER_NAME,
    role: 'founder',
    isActive: true,
  })
  mem.db.columns.push(
    { _id: OPEN_COLUMN, boardId: new ObjectId(), name: 'In Progress', isDoneColumn: false },
    { _id: DONE_COLUMN, boardId: new ObjectId(), name: 'Done', isDoneColumn: true }
  )
  mem.db.tasks.push(
    // The two that must fire.
    task({ title: OVERDUE_TITLE, dueDate: new Date(BASE.getTime() - 36 * 60 * 60 * 1000) }),
    task({
      title: 'LEAKCANARY measuring site',
      dueDate: new Date(BASE.getTime() + 24 * 60 * 60 * 1000),
    }),
    // The three that must not: finished, nobody assigned, not due for a while.
    task({
      title: 'LEAKCANARY already delivered',
      columnId: DONE_COLUMN,
      dueDate: new Date(BASE.getTime() - 5 * 24 * 60 * 60 * 1000),
    }),
    task({
      title: 'LEAKCANARY unassigned',
      assigneeIds: [],
      dueDate: new Date(BASE.getTime() - 48 * 60 * 60 * 1000),
    }),
    task({
      title: 'LEAKCANARY next month',
      dueDate: new Date(BASE.getTime() + 10 * 24 * 60 * 60 * 1000),
    })
  )

  const lowItem = {
    _id: 'product-low-1',
    sku: 'VEL-001',
    name: PRODUCT_NAME,
    category: 'Fabric',
    isActive: true,
    cost: 100000,
    sellingPrice: 150000,
    reorderLevel: 10,
    byLocation: [],
    totalAvailable: 3,
    totalDamaged: 0,
    totalReturned: 0,
    valuation: 300000,
    lowStock: true,
  }
  const healthyItem = { ...lowItem, _id: 'product-ok-1', name: 'LEAKCANARY Silk', lowStock: false }
  mocks.buildStockSummary.mockImplementation(async () => ({ items: [lowItem, healthyItem] }))

  invalidateRoleCache()
}

const notificationRows = (): Doc[] => mem.db.notifications.docs as unknown as Doc[]

const trigger = async (headers: Record<string, string> = HEADER) => {
  const request = new Request('http://localhost/api/cron/notifications', {
    headers,
  }) as unknown as NextRequest
  const response = await GET(request)
  return { response, body: await response.json() }
}

/** Move the clock to `minutes` after the fixed base time. */
const advanceTo = (minutes: number): void => {
  vi.setSystemTime(new Date(BASE.getTime() + minutes * 60 * 1000))
}

beforeEach(() => {
  mem = createMemDb()
  mocks.buildStockSummary.mockReset()
  __resetSweepForTests()
  __resetEnvForTests()
  process.env.CRON_SECRET = SECRET
  // The sweep logs on purpose; keep it out of the test output and readable below.
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.useFakeTimers()
  vi.setSystemTime(BASE)
  seedWorld()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.CRON_SECRET
  __resetSweepForTests()
})

/* ---------------------------------- tests ---------------------------------- */

describe('the timer runs the real sweep', () => {
  it('creates exactly the alerts a partner opening the app would have created', async () => {
    const { response, body } = await trigger()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ executed: true, overdue: 1, dueSoon: 1, lowStock: 1 })

    const rows = notificationRows()
    expect(rows.map((row) => row.type).sort()).toEqual([
      'low_stock',
      'task_due_soon',
      'task_overdue',
    ])
    // Every row belongs to the one user who can see the modules involved.
    expect(
      rows.every((row) => row.userId instanceof ObjectId && row.userId.equals(FOUNDER_ID))
    ).toBe(true)
    // The ignored cards produced nothing, even though two of them are overdue.
    const messages = rows.map((row) => JSON.stringify(row)).join(' ')
    expect(messages).not.toContain('already delivered')
    expect(messages).not.toContain('next month')
    expect(messages).not.toContain('LEAKCANARY unassigned')
  })

  it('shares one in-flight sweep across two simultaneous triggers', async () => {
    const [first, second] = await Promise.all([trigger(), trigger()])

    expect(first.body.data.executed).toBe(true)
    expect(second.body.data.executed).toBe(true)
    expect(second.body.data).toEqual(first.body.data)
    // One scan, not two — the point of the in-flight guard.
    expect(mocks.buildStockSummary).toHaveBeenCalledTimes(1)
    expect(notificationRows()).toHaveLength(3)
  })
})

describe('the existing 15-minute throttle governs the timer', () => {
  it('reports executed false, and does no work, for calls inside the window', async () => {
    const first = await trigger()
    expect(first.body.data.executed).toBe(true)
    expect(mocks.buildStockSummary).toHaveBeenCalledTimes(1)

    // Immediately again: the same request, the same secret, nothing to do.
    const second = await trigger()
    expect(second.response.status).toBe(200)
    expect(second.body.data).toEqual({ executed: false, overdue: 0, dueSoon: 0, lowStock: 0 })

    // 14 minutes: still one minute short of the real constant.
    advanceTo(14)
    const third = await trigger()
    expect(third.body.data.executed).toBe(false)

    expect(mocks.buildStockSummary).toHaveBeenCalledTimes(1)
    expect(notificationRows()).toHaveLength(3)
  })

  it('runs again once the window has actually passed', async () => {
    await trigger()
    advanceTo(16)

    const later = await trigger()
    expect(later.response.status).toBe(200)
    expect(later.body.data.executed).toBe(true)
    expect(mocks.buildStockSummary).toHaveBeenCalledTimes(2)
  })

  it('a monitor polling every minute costs one sweep per quarter hour', async () => {
    // 60 calls, one per simulated minute, in two hours of polling.
    for (let minute = 0; minute < 120; minute++) {
      advanceTo(minute)
      const { body } = await trigger()
      expect(body.success).toBe(true)
    }
    // Sweep at minute 0, then 15, 30, 45, 60, 75, 90, 105 — eight, not 120.
    expect(mocks.buildStockSummary).toHaveBeenCalledTimes(8)
    expect(notificationRows()).toHaveLength(3)
  })
})

describe('re-running the sweep never re-alerts', () => {
  it('creates zero rows on a second run for the same events', async () => {
    const first = await trigger()
    expect(first.body.data).toMatchObject({ executed: true, overdue: 1, dueSoon: 1, lowStock: 1 })

    advanceTo(16)
    const again = await trigger()

    // The sweep genuinely ran (`executed`), found the same overdue card, the same
    // due-soon card and the same low-stock product — and every insert was
    // rejected as already-notified, so the counts are zero.
    expect(again.body.data).toEqual({ executed: true, overdue: 0, dueSoon: 0, lowStock: 0 })
    expect(notificationRows()).toHaveLength(3)

    // And no duplicate recipient+event pair exists anywhere in the collection.
    const pairs = notificationRows().map((row) => `${row.userId}:${row.dedupeKey}`)
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  it('still does not re-alert on a third run, hours later', async () => {
    await trigger()
    for (const minute of [16, 32, 48]) {
      advanceTo(minute)
      const { body } = await trigger()
      expect(body.data.overdue).toBe(0)
      expect(body.data.dueSoon).toBe(0)
      expect(body.data.lowStock).toBe(0)
    }
    expect(notificationRows()).toHaveLength(3)
  })

  it('a task still overdue the next business day re-alerts, and only that', async () => {
    // Dedupe must not mean "never again". The overdue and low-stock keys are
    // per Asia/Karachi day, the due-soon key is once per task ever — so 16 hours
    // later (06:00 the next Karachi morning) exactly two of the three re-arm.
    await trigger()
    advanceTo(16 * 60)
    const nextDay = await trigger()

    expect(nextDay.body.data.executed).toBe(true)
    expect(nextDay.body.data).toEqual({ executed: true, overdue: 1, dueSoon: 0, lowStock: 1 })
    expect(notificationRows()).toHaveLength(5)
  })
})

describe('the trigger response carries no business data', () => {
  it('withholds content that the notifications themselves contain', async () => {
    const { body } = await trigger()
    const payload = JSON.stringify(body)

    // Positive control first: everything listed here really was written to the
    // database by this sweep. Without that, "the response says none of it" would
    // only prove the sweep did nothing.
    const written = JSON.stringify(notificationRows())
    const businessData = [
      OVERDUE_TITLE,
      PRODUCT_NAME,
      FOUNDER_ID.toString(),
      '/tasks?task=',
      '/inventory?product=',
    ]
    for (const marker of businessData) expect(written).toContain(marker)

    // The response carries four numbers. Nothing that identifies a task, a
    // product, a person or a screen to click through to.
    for (const marker of [...businessData, FOUNDER_NAME, FOUNDER_EMAIL, 'LEAKCAN']) {
      expect(payload).not.toContain(marker)
    }
    expect(payload).not.toMatch(/title|message|dedupeKey|userId|email|name/i)
    expect(Object.keys(body.data).sort()).toEqual(['dueSoon', 'executed', 'lowStock', 'overdue'])
  })

  it('answers an unauthenticated poll without reaching the sweep at all', async () => {
    const { response, body } = await trigger({ 'x-forwarded-for': '203.0.113.9' })

    expect(response.status).toBe(401)
    expect(mocks.buildStockSummary).not.toHaveBeenCalled()
    expect(notificationRows()).toHaveLength(0)
    expect(JSON.stringify(body)).not.toContain('LEAKCAN')
  })
})

describe('a broken sweep is visible to the timer', () => {
  it('answers 503 when the real sweep throws, and logs the cause', async () => {
    // The sweep reads done-columns first; make that read fail the way a bad
    // replica-set step would, without touching anything else.
    const columns = mem.collection('columns')
    const original = columns.find.bind(columns)
    columns.find = (() => {
      throw new Error('simulated collection read failure')
    }) as typeof columns.find

    try {
      const { response, body } = await trigger()
      expect(response.status).toBe(503)
      expect(body.success).toBe(false)
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE')
      expect(body.data).toBeUndefined()
      expect(JSON.stringify(body)).not.toContain('simulated collection read failure')
      expect(JSON.stringify(body)).not.toContain('LEAKCAN')
      // The operator sees the cause in the log, not in a response a monitor logs.
      expect(console.error).toHaveBeenCalled()
    } finally {
      columns.find = original
    }
  })
})
