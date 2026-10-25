/**
 * Phase 10 — Web Push configuration tests (no database, no browser).
 *
 * These lock the two failure modes that made a deployment-wide push problem
 * invisible for the owner:
 *
 *   • THE KEY THE BROWSER IS TOLD MUST BE THE KEY THE SERVER SIGNS WITH.
 *     `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is inlined into the SERVER bundle at build
 *     time, so it is frozen until the next build while `VAPID_PRIVATE_KEY` is
 *     read at runtime. A rotation with only a restart therefore pairs a new
 *     private key with an old public key, every send is rejected by the push
 *     service, and nothing was ever logged. `getVapidPublicKey` now DERIVES the
 *     public point from the runtime private key, so the two cannot disagree.
 *   • A FAILED SEND MUST BE VISIBLE. Only 410/404 were handled (by deleting the
 *     subscription); every other error — VAPID 401, a bad subject, a transport
 *     failure — was swallowed. Delivery is still best-effort and never throws;
 *     it just logs now.
 *
 * `web-push` itself is mocked: the subject here is how the module CONFIGURES and
 * reacts, not the real encryption transport (which the E2E run verifies).
 */
import { createECDH } from 'node:crypto'
import { ObjectId } from 'mongodb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from 'mongodb'
import { createMemDb, type Doc, type MemDb } from './helpers/mem-mongo'

const mocks = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}))

vi.mock('web-push', () => ({
  default: { setVapidDetails: mocks.setVapidDetails, sendNotification: mocks.sendNotification },
}))

// The real `getEnv` caches its parse for the whole process, which would freeze
// the first test's keys for every later one. Push only ever needs two fields.
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
  }),
}))

const SUBJECT = 'mailto:owner@example.com'

/** Push reads its config once per module instance, so each test imports afresh. */
const loadPush = async () => {
  vi.resetModules()
  return await import('@/lib/notifications/push')
}

const generatePair = () => {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: ecdh.getPublicKey('base64url'),
    privateKey: ecdh.getPrivateKey('base64url'),
  }
}

let mem: MemDb
let errors: string[]
let warns: string[]

beforeEach(() => {
  mem = createMemDb()
  mocks.setVapidDetails.mockReset()
  mocks.sendNotification.mockReset()
  errors = []
  warns = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.join(' '))
  })
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.join(' '))
  })
  process.env.VAPID_SUBJECT = SUBJECT
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.VAPID_PRIVATE_KEY
  delete process.env.VAPID_SUBJECT
  delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
})

