import { ObjectId } from 'mongodb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The Mongo driver and Next's request-scoped `cookies()`/`headers()` are both
 * mocked so these tests are deterministic and offline. Time is controlled by
 * writing past `lastActivityAt`/`expiresAt` values straight into the fake
 * collection rather than with fake timers, which would break the driver.
 */
const h = vi.hoisted(() => ({
  db: null as any,
  cookies: {} as Record<string, string>,
  cookieOptions: {} as Record<string, any>,
  headers: {} as Record<string, string>,
}))

vi.mock('@/lib/mongodb', () => ({
  getDatabase: async () => h.db,
  withMongoRetry: async (operation: () => Promise<unknown>) => operation(),
  isTransientMongoError: () => false,
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name in h.cookies ? { name, value: h.cookies[name] } : undefined),
    set: (name: string, value: string, options?: unknown) => {
      h.cookies[name] = value
      h.cookieOptions[name] = options
    },
  }),
  headers: async () => ({
    get: (name: string) => h.headers[name.toLowerCase()] ?? null,
  }),
}))

import { __resetEnvForTests, getEnv } from '@/lib/env'
import {
  SESSION_BACKGROUND_HEADER,
  SESSION_COOKIE,
  createSession,
  getAuthenticatedUser,
  hashToken,
  revokeSession,
  writeSessionCookies,
} from '@/lib/auth/session'

type Doc = Record<string, any>

const DAY_MS = 24 * 60 * 60 * 1000
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
/** Policy decision (Phase 10 §4a): 12-hour sliding inactivity window. */
const TWELVE_HOURS = 12 * 60 * 60 * 1000

const matches = (doc: Record<string, any>, filter: Record<string, any>): boolean =>
  Object.entries(filter).every(([key, cond]) => {
    const value = doc[key]
    if (cond && typeof cond === 'object' && !(cond instanceof ObjectId)) {
      if ('$ne' in cond) return String(value) !== String((cond as any).$ne)
    }
    if (cond instanceof ObjectId) return String(value) === String(cond)
    return value === cond
  })

const makeCollection = (getName: () => string, getDocs: () => Record<string, any>[]) => ({
  // The real driver exposes the collection name, and `getAuthenticatedUser`
  // reads it to build the `$lookup` into `users`.
  get collectionName() {
    return getName()
  },
  // Only the stages `getAuthenticatedUser` actually sends are implemented: the
  // fake would rather fail loudly on an unexpected pipeline than silently
  // answer a query the production code no longer makes.
  aggregate(pipeline: Record<string, any>[]) {
    let rows = [...getDocs()]
    for (const stage of pipeline) {
      if ('$match' in stage) rows = rows.filter((doc) => matches(doc, stage.$match))
      else if ('$limit' in stage) rows = rows.slice(0, stage.$limit)
      else if ('$lookup' in stage) {
        const { from, localField, foreignField, as } = stage.$lookup
        const peers: Record<string, any>[] = lookupTable[from] ?? []
        rows = rows.map((doc) => ({
          ...doc,
          [as]: peers.filter((peer) => String(peer[foreignField]) === String(doc[localField])),
        }))
      } else throw new Error(`unhandled aggregate stage: ${Object.keys(stage).join(',')}`)
    }
    return { toArray: async () => rows }
  },
  async insertOne(doc: Record<string, any>) {
    const withId = doc._id ? doc : { ...doc, _id: new ObjectId() }
    getDocs().push(withId)
    return { insertedId: withId._id }
  },
  async findOne(filter: Record<string, any>) {
    return getDocs().find((doc) => matches(doc, filter)) ?? null
  },
  async updateOne(filter: Record<string, any>, update: Record<string, any>) {
    const doc = getDocs().find((candidate) => matches(candidate, filter))
    if (!doc) return { matchedCount: 0, modifiedCount: 0 }
    Object.assign(doc, update.$set)
    return { matchedCount: 1, modifiedCount: 1 }
  },
  async deleteOne(filter: Record<string, any>) {
    const docs = getDocs()
    const index = docs.findIndex((doc) => matches(doc, filter))
    if (index === -1) return { deletedCount: 0 }
    docs.splice(index, 1)
    return { deletedCount: 1 }
  },
  async deleteMany(filter: Record<string, any>) {
    const docs = getDocs()
    const kept = docs.filter((doc) => !matches(doc, filter))
    const deletedCount = docs.length - kept.length
    docs.length = 0
    docs.push(...kept)
    return { deletedCount }
  },
})

