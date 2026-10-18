/**
 * Phase 9 — Step 2 notification API tests.
 *
 * These lock the read-model security the brief calls out for the in-app centre:
 *
 *   • 401 on EVERY route when there is no session (list, mark-read, mark-all,
 *     and both preferences verbs). These are OWN-data endpoints gated only by
 *     `requireAuth` — the module permission gate already ran at *emit* time, so
 *     a row only exists if this user was allowed to see it.
 *   • A user can NEVER read or mutate another user's notifications (the IDOR
 *     case): every query is scoped to the caller's `userId`, so a guessed id of
 *     someone else's row matches nothing and 404s rather than leaking.
 *   • The bell list and its unread count behave correctly: pagination, the
 *     `unread=only` narrowing, and a badge count that is always the true number
 *     of unread rows regardless of the current list filter.
 *   • Preferences: a partial toggle persists, unknown types are rejected before
 *     any write, and the two non-muteable integrity types can never be disabled.
 *
 * The lazy time-sweep is mocked out so a list read returns exactly the seeded
 * rows (the sweep has its own unit coverage); the delivery bus is mocked too.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { requireAuth, AuthenticationError } from '@/lib/authorization'

import { GET as listNotifications } from '@/app/api/notifications/route'
import { PATCH as markRead } from '@/app/api/notifications/[id]/route'
import { POST as markAllRead } from '@/app/api/notifications/read-all/route'
import {
  GET as getPrefs,
  PATCH as patchPrefs,
} from '@/app/api/notifications/preferences/route'

import { createMemDb, type MemDb, type Doc } from './helpers/mem-mongo'

let mem: MemDb

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => mem.handle),
  getMongoClient: vi.fn(async () => mem.client),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

// Determinism: the list route awaits a lazy sweep; neutralise it here so the
// assertions see only the seeded rows (the sweep is covered separately).
vi.mock('@/lib/notifications/sweep', () => ({
  maybeRunNotificationSweep: vi.fn(async () => undefined),
}))

vi.mock('@/lib/realtime/bus', () => ({
  realtimeBus: { publish: vi.fn(), latestId: vi.fn(() => '0'), since: vi.fn(() => []) },
}))

/* --------------------------------- fixtures -------------------------------- */

// `requireAuth` (globally mocked) resolves to this Founder; it is "the caller".
const ME = new ObjectId('507f1f77bcf86cd799439011')
const OTHER = new ObjectId('507f1f77bcf86cd799439055')

type Json = Record<string, unknown> & {
  success: boolean
  data?: Record<string, unknown>
  error?: { code?: string; message?: string }
}
const readJson = async (res: Response): Promise<Json> => (await res.json()) as Json

const req = (url: string, init?: RequestInit) => new Request(url, init) as never

let n1: ObjectId
let n2: ObjectId
let n3: ObjectId
let otherId: ObjectId

const seedNotifications = (): void => {
  n1 = new ObjectId('600000000000000000000001')
  n2 = new ObjectId('600000000000000000000002')
  n3 = new ObjectId('600000000000000000000003')
  otherId = new ObjectId('6000000000000000000000a1')
  const base = (
    _id: ObjectId,
    userId: ObjectId,
    isRead: boolean,
    createdAt: Date,
    dedupeKey: string
  ): Doc => ({
    _id,
    userId,
    type: 'low_stock',
    dedupeKey,
    title: 'Low stock',
    message: 'A product is low',
    data: { entityType: 'product', entityId: 'p' },
    isRead,
    createdAt,
  })
  mem.db.notifications.push(
    base(n1, ME, false, new Date('2026-05-01T10:00:00Z'), 'a'),
    base(n2, ME, false, new Date('2026-05-02T10:00:00Z'), 'b'),
    base(n3, ME, true, new Date('2026-05-03T10:00:00Z'), 'c'),
    base(otherId, OTHER, false, new Date('2026-05-04T10:00:00Z'), 'd')
  )
}

beforeEach(() => {
  mem = createMemDb()
  seedNotifications()
})

