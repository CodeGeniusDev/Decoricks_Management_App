/**
 * Security coverage for /api/push/subscription (Phase 10 manual review).
 *
 * The stored endpoint is not an inert string: `deliverPush` POSTS to it on every
 * future notification, so whatever an authenticated user can persist here is an
 * address this server will keep sending requests to. Two properties are locked:
 *
 *   1. Only a real browser push endpoint is accepted — https, no credentials,
 *      no port, a dotted public-looking hostname. A `http://`, `localhost`, an
 *      IP literal (loopback, private, or the link-local metadata address) or a
 *      dotless name is rejected with 400 before anything is written.
 *   2. One account can never re-point another account's subscription. `endpoint`
 *      carries a unique index, so an upsert keyed on the endpoint alone would
 *      hand another user's row to the caller's keys — the victim's device then
 *      gets payloads it cannot decrypt and quietly stops notifying.
 *
 * Also locked: the two client keys are bounded, and DELETE is owner-scoped.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { requireAuth, AuthenticationError } from '@/lib/authorization'

import {
  PUT as putSubscription,
  DELETE as deleteSubscription,
} from '@/app/api/push/subscription/route'
import { createMemDb, type MemDb, type Doc } from './helpers/mem-mongo'

let mem: MemDb

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => mem.handle),
  getMongoClient: vi.fn(async () => mem.client),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

/* --------------------------------- fixtures -------------------------------- */

// `requireAuth` (globally mocked) resolves to this Founder; it is "the caller".
const ME = new ObjectId('507f1f77bcf86cd799439011')
const OTHER = new ObjectId('507f1f77bcf86cd799439055')

const GOOD_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123'
const P256DH = 'BOnqk0IYkJwVDb9r7lHlKQz0mrZ9XCM0cqJ2Kd3QrEbZ3oW7vQm1sZb9R7Y4Xn2JcV5dK0P8wQeRtTuY6w'
const AUTH_KEY = 't7-2x8QbYm5nK0pR'

const put = (body: unknown) =>
  putSubscription(
    new Request('http://localhost/api/push/subscription', {
      method: 'PUT',
      body: JSON.stringify(body),
    }) as never
  )

const del = (body: unknown) =>
  deleteSubscription(
    new Request('http://localhost/api/push/subscription', {
      method: 'DELETE',
      body: JSON.stringify(body),
    }) as never
  )

const rows = (): Doc[] => mem.db.pushSubscriptions.docs
const rowFor = (endpoint: string): Doc | undefined => rows().find((d) => d.endpoint === endpoint)

/** A valid subscription body, with any field overridable. */
const sub = (over: Partial<Doc> = {}): Doc => ({
  endpoint: GOOD_ENDPOINT,
  keys: { p256dh: P256DH, auth: AUTH_KEY },
  ...over,
})

beforeEach(() => {
  mem = createMemDb()
})

/* ------------------------- 1. endpoint shape enforced ---------------------- */

