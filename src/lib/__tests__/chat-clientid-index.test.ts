/**
 * Chat `clientId` idempotency index — real-MongoDB integration test.
 *
 * The hand-rolled `mem-mongo` fake cannot be trusted here: a compound SPARSE
 * index and a compound PARTIAL index behave differently on documents that carry
 * SOME of the key fields, and that difference is the entire bug. So this runs
 * against a hermetic `mongodb-memory-server` — a real mongod — and proves:
 *
 *   1. the shipped `{ channelId, clientId }` unique+SPARSE index genuinely
 *      rejects two legacy (clientId-less) messages in one channel (the E11000
 *      the operator saw), and
 *   2. the replacement unique+PARTIAL index does NOT, while still collapsing a
 *      repeated `clientId` (dedup preserved), and
 *   3. the real `ensureChatCollections` path runs once (concurrent callers share
 *      the memo, not one init per request), creates the partial index, never the
 *      legacy one, and lets the channelId backfill finally complete.
 */
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ensureChatCollections,
  getChannelCollection,
  getMessageCollection,
  CHAT_CLIENT_IDEMPOTENCY_INDEX,
  LEGACY_CHAT_CLIENT_IDEMPOTENCY_INDEX,
} from '@/lib/models/Chat'
import { sendIdempotent } from '@/lib/chat-service'

let server: MongoMemoryServer
let client: MongoClient

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } })
  client = new MongoClient(server.getUri())
  await client.connect()
}, 120_000)

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

// `Chat.ts` guards its index/initialisation work with process-global memos, so
// the memoised code path (ensureChatCollections) is exercised in exactly ONE
// database, in the LAST suite. The first two suites call the driver directly and
// therefore run in complete isolation from that memo.
const freshDb = (): Db => client.db(`chatidx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`)

const legacyMessage = (channelId: ObjectId | null, extra: Record<string, unknown> = {}) => ({
  ...(channelId ? { channelId } : {}),
  senderId: new ObjectId(),
  content: 'pre-channel row',
  isSystem: false,
  createdAt: new Date(),
  ...extra,
})

describe('the legacy unique+SPARSE {channelId,clientId} index (the shipped bug)', () => {
  it('rejects two clientId-less messages in the same channel — E11000 on null', async () => {
    const col = getMessageCollection(freshDb())
    const channel = new ObjectId()
    await col.insertMany([legacyMessage(channel), legacyMessage(channel)] as never)

    await expect(
      col.createIndex(
        { channelId: 1, clientId: 1 },
        { unique: true, sparse: true, name: LEGACY_CHAT_CLIENT_IDEMPOTENCY_INDEX }
      )
    ).rejects.toMatchObject({ code: 11000 })
  })
})

describe('the replacement unique+PARTIAL index', () => {
  const spec = {
    unique: true,
    name: CHAT_CLIENT_IDEMPOTENCY_INDEX,
    partialFilterExpression: { clientId: { $type: 'string' } },
  } as const

  it('leaves clientId-less rows out entirely, so many can share a channel', async () => {
    const col = getMessageCollection(freshDb())
    await col.createIndex({ channelId: 1, clientId: 1 }, spec)
    const channel = new ObjectId()
    // Would collide under the sparse index; fine under the partial one.
    await expect(
      col.insertMany([
        legacyMessage(channel),
        legacyMessage(channel),
        legacyMessage(channel),
      ] as never)
    ).resolves.toMatchObject({ acknowledged: true })
  })

  it('still collapses a repeated clientId within a channel (dedup preserved)', async () => {
    const col = getMessageCollection(freshDb())
    await col.createIndex({ channelId: 1, clientId: 1 }, spec)
    const channel = new ObjectId()
    const doc = (clientId: string, ch: ObjectId = channel) => ({
      channelId: ch,
      senderId: new ObjectId(),
      senderName: 'X',
      content: 'msg',
      isSystem: false,
      isDeleted: false,
      clientId,
      createdAt: new Date(),
    })

    await col.insertOne(doc('dup-1') as never)
    await expect(col.insertOne(doc('dup-1') as never)).rejects.toMatchObject({ code: 11000 })
    // A different token, and the same token in another channel, are both fine.
    await expect(col.insertOne(doc('dup-2') as never)).resolves.toBeTruthy()
    await expect(col.insertOne(doc('dup-1', new ObjectId()) as never)).resolves.toBeTruthy()
  })
})

describe('ensureChatCollections via the real code path (single memoised database)', () => {
  it('runs init once, builds the partial index (never the legacy one), and completes the backfill', async () => {
    const db = freshDb()
    // A pre-channel row: no channelId, no clientId, no isDeleted.
    await getMessageCollection(db).insertOne(legacyMessage(null) as never)

    // Concurrent + repeat calls must share ONE in-flight promise: initialisation
    // happens once per process, not once per request.
    const first = ensureChatCollections(db)
    expect(ensureChatCollections(db)).toBe(first)
    await first

    const indexes = (await getMessageCollection(db).indexes()).map(
      (i) => i as unknown as Record<string, unknown>
    )
    const names = indexes.map((i) => i.name as string)
    expect(names).toContain(CHAT_CLIENT_IDEMPOTENCY_INDEX)
    expect(names).not.toContain(LEGACY_CHAT_CLIENT_IDEMPOTENCY_INDEX)
    const partial = indexes.find((i) => i.name === CHAT_CLIENT_IDEMPOTENCY_INDEX)
    expect(partial?.unique).toBe(true)
    expect(partial?.partialFilterExpression).toEqual({ clientId: { $type: 'string' } })
    expect(partial?.sparse).toBeUndefined()

    // The three default channels exist.
    expect(await getChannelCollection(db).countDocuments({})).toBeGreaterThanOrEqual(3)

    // The migration finally completed: the legacy row was backfilled to `general`.
    const migrated = await getMessageCollection(db).findOne({ content: 'pre-channel row' })
    expect(migrated?.channelId).toBeInstanceOf(ObjectId)
    expect(migrated?.isDeleted).toBe(false)

    // End-to-end dedup through the real send path: a retry folds into the first.
    const general = await getChannelCollection(db).findOne({ key: 'general' })
    const senderId = new ObjectId()
    const base = { channelId: general!._id!, senderId, senderName: 'Founder', content: 'hello' }
    const one = await sendIdempotent(db, { ...base, clientId: 'retry-token' })
    const two = await sendIdempotent(db, { ...base, clientId: 'retry-token' })
    expect(one.created).toBe(true)
    expect(two.created).toBe(false)
    expect(two.message._id!.toString()).toBe(one.message._id!.toString())
  })
})
