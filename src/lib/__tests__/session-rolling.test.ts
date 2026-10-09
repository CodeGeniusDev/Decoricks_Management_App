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

import { __resetEnvForTests } from '@/lib/env'
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

const matches = (doc: Record<string, any>, filter: Record<string, any>): boolean =>
  Object.entries(filter).every(([key, cond]) => {
    const value = doc[key]
    if (cond && typeof cond === 'object' && !(cond instanceof ObjectId)) {
      if ('$ne' in cond) return String(value) !== String((cond as any).$ne)
    }
    if (cond instanceof ObjectId) return String(value) === String(cond)
    return value === cond
  })

const makeCollection = (getDocs: () => Record<string, any>[]) => ({
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
  return {
    data,
    collection(name: string) {
      data[name] ??= []
      return makeCollection(() => data[name])
    },
  } as any
}

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

const ageSession = async (token: string, idleMs: number, ttlMs = 7 * 24 * 60 * 60 * 1000) => {
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
  process.env.SESSION_TTL_MINUTES = '10080'
  process.env.SESSION_SLIDE_INTERVAL_SECONDS = '60'
  __resetEnvForTests()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('7-day rolling session lifecycle', () => {
  it('issues a session whose lifetime is the full 7-day window', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)

    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('restarts the window on the server and the cookie on activity', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)
    await ageSession(session.tokenHash, 3 * 24 * 60 * 60 * 1000)

    h.headers = {}
    const auth = await getAuthenticatedUser(h.db, session.tokenHash)

    expect(auth).not.toBeNull()
    const expected = Date.now() + 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(auth!.session.expiresAt.getTime() - expected)).toBeLessThan(5000)

    const persisted = await sessions().findOne({ tokenHash: hashToken(session.tokenHash) })
    expect(Math.abs(persisted.expiresAt.getTime() - expected)).toBeLessThan(5000)
    expect(h.cookieOptions[SESSION_COOKIE].maxAge).toBe(7 * 24 * 60 * 60)
  })

  it('rejects and deletes a session idle for longer than the window', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)
    await ageSession(session.tokenHash, 8 * 24 * 60 * 60 * 1000)

    const auth = await getAuthenticatedUser(h.db, session.tokenHash)

    expect(auth).toBeNull()
    expect(await sessions().findOne({ tokenHash: hashToken(session.tokenHash) })).toBeNull()
  })

  it('does not renew the window for background polling', async () => {
    const user = seedUser()
    const session = await createSession(h.db, user as any)
    const stored = await ageSession(session.tokenHash, 3 * 24 * 60 * 60 * 1000)
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
    await ageSession(first.tokenHash, 3 * 24 * 60 * 60 * 1000)
    const secondBefore = await sessions().findOne({ tokenHash: hashToken(second.tokenHash) })
    const secondIdle = secondBefore.lastActivityAt.getTime()

    h.headers = {}
    await getAuthenticatedUser(h.db, first.tokenHash)

    const firstAfter = await sessions().findOne({ tokenHash: hashToken(first.tokenHash) })
    const secondAfter = await sessions().findOne({ tokenHash: hashToken(second.tokenHash) })
    expect(firstAfter.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000)
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