const createFakeDb = () => {
  const data: Record<string, Record<string, any>[]> = { users: [], sessions: [] }
  // `$lookup` resolves the joined collection by name, so the fake pipelines read
  // from the same store the rest of the harness writes to.
  lookupTable = data
  return {
    data,
    collection(name: string) {
      data[name] ??= []
      return makeCollection(
        () => name,
        () => data[name]
      )
    },
  } as any
}

let lookupTable: Record<string, Record<string, any>[]> = {}

const sessions = () => h.db.collection('sessions')

const seedUser = (overrides: Record<string, any> = {}) => {
  const user = {
    _id: new ObjectId(),
    email: 'founder@decoricks.com',
    role: 'founder',
    isActive: true,
    sessionVersion: 1,
    ...overrides,
  }
  h.db.data.users.push(user)
  return user
}

const ageSession = async (token: string, idleMs: number, ttlMs = TWELVE_HOURS) => {
  const stored = await sessions().findOne({ tokenHash: hashToken(token) })
  stored.lastActivityAt = new Date(Date.now() - idleMs)
  stored.expiresAt = new Date(Date.now() - idleMs + ttlMs)
  return stored
}

beforeEach(() => {
  h.db = createFakeDb()
  h.cookies = {}
  h.cookieOptions = {}
  h.headers = {}

  process.env.MONGODB_URI = 'mongodb://localhost:27017/decoricks_test'
  process.env.SESSION_SECRET = 'test-secret-test-secret-1234'
  process.env.SESSION_TTL_MINUTES = '720'
  process.env.SESSION_MAX_LIFETIME_MINUTES = '10080'
  process.env.SESSION_SLIDE_INTERVAL_SECONDS = '60'
  __resetEnvForTests()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('rolling session lifecycle — 12-hour sliding window, 7-day absolute cap', () => {
  it('issues a session whose lifetime is the full 12-hour sliding window', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)

    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(TWELVE_HOURS)
  })

  it('restarts the window on the server and the cookie on activity', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)
    await ageSession(session.tokenHash, 3 * 60 * 60 * 1000)

    h.headers = {}
    const auth = await getAuthenticatedUser(h.db, session.tokenHash)

    expect(auth).not.toBeNull()
    const expected = Date.now() + TWELVE_HOURS
    expect(Math.abs(auth!.session.expiresAt.getTime() - expected)).toBeLessThan(5000)

    const persisted = await sessions().findOne({ tokenHash: hashToken(session.tokenHash) })
    expect(Math.abs(persisted.expiresAt.getTime() - expected)).toBeLessThan(5000)
    expect(h.cookieOptions[SESSION_COOKIE].maxAge).toBe(12 * 60 * 60)
  })

  it('rejects and deletes a session idle for longer than the window', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)
    await ageSession(session.tokenHash, 13 * 60 * 60 * 1000)

    const auth = await getAuthenticatedUser(h.db, session.tokenHash)

    expect(auth).toBeNull()
    expect(await sessions().findOne({ tokenHash: hashToken(session.tokenHash) })).toBeNull()
  })

  it('does not renew the window for background polling', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)
    const stored = await ageSession(session.tokenHash, 3 * 60 * 60 * 1000)
    const originalExpiry = stored.expiresAt.getTime()

    h.headers = { 'x-session-background': '1' }
    const auth = await getAuthenticatedUser(h.db, session.tokenHash)

    expect(auth).not.toBeNull()
    const persisted = await sessions().findOne({ tokenHash: hashToken(session.tokenHash) })
    expect(persisted.expiresAt.getTime()).toBe(originalExpiry)
    expect(h.cookies[SESSION_COOKIE]).toBeUndefined()
  })

  it('throttles a burst of activity into no extra writes', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)
    const before = await sessions().findOne({ tokenHash: hashToken(session.tokenHash) })

    h.headers = {}
    await getAuthenticatedUser(h.db, session.tokenHash)

    const after = await sessions().findOne({ tokenHash: hashToken(session.tokenHash) })
    expect(after.lastActivityAt.getTime()).toBe(before.lastActivityAt.getTime())
    expect(h.cookies[SESSION_COOKIE]).toBeUndefined()
  })

  it('keeps independent sessions independent', async () => {
    const user = seedUser()
    const first = await createSession(h.db, user as any)
    const second = await createSession(h.db, user as any)
    await ageSession(first.tokenHash, 3 * 60 * 60 * 1000)
    const secondBefore = await sessions().findOne({ tokenHash: hashToken(second.tokenHash) })
    const secondIdle = secondBefore.lastActivityAt.getTime()

    h.headers = {}
    await getAuthenticatedUser(h.db, first.tokenHash)

    const firstAfter = await sessions().findOne({ tokenHash: hashToken(first.tokenHash) })
    const secondAfter = await sessions().findOne({ tokenHash: hashToken(second.tokenHash) })
    expect(firstAfter.expiresAt.getTime()).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000)
    expect(secondAfter.lastActivityAt.getTime()).toBe(secondIdle)
  })

  it('invalidates a session immediately on logout', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)

    await revokeSession(h.db, session.tokenHash)

    expect(await getAuthenticatedUser(h.db, session.tokenHash)).toBeNull()
  })

  it('invalidates sessions when the user is deactivated or their version is bumped', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)

    user.isActive = false
    expect(await getAuthenticatedUser(h.db, session.tokenHash)).toBeNull()

    user.isActive = true
    user.sessionVersion = 2
    expect(await getAuthenticatedUser(h.db, session.tokenHash)).toBeNull()
  })
})