// `docs` is Record<string, unknown>[]; compare ids by string so we never reach
// for driver methods the fake does not type.
const findNotif = (id: ObjectId): Doc | undefined =>
  mem.db.notifications.docs.find((d) => String(d._id) === id.toString())
const findUser = (id: ObjectId): Doc | undefined =>
  mem.db.users.docs.find((d) => String(d._id) === id.toString())
const unreadMine = (): Doc[] =>
  mem.db.notifications.docs.filter(
    (d) => String(d.userId) === ME.toString() && d.isRead === false
  )

/* ----------------------------- 401 on every route -------------------------- */

describe('401 when there is no session', () => {
  const routes: Array<[string, () => Promise<Response>]> = [
    ['GET /api/notifications', () => listNotifications(req('http://localhost/api/notifications'))],
    [
      'PATCH /api/notifications/[id]',
      () =>
        markRead(
          req(`http://localhost/api/notifications/${n1}`, {
            method: 'PATCH',
            body: JSON.stringify({ isRead: true }),
          }),
          { params: Promise.resolve({ id: n1.toString() }) }
        ),
    ],
    ['POST /api/notifications/read-all', () => markAllRead()],
    ['GET /api/notifications/preferences', () => getPrefs()],
    [
      'PATCH /api/notifications/preferences',
      () =>
        patchPrefs(
          req('http://localhost/api/notifications/preferences', {
            method: 'PATCH',
            body: JSON.stringify({ preferences: { low_stock: { enabled: false } } }),
          })
        ),
    ],
  ]

  for (const [name, call] of routes) {
    it(name, async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new AuthenticationError())
      const res = await call()
      expect(res.status).toBe(401)
      expect((await readJson(res)).error?.code).toBe('UNAUTHENTICATED')
    })
  }
})

/* ------------------------------- list (bell) ------------------------------- */

describe('GET /api/notifications', () => {
  it('returns ONLY the caller\'s rows and never another user\'s (IDOR)', async () => {
    const res = await listNotifications(req('http://localhost/api/notifications'))
    expect(res.status).toBe(200)
    const body = await readJson(res)
    const items = body.data!.notifications as Array<{ _id: string }>
    expect(items).toHaveLength(3) // ME has 3; OTHER's row is never present
    expect(items.map((i) => i._id)).not.toContain(otherId.toString())
  })

  it('reports the true unread count and sorts newest-first', async () => {
    const body = await readJson(await listNotifications(req('http://localhost/api/notifications')))
    expect(body.data!.unreadCount).toBe(2)
    const items = body.data!.notifications as Array<{ _id: string }>
    expect(items[0]._id).toBe(n3.toString()) // newest createdAt, even though it is read
  })

  it('narrows to unread with unread=only but keeps the badge count true', async () => {
    const body = await readJson(
      await listNotifications(req('http://localhost/api/notifications?unread=only'))
    )
    const items = body.data!.notifications as Array<{ _id: string }>
    expect(items).toHaveLength(2) // n1, n2 (n3 is read)
    expect(items.map((i) => i._id).sort()).toEqual([n1.toString(), n2.toString()].sort())
    expect(body.data!.unreadCount).toBe(2)
  })

  it('paginates with limit and reports hasMore', async () => {
    const body = await readJson(
      await listNotifications(req('http://localhost/api/notifications?limit=2'))
    )
    const items = body.data!.notifications as Array<{ _id: string }>
    expect(items).toHaveLength(2)
    expect(body.data!.pagination).toMatchObject({ page: 1, limit: 2, total: 3, hasMore: true })
  })
})

/* ------------------------------ mark one read ------------------------------ */

