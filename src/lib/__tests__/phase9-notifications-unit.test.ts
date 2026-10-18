/**
 * Phase 9 — Step 2 notifications unit tests.
 *
 * These lock the three hard guarantees the brief names for server-side
 * generation, plus the two threshold events, WITHOUT a live database:
 *
 *   • DEDUPE — the same `{ userId, dedupeKey }` never notifies twice, but the
 *     SAME dedupeKey may exist for two different recipients (a broadcast event).
 *     This is why the mem-mongo fake enforces a COMPOSITE unique index, not a
 *     single-field one (see helpers/mem-mongo.ts).
 *   • PERMISSION-AWARE — a notification about a module the recipient cannot view
 *     is suppressed at emit time, so it never even writes a row (they cannot
 *     learn of data they may not see). `null`-permission types (the recipient's
 *     own sync entries) bypass the module gate.
 *   • PREFERENCE-AWARE — a muted type is dropped; the two operational-integrity
 *     types (`sync_failure`, `sync_conflict`) are non-muteable and always pass.
 *
 * The dedupe KEY formats and `resolveNotificationPrefs` are pure and asserted
 * directly. `emitNotification`, `emitToUsers`/`emitToAllEligible` and
 * `maybeNotifyLargeExpense` run against the in-memory fake with the REAL
 * `getRole`/`hasPermission`; only the delivery side-effects (the Phase 7 live
 * bus and Web Push) are mocked, because a suppressed/no-op push must never be
 * the reason an emit test fails.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { invalidateRoleCache } from '@/lib/authorization'
import { getUserCollection } from '@/lib/models/User'
import {
  budgetCriticalKey,
  budgetWarningKey,
  financialEventKey,
  karachiDay,
  lowStockKey,
  pendingApprovalKey,
  syncConflictKey,
  syncFailureKey,
  taskDueSoonKey,
  taskOverdueKey,
} from '@/lib/notifications/dedupe'
import {
  NON_MUTEABLE_TYPES,
  resolveNotificationPrefs,
  type NotificationPrefs,
} from '@/lib/notifications/types'
import { emitNotification, emitToAllEligible, emitToUsers } from '@/lib/notifications/emit'
import { maybeNotifyLargeExpense } from '@/lib/notifications/events'
import { createMemDb, type MemDb, type Doc } from './helpers/mem-mongo'

let mem: MemDb

// The delivery side-effects are irrelevant to the generation guarantees under
// test; mock them so nothing tries to open an SSE stream or hit a push endpoint.
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

const FOUNDER_ID = new ObjectId('507f1f77bcf86cd799439001')
const PARTNER_ID = new ObjectId('507f1f77bcf86cd799439002')
const OPACITY_ID = new ObjectId('507f1f77bcf86cd799439003') // no module grants

const seed = (rows: {
  users?: Doc[]
  roles?: Doc[]
  businessSettings?: Doc[]
}): void => {
  if (rows.users) mem.db.users.push(...rows.users)
  if (rows.roles) mem.db.roles.push(...rows.roles)
  if (rows.businessSettings) mem.db.businessSettings.push(...rows.businessSettings)
  invalidateRoleCache()
}

/** The default cast: a Founder who can see everything, a Partner who cannot. */
const seedStandardUsers = (founderPrefs?: Partial<NotificationPrefs>): void => {
  seed({
    roles: [
      {
        _id: new ObjectId(),
        name: 'founder',
        displayName: 'Founder',
        permissions: {
          inventory: { view: true },
          finance: { view: true },
          budget: { view: true },
          tasks: { view: true },
        },
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      {
        _id: new ObjectId(),
        name: 'no-access',
        displayName: 'No Access',
        permissions: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ],
    users: [
      {
        _id: FOUNDER_ID,
        email: 'founder@decoricks.com',
        name: 'Founder',
        role: 'founder',
        isActive: true,
        notificationPrefs: founderPrefs,
      },
      {
        _id: PARTNER_ID,
        email: 'opacity@decoricks.com',
        name: 'Opacity',
        role: 'no-access',
        isActive: true,
      },
    ],
  })
}

const notifRows = (): Doc[] => mem.db.notifications.docs as unknown as Doc[]

beforeEach(() => {
  mem = createMemDb()
})

/* -------------------------------- dedupe keys ------------------------------ */

describe('notification dedupe keys', () => {
  it('attributes an event to the Asia/Karachi business day, not the UTC day', () => {
    // 20:00 UTC on Jan 1 is 01:00 on Jan 2 in Karachi (UTC+5): the day rolls over.
    const lateUtc = new Date('2026-01-01T20:00:00.000Z')
    expect(karachiDay(lateUtc)).toBe('2026-01-02')
    expect(lowStockKey('p1', lateUtc)).toBe('low_stock:p1:2026-01-02')
    expect(taskOverdueKey('t1', lateUtc)).toBe('task_overdue:t1:2026-01-02')
  })

  it('keys low stock per product per day', () => {
    const d = new Date('2026-05-05T09:00:00Z')
    expect(lowStockKey('a', d)).not.toBe(lowStockKey('b', d))
    expect(lowStockKey('a', d)).toBe(lowStockKey('a', d))
  })

  it('fires due-soon once per task (no date) but overdue once per task per day', () => {
    expect(taskDueSoonKey('t9')).toBe('task_due_soon:t9')
    const dayA = new Date('2026-05-05T09:00:00Z')
    const dayB = new Date('2026-05-06T09:00:00Z')
    expect(taskOverdueKey('t9', dayA)).not.toBe(taskOverdueKey('t9', dayB))
  })

  it('keys budget warning by the coarse bucket the caller supplies; critical is a one-shot', () => {
    // `bucket` is pre-rounded by the caller (`Math.floor(pct / 10) * 10` in
    // events.ts), so 80%→89% both map to the SAME bucket and one alert, while a
    // move into the 90s is a fresh bucket -> a fresh alert.
    const bucket = (pct: number) => Math.floor(pct / 10) * 10
    expect(budgetWarningKey('b', 'Materials', bucket(80))).toBe(
      budgetWarningKey('b', 'Materials', bucket(89))
    )
    expect(budgetWarningKey('b', 'Materials', bucket(89))).not.toBe(
      budgetWarningKey('b', 'Materials', bucket(90))
    )
    // Critical is a plain one-shot per budget+category (no bucket).
    expect(budgetCriticalKey('b', 'Materials')).toBe(budgetCriticalKey('b', 'Materials'))
    expect(budgetCriticalKey('b', 'Materials')).not.toBe(budgetCriticalKey('b', 'Labour'))
  })

  it('ties sync keys to the idempotency key and financial keys to entity', () => {
    expect(syncFailureKey('ik-1')).toBe('sync_fail:ik-1')
    expect(syncConflictKey('ik-1')).toBe('sync_conflict:ik-1')
    expect(pendingApprovalKey('budget', 'b1')).toBe('pending:budget:b1')
    expect(financialEventKey('large_expense', 'tx1')).toBe('fin:large_expense:tx1')
  })
})

/* ------------------------------- preferences ------------------------------- */

describe('resolveNotificationPrefs', () => {
  it('defaults every type to enabled for a user with no stored prefs', () => {
    const prefs = resolveNotificationPrefs(undefined)
    expect(Object.values(prefs).every((p) => p.enabled === true)).toBe(true)
  })

  it('honours a stored opt-out for a muteable type', () => {
    const prefs = resolveNotificationPrefs({ low_stock: { enabled: false } })
    expect(prefs.low_stock.enabled).toBe(false)
    expect(prefs.task_overdue.enabled).toBe(true)
  })

  it('forces the two operational-integrity types on even when stored disabled', () => {
    const prefs = resolveNotificationPrefs({
      sync_failure: { enabled: false },
      sync_conflict: { enabled: false },
    })
    expect([...NON_MUTEABLE_TYPES]).toEqual(['sync_failure', 'sync_conflict'])
    expect(prefs.sync_failure.enabled).toBe(true)
    expect(prefs.sync_conflict.enabled).toBe(true)
  })
})

/* ------------------------------ emit: gates -------------------------------- */

describe('emitNotification permission + preference gates', () => {
  it('writes a row for a recipient who holds the module grant', async () => {
    seedStandardUsers()
    const res = await emitNotification(mem.handle as never, {
      userId: FOUNDER_ID,
      type: 'low_stock',
      dedupeKey: lowStockKey('p1'),
      title: 'Low stock',
      message: 'msg',
      data: { entityType: 'product', entityId: 'p1' },
    })
    expect(res.created).toBe(true)
    expect(notifRows()).toHaveLength(1)
    expect(notifRows()[0].userId).toEqual(FOUNDER_ID)
  })

  it('suppresses entirely for a recipient WITHOUT the module grant — no row', async () => {
    seedStandardUsers()
    const res = await emitNotification(mem.handle as never, {
      userId: PARTNER_ID, // role 'no-access'
      type: 'low_stock',
      dedupeKey: lowStockKey('p1'),
      title: 'Low stock',
      message: 'msg',
      data: { entityType: 'product', entityId: 'p1' },
    })
    expect(res.created).toBe(false)
    expect(notifRows()).toHaveLength(0)
  })

  it('drops a muted type for a recipient who otherwise has the grant', async () => {
    seedStandardUsers({ low_stock: { enabled: false } })
    const res = await emitNotification(mem.handle as never, {
      userId: FOUNDER_ID,
      type: 'low_stock',
      dedupeKey: lowStockKey('p1'),
      title: 'Low stock',
      message: 'msg',
      data: { entityType: 'product', entityId: 'p1' },
    })
    expect(res.created).toBe(false)
    expect(notifRows()).toHaveLength(0)
  })

  it('never gates the two non-muteable integrity types on permission or prefs', async () => {
    // The 'no-access' user has no grants and could mute everything, yet a sync
    // failure about THEIR OWN queued entry must still reach them (null perm).
    seedStandardUsers({ sync_failure: { enabled: false } })
    const res = await emitNotification(mem.handle as never, {
      userId: PARTNER_ID,
      type: 'sync_failure',
      dedupeKey: syncFailureKey('ik-1'),
      title: 'Sync failed',
      message: 'msg',
      data: { entityType: 'sync', entityId: 'ik-1' },
    })
    expect(res.created).toBe(true)
  })

  it('skips an inactive recipient', async () => {
    seed({
      users: [{ _id: OPACITY_ID, role: 'founder', isActive: false }],
      roles: [{ _id: new ObjectId(), name: 'founder', displayName: 'Founder', permissions: {} }],
    })
    const res = await emitNotification(mem.handle as never, {
      userId: OPACITY_ID,
      type: 'sync_failure',
      dedupeKey: syncFailureKey('ik-1'),
      title: 'x',
      message: 'y',
      data: { entityType: 'sync', entityId: 'ik-1' },
    })
    expect(res.created).toBe(false)
  })
})

/* ------------------------------- emit: dedupe ------------------------------ */

describe('emitNotification dedupe', () => {
  it('swallows a second identical event for the same user — never two rows', async () => {
    seedStandardUsers()
    const input = {
      userId: FOUNDER_ID,
      type: 'budget_warning' as const,
      dedupeKey: budgetWarningKey('b1', 'Materials', 80),
      title: 'Budget warning',
      message: 'msg',
      data: { entityType: 'budget' as const, entityId: 'b1' },
    }
    const first = await emitNotification(mem.handle as never, input)
    const second = await emitNotification(mem.handle as never, input)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(notifRows()).toHaveLength(1)
  })

  it('lets the SAME dedupeKey reach two different recipients (composite, not global)', async () => {
    // Two Founders both holding inventory.view, one broadcast low-stock event.
    seed({
      roles: [
        {
          _id: new ObjectId(),
          name: 'founder',
          displayName: 'Founder',
          permissions: { inventory: { view: true } },
        },
      ],
      users: [
        { _id: FOUNDER_ID, role: 'founder', isActive: true },
        { _id: PARTNER_ID, role: 'founder', isActive: true },
      ],
    })
    const created = await emitToAllEligible(mem.handle as never, {
      type: 'low_stock',
      dedupeKey: lowStockKey('shared-product'),
      title: 'Low stock',
      message: 'msg',
      data: { entityType: 'product', entityId: 'shared-product' },
    })
    expect(created).toBe(2)
    expect(notifRows()).toHaveLength(2)
  })

  it('emitToUsers de-duplicates repeated recipient ids', async () => {
    seedStandardUsers()
    const created = await emitToUsers(mem.handle as never, [FOUNDER_ID, FOUNDER_ID.toString()], {
      type: 'financial_event',
      dedupeKey: financialEventKey('withdrawal_request', 'tx5'),
      title: 'Withdrawal',
      message: 'msg',
      data: { entityType: 'transaction', entityId: 'tx5' },
    })
    expect(created).toBe(1)
  })
})

/* --------------------------- threshold: large expense --------------------- */

describe('maybeNotifyLargeExpense threshold event', () => {
  const txId = '507f1f77bcf86cd7994390aa'

  const run = (amountPaisa: number, type = 'expense') =>
    maybeNotifyLargeExpense(mem.handle as never, {
      transactionId: txId,
      type: type as never,
      amountPaisa,
    })

  it('is disabled until the Founder configures a threshold', async () => {
    seedStandardUsers() // no businessSettings row
    expect(await run(10_000_00)).toBe(0)
    expect(notifRows()).toHaveLength(0)
  })

  it('stays silent below the configured threshold', async () => {
    seedStandardUsers()
    mem.db.businessSettings.push({ _id: new ObjectId(), key: 'business', largeExpenseThresholdPkr: 50_000 })
    invalidateRoleCache()
    // 49,999 PKR in paisa is below a 50,000 PKR threshold.
    expect(await run(4_999_900)).toBe(0)
    expect(notifRows()).toHaveLength(0)
  })

  it('alerts the Founder once at or above the threshold', async () => {
    seedStandardUsers()
    mem.db.businessSettings.push({ _id: new ObjectId(), key: 'business', largeExpenseThresholdPkr: 50_000 })
    invalidateRoleCache()
    // 50,000 PKR = 5,000,000 paisa → meets the threshold.
    expect(await run(5_000_000)).toBe(1)
    const rows = notifRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('financial_event')
    expect((rows[0].data as Doc).kind).toBe('large_expense')
    expect(rows[0].userId).toEqual(FOUNDER_ID)
  })

  it('ignores non-expense entry types', async () => {
    seedStandardUsers()
    mem.db.businessSettings.push({ _id: new ObjectId(), key: 'business', largeExpenseThresholdPkr: 1 })
    invalidateRoleCache()
    expect(await run(99_999_900, 'income')).toBe(0)
    expect(notifRows()).toHaveLength(0)
  })

  it('dedupes when the same transaction is evaluated twice', async () => {
    seedStandardUsers()
    mem.db.businessSettings.push({ _id: new ObjectId(), key: 'business', largeExpenseThresholdPkr: 10 })
    invalidateRoleCache()
    expect(await run(5_000_000)).toBe(1)
    expect(await run(5_000_000)).toBe(0)
    expect(notifRows()).toHaveLength(1)
  })
})

/* ----------------------------- sanity: model hook -------------------------- */

describe('getUserCollection smoke', () => {
  it('reads the seeded recipient so the emit gate has real role/prefs to judge', async () => {
    seedStandardUsers()
    const user = await getUserCollection(mem.handle as never).findOne({ _id: FOUNDER_ID } as never)
    expect(user?.role).toBe('founder')
    expect(user?.isActive).toBe(true)
  })
})