describe('VAPID public key resolution', () => {
  it('returns exactly the public key `web-push` generated for the private key', async () => {
    // The real generator, not a lookalike: this is what the owner pastes into Render.
    const webpush = await vi.importActual<{
      generateVAPIDKeys: () => { publicKey: string; privateKey: string }
    }>('web-push')
    const pair = webpush.generateVAPIDKeys()
    process.env.VAPID_PRIVATE_KEY = pair.privateKey
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = pair.publicKey

    const push = await loadPush()
    await expect(push.getVapidPublicKey()).resolves.toBe(pair.publicKey)
  })

  it('derives the key even when the build-time variable is absent entirely', async () => {
    const pair = generatePair()
    process.env.VAPID_PRIVATE_KEY = pair.privateKey
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY

    const push = await loadPush()
    await expect(push.getVapidPublicKey()).resolves.toBe(pair.publicKey)
    expect(mocks.setVapidDetails).toHaveBeenCalledWith(SUBJECT, pair.publicKey, pair.privateKey)
  })

  it('prefers the derived key over a stale build-time key and says so', async () => {
    const current = generatePair()
    const stale = generatePair()
    process.env.VAPID_PRIVATE_KEY = current.privateKey
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = stale.publicKey

    const push = await loadPush()
    await expect(push.getVapidPublicKey()).resolves.toBe(current.publicKey)

    // The signing library is configured with the pair that actually matches.
    expect(mocks.setVapidDetails).toHaveBeenCalledWith(
      SUBJECT,
      current.publicKey,
      current.privateKey
    )
    expect(errors.join(' ')).toContain('VAPID drift')
  })

  it('is disabled when the private key or the subject is missing', async () => {
    delete process.env.VAPID_PRIVATE_KEY
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = generatePair().publicKey

    const push = await loadPush()
    await expect(push.getVapidPublicKey()).resolves.toBeNull()
    expect(mocks.setVapidDetails).not.toHaveBeenCalled()
  })

  it('falls back to the build-time key when the private key cannot be expanded', async () => {
    // The realistic mistake: pasting an OpenSSL PEM block instead of the base64url
    // scalar `web-push` prints. It is far too long to be a P-256 scalar, so the
    // derivation refuses and the baked-in public key is used unchanged — push
    // still configures instead of silently switching off.
    process.env.VAPID_PRIVATE_KEY = Buffer.from(
      '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIlmB0kStaleFakePemBody\n-----END EC PRIVATE KEY-----\n'
    ).toString('base64url')
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = generatePair().publicKey

    const push = await loadPush()
    await expect(push.getVapidPublicKey()).resolves.toBe(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
    expect(mocks.setVapidDetails).toHaveBeenCalledWith(
      SUBJECT,
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    )
  })
})

describe('deliverPush failure visibility', () => {
  const userId = new ObjectId('507f1f77bcf86cd799439010')

  const seedSubscription = () => {
    const doc: Doc = {
      _id: new ObjectId(),
      userId,
      endpoint: 'https://push.example.com/p/abc123',
      keys: { p256dh: 'BNq0YcH6mTVR6mZC0hVG9uZHJvbQ', auth: 'threebyteauthvalue' },
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }
    mem.db.pushSubscriptions.push(doc)
    return doc
  }

  const deliver = async (push: typeof import('@/lib/notifications/push')) =>
    push.deliverPush(mem.handle as unknown as Db, userId.toString(), {
      title: 'Task overdue',
      body: 'Order #12 is late',
      notificationId: 'n1',
      type: 'task_overdue',
    })

  beforeEach(() => {
    process.env.VAPID_PRIVATE_KEY = generatePair().privateKey
  })

  it('logs a rejected send and keeps the subscription for the next try', async () => {
    const stored = seedSubscription()
    mocks.sendNotification.mockRejectedValue(
      Object.assign(new Error('Web Push messages require a valid VAPID authorization header'), {
        statusCode: 401,
      })
    )

    const push = await loadPush()
    await expect(deliver(push)).resolves.toBeUndefined()

    expect(errors.join(' ')).toContain('send failed')
    expect(errors.join(' ')).toContain('401')
    expect(mem.db.pushSubscriptions.docs.map((d) => d._id)).toEqual([stored._id])
    // The bearer token inside an endpoint must never reach a log.
    expect(errors.join(' ') + warns.join(' ')).not.toContain('abc123')
  })

  it('removes an expired subscription and does not raise an error for it', async () => {
    seedSubscription()
    mocks.sendNotification.mockRejectedValue(Object.assign(new Error('Gone'), { statusCode: 410 }))

    const push = await loadPush()
    await deliver(push)

    expect(mem.db.pushSubscriptions.docs).toHaveLength(0)
    expect(errors).toHaveLength(0)
  })

  it('stays silent when the deployment has no push keys at all', async () => {
    delete process.env.VAPID_PRIVATE_KEY
    seedSubscription()

    const push = await loadPush()
    await deliver(push)

    expect(mocks.sendNotification).not.toHaveBeenCalled()
    expect(mem.db.pushSubscriptions.docs).toHaveLength(1)
  })

  it('passes the payload and the stored keys to the transport on success', async () => {
    seedSubscription()
    mocks.sendNotification.mockResolvedValue({})

    const push = await loadPush()
    await deliver(push)

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1)
    const [target, data] = mocks.sendNotification.mock.calls[0]
    expect(target.endpoint).toBe('https://push.example.com/p/abc123')
    expect(data).toContain('Task overdue')
  })
})