describe('PATCH /api/notifications/[id]', () => {
  it('marks the caller\'s own notification read and stamps readAt', async () => {
    const res = await markRead(
      req(`http://localhost/api/notifications/${n1}`, {
        method: 'PATCH',
        body: JSON.stringify({ isRead: true }),
      }),
      { params: Promise.resolve({ id: n1.toString() }) }
    )
    expect(res.status).toBe(200)
    const row = findNotif(n1)!
    expect(row.isRead).toBe(true)
    expect(row.readAt).toBeInstanceOf(Date)
  })

  it('404s when the id belongs to ANOTHER user — cannot mutate or probe it', async () => {
    const res = await markRead(
      req(`http://localhost/api/notifications/${otherId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isRead: true }),
      }),
      { params: Promise.resolve({ id: otherId.toString() }) }
    )
    expect(res.status).toBe(404)
    // The other user's row is untouched.
    expect(findNotif(otherId)!.isRead).toBe(false)
  })

  it('rejects a malformed body and an invalid id with 400', async () => {
    const badBody = await markRead(
      req(`http://localhost/api/notifications/${n1}`, {
        method: 'PATCH',
        body: JSON.stringify({ isRead: 'yes' }),
      }),
      { params: Promise.resolve({ id: n1.toString() }) }
    )
    expect(badBody.status).toBe(400)

    const badId = await markRead(
      req('http://localhost/api/notifications/not-an-id', {
        method: 'PATCH',
        body: JSON.stringify({ isRead: true }),
      }),
      { params: Promise.resolve({ id: 'not-an-id' }) }
    )
    expect(badId.status).toBe(400)
  })
})

/* ------------------------------ mark all read ------------------------------ */

describe('POST /api/notifications/read-all', () => {
  it('clears only the caller\'s unread rows, leaving another user\'s intact', async () => {
    const res = await markAllRead()
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body.data!.marked).toBe(2) // n1, n2 (n3 already read)
    expect(unreadMine()).toHaveLength(0)
    // OTHER is untouched by this caller's bulk action.
    expect(findNotif(otherId)!.isRead).toBe(false)
  })
})

/* ------------------------------- preferences ------------------------------- */

describe('GET /api/notifications/preferences', () => {
  it('returns the resolved map with non-muteable types forced on', async () => {
    mem.db.users.push({ _id: ME, notificationPrefs: { low_stock: { enabled: false } } })
    const body = await readJson(await getPrefs())
    const prefs = body.data!.preferences as Record<string, { enabled: boolean }>
    expect(prefs.low_stock.enabled).toBe(false)
    expect(prefs.task_overdue.enabled).toBe(true) // default-on for unset types
    expect(prefs.sync_failure.enabled).toBe(true) // non-muteable
    expect(prefs.sync_conflict.enabled).toBe(true)
  })
})

describe('PATCH /api/notifications/preferences', () => {
  it('persists a muteable toggle and refuses to disable a non-muteable type', async () => {
    mem.db.users.push({ _id: ME, notificationPrefs: {} })
    const res = await patchPrefs(
      req('http://localhost/api/notifications/preferences', {
        method: 'PATCH',
        body: JSON.stringify({
          preferences: { low_stock: { enabled: false }, sync_failure: { enabled: false } },
        }),
      })
    )
    expect(res.status).toBe(200)
    const prefs = (await readJson(res)).data!.preferences as Record<string, { enabled: boolean }>
    expect(prefs.low_stock.enabled).toBe(false)
    expect(prefs.sync_failure.enabled).toBe(true) // coerced: cannot be muted

    // Persisted to the user's own document.
    const stored = findUser(ME)!
    expect((stored.notificationPrefs as Doc).low_stock).toEqual({ enabled: false })
  })

  it('rejects an unknown type and a non-boolean enabled before writing anything', async () => {
    mem.db.users.push({ _id: ME, notificationPrefs: {} })
    const unknown = await patchPrefs(
      req('http://localhost/api/notifications/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferences: { bogus_type: { enabled: true } } }),
      })
    )
    expect(unknown.status).toBe(400)

    const notBool = await patchPrefs(
      req('http://localhost/api/notifications/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferences: { low_stock: { enabled: 'false' } } }),
      })
    )
    expect(notBool.status).toBe(400)

    const missing = await patchPrefs(
      req('http://localhost/api/notifications/preferences', {
        method: 'PATCH',
        body: JSON.stringify({}),
      })
    )
    expect(missing.status).toBe(400)
  })
})