describe('PUT /api/push/accepts only a real push endpoint', () => {
  it('stores a genuine https provider endpoint', async () => {
    const res = await put(sub())
    expect(res.status).toBe(200)
    const row = rowFor(GOOD_ENDPOINT)
    expect(row).toBeDefined()
    expect(String(row!.userId)).toBe(ME.toString())
    expect((row!.keys as Doc).p256dh).toBe(P256DH)
  })

  // Every one of these is an address the server would otherwise keep POSTing to.
  const rejected = [
    'http://fcm.googleapis.com/fcm/send/abc', // plaintext
    'https://127.0.0.1:8080/push', // loopback
    'https://169.254.169.254/latest/meta-data/', // cloud metadata (link-local)
    'https://10.0.0.5/push', // private range
    'https://192.168.1.1/admin', // private range
    'https://[::1]:9000/push', // IPv6 loopback literal
    'https://localhost/push', // dotless
    'https://metadata/push', // dotless intranet-style name
    'https://push.internal.local/push', // .local
    'https://user:pass@attacker.example/push', // credentials in the URL
    'https://attacker.example:8080/push', // non-443 port
    'ftp://attacker.example/push', // not http(s) at all
    'javascript:alert(1)', // not a URL the fetch layer should ever see
    '', // empty
  ]

  for (const endpoint of rejected) {
    it(`rejects ${endpoint || '(empty)'} and writes nothing`, async () => {
      const res = await put(sub({ endpoint }))
      expect(res.status).toBe(400)
      expect((await res.json()).error?.code).toBe('VALIDATION_ERROR')
      expect(rows()).toHaveLength(0)
    })
  }

  it('rejects a missing or malformed keys object', async () => {
    expect((await put({ endpoint: GOOD_ENDPOINT })).status).toBe(400)
    expect((await put(sub({ keys: { p256dh: P256DH } }))).status).toBe(400)
    expect(
      (await put(sub({ keys: { p256dh: P256DH, auth: AUTH_KEY }, endpoint: 42 }))).status
    ).toBe(400)
    expect(rows()).toHaveLength(0)
  })

  it('bounds the two client keys instead of storing an arbitrary blob', async () => {
    const huge = 'A'.repeat(5000)
    expect((await put(sub({ keys: { p256dh: huge, auth: AUTH_KEY } }))).status).toBe(400)
    expect((await put(sub({ keys: { p256dh: P256DH, auth: 'not base64 at all!!' } }))).status).toBe(
      400
    )
    expect(
      (await put(sub({ endpoint: `https://push.example.com/${'x'.repeat(3000)}` }))).status
    ).toBe(400)
    expect(rows()).toHaveLength(0)
  })
})

/* --------------------------- 2. no cross-user hijack ----------------------- */

describe('PUT cannot re-point another account subscription', () => {
  const theirs = 'https://updates.push.services.mozilla.com/wpush/v2/theirs'

  beforeEach(() => {
    mem.db.pushSubscriptions.push({
      _id: new ObjectId(),
      userId: OTHER,
      endpoint: theirs,
      keys: { p256dh: 'theirP256', auth: 'theirAuth' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    })
  })

  it('400s, and the other user row keeps its owner and its keys', async () => {
    const res = await put(sub({ endpoint: theirs }))
    expect(res.status).toBe(400)
    const row = rowFor(theirs)!
    expect(String(row.userId)).toBe(OTHER.toString())
    expect((row.keys as Doc).p256dh).toBe('theirP256')
    // No second row was created for the caller either.
    expect(rows().filter((d) => String(d.userId) === ME.toString())).toHaveLength(0)
  })

  it("still updates the caller's own row in place, without duplicating it", async () => {
    const mine = 'https://notifications.google.com/wpush/v2/mine'
    expect((await put(sub({ endpoint: mine }))).status).toBe(200)
    expect(
      (await put(sub({ endpoint: mine, keys: { p256dh: 'rotated', auth: AUTH_KEY } }))).status
    ).toBe(200)
    const owned = rows().filter((d) => String(d.userId) === ME.toString() && d.endpoint === mine)
    expect(owned).toHaveLength(1)
    expect((owned[0].keys as Doc).p256dh).toBe('rotated')
  })

  it('401s before validating anything when there is no session', async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(new AuthenticationError())
    const res = await put(sub())
    expect(res.status).toBe(401)
    expect(rows()).toHaveLength(1) // the other user's row is untouched
  })
})

/* ------------------------------ 3. DELETE scope ---------------------------- */

describe('DELETE removes only the caller own subscription', () => {
  const mine = 'https://fcm.googleapis.com/fcm/send/mine'
  const theirs = 'https://fcm.googleapis.com/fcm/send/theirs'

  beforeEach(() => {
    for (const [userId, endpoint] of [
      [ME, mine],
      [OTHER, theirs],
    ] as const) {
      mem.db.pushSubscriptions.push({
        _id: new ObjectId(),
        userId,
        endpoint,
        keys: { p256dh: P256DH, auth: AUTH_KEY },
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      })
    }
  })

  it('cannot unsubscribe another account by guessing their endpoint', async () => {
    const res = await del({ endpoint: theirs })
    expect(res.status).toBe(200)
    expect((await res.json()).data!.removed).toBe(false)
    expect(rowFor(theirs)).toBeDefined()
  })

  it('removes its own', async () => {
    const res = await del({ endpoint: mine })
    expect((await res.json()).data!.removed).toBe(true)
    expect(rowFor(mine)).toBeUndefined()
    expect(rowFor(theirs)).toBeDefined()
  })
})