/**
 * Policy decision (Phase 10 §4a): the sliding window is capped by an absolute
 * 7-day lifetime measured from session creation. These tests prove the cap is
 * real — a session that keeps sliding still dies, and it dies *because* the
 * absolute bound was reached, not because the sliding window happened to lapse.
 */
describe('absolute session lifetime cap', () => {
  /**
   * Backdates the session so it looks like it was created `ageMs` ago.
   *
   * `lastActivityAt` is set 5 minutes in the past — far enough that the
   * 60-second slide throttle lets a slide happen (so the cookie is re-issued),
   * but far short of the 12-hour window, so the session is not idle-expired.
   */
  const backdateSession = async (token: string, ageMs: number) => {
    const stored = await sessions().findOne({ tokenHash: hashToken(token) })
    const createdAt = new Date(Date.now() - ageMs)
    stored.createdAt = createdAt
    stored.lastActivityAt = new Date(Date.now() - 5 * 60 * 1000)
    stored.expiresAt = new Date(Date.now() + TWELVE_HOURS)
    return stored
  }

  it('kills a session that has slid past the absolute 7-day cap', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)
    // Created 8 days ago, but kept sliding — so its sliding expiry is still in
    // the future. Only the absolute cap can end it.
    await backdateSession(session.tokenHash, 8 * DAY_MS)

    h.headers = {}
    const auth = await getAuthenticatedUser(h.db, session.tokenHash)

    expect(auth).toBeNull()
    expect(await sessions().findOne({ tokenHash: hashToken(session.tokenHash) })).toBeNull()
  })

  it('keeps a session alive just inside the absolute cap', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)
    await backdateSession(session.tokenHash, 6 * DAY_MS)

    h.headers = {}
    const auth = await getAuthenticatedUser(h.db, session.tokenHash)

    expect(auth).not.toBeNull()
    // The slide must not push the deadline past the absolute cap either.
    expect(auth!.session.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + TWELVE_HOURS + 1000
    )
    expect(auth!.session.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 1 * DAY_MS + 1000
    )
  })

  it('caps the browser cookie at the absolute maximum, not just the sliding window', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)
    // 6 days 23 hours old: one hour of absolute lifetime is left, but the
    // 12-hour sliding window would still hand out 12 hours. The cookie must
    // take the smaller of the two — one hour — or the browser would keep
    // presenting a token the server is about to reject.
    await backdateSession(session.tokenHash, 6 * DAY_MS + 23 * 60 * 60 * 1000)

    h.headers = {}
    await getAuthenticatedUser(h.db, session.tokenHash)

    const maxAge = h.cookieOptions[SESSION_COOKIE].maxAge
    // One hour, give or take the milliseconds spent between backdating the
    // session and the cookie being re-issued.
    expect(Math.abs(maxAge - 60 * 60)).toBeLessThanOrEqual(5)
    expect(maxAge).toBeLessThan(12 * 60 * 60)
  })

  it('refuses to start when the absolute cap is configured below the sliding window', async () => {
    process.env.SESSION_TTL_MINUTES = '720'
    process.env.SESSION_MAX_LIFETIME_MINUTES = '60'
    __resetEnvForTests()

    expect(() => getEnv()).toThrow(/SESSION_MAX_LIFETIME_MINUTES/)
  })
})
