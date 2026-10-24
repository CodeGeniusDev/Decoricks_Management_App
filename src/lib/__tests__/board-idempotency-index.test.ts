/**
 * Create-board idempotency — real-MongoDB integration test.
 *
 * The "Create board" button (tasks page) sends a POST /api/boards carrying an
 * `idempotencyKey`. Two things must hold so a double-click can never build two
 * boards, and both are DB guarantees rather than React guarantees, so they are
 * proven against a hermetic `mongodb-memory-server` (a real mongod):
 *
 *   1. `createBoardWithDefaults` seeds the board AND its four default columns,
 *      and persists the `idempotencyKey` on the board document.
 *   2. The shipped partial-unique index `boards_idempotency_unique` rejects a
 *      replayed `idempotencyKey` (E11000, which the route folds into a 409),
 *      while boards created WITHOUT a key (null/absent) are unaffected — the
 *      partial filter must exclude them, not collapse them all together.
 *
 * `ensureTaskIndexes` guards its work with a process-global memo, so the
 * memoised code path is exercised in exactly ONE database, in the LAST suite.
 * The other suites call the driver directly and run in full isolation.
 */
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ensureTaskIndexes, getBoardCollection, getColumnCollection } from '@/lib/models/Tasks'
import { createBoardWithDefaults, DEFAULT_BOARD_COLUMNS } from '@/lib/task-service'

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

const freshDb = (): Db => client.db(`boardidx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`)

// The exact spec the model ships, reproduced here so the direct-driver suites
// do not depend on the process-global `ensureTaskIndexes` memo.
const IDEMPOTENCY_INDEX = 'boards_idempotency_unique'
const idempotencySpec = {
  unique: true,
  name: IDEMPOTENCY_INDEX,
  partialFilterExpression: { idempotencyKey: { $type: 'string' } },
} as const

describe('createBoardWithDefaults', () => {
  it('writes the board and seeds the four default columns, persisting the key', async () => {
    const db = freshDb()
    const createdBy = new ObjectId()
    const board = await createBoardWithDefaults(db, {
      name: '  Living Room Renovation  ',
      createdBy,
      idempotencyKey: 'b-first',
    })

    expect(board._id).toBeInstanceOf(ObjectId)
    expect(board.name).toBe('Living Room Renovation')
    expect(board.idempotencyKey).toBe('b-first')

    const cols = await getColumnCollection(db)
      .find({ boardId: board._id })
      .sort({ position: 1 })
      .toArray()
    expect(cols.map((c) => c.name)).toEqual(DEFAULT_BOARD_COLUMNS.map((c) => c.name))
    expect(cols.filter((c) => c.isDoneColumn)).toHaveLength(1)
    expect(cols.find((c) => c.isDoneColumn)?.name).toBe('Done')
  })
})

describe('the partial-unique idempotency index (double-click guard)', () => {
  it('rejects a replayed idempotencyKey with E11000', async () => {
    const col = getBoardCollection(freshDb())
    await col.createIndex({ idempotencyKey: 1 }, idempotencySpec)
    const now = new Date()
    const doc = (k: string) => ({
      name: 'Board',
      isActive: true,
      idempotencyKey: k,
      createdAt: now,
    })

    await col.insertOne(doc('dup') as never)
    await expect(col.insertOne(doc('dup') as never)).rejects.toMatchObject({ code: 11000 })
  })

  it('lets key-less boards through — the partial filter excludes null/absent', async () => {
    const col = getBoardCollection(freshDb())
    await col.createIndex({ idempotencyKey: 1 }, idempotencySpec)
    const now = new Date()
    // A null key and a wholly-absent key must not collide with each other or
    // with themselves; only string keys are indexed.
    await expect(
      col.insertMany([
        { name: 'A', isActive: true, idempotencyKey: null, createdAt: now },
        { name: 'B', isActive: true, createdAt: now },
        { name: 'C', isActive: true, idempotencyKey: null, createdAt: now },
      ] as never)
    ).resolves.toMatchObject({ acknowledged: true })
  })
})

describe('ensureTaskIndexes via the real code path (single memoised database)', () => {
  it('builds boards_idempotency_unique as a partial unique index, not sparse', async () => {
    const db = freshDb()
    await ensureTaskIndexes(db)

    const indexes = (await getBoardCollection(db).indexes()).map(
      (i) => i as unknown as Record<string, unknown>
    )
    const names = indexes.map((i) => i.name as string)
    expect(names).toContain(IDEMPOTENCY_INDEX)

    const partial = indexes.find((i) => i.name === IDEMPOTENCY_INDEX)
    expect(partial?.unique).toBe(true)
    expect(partial?.partialFilterExpression).toEqual({ idempotencyKey: { $type: 'string' } })
    expect(partial?.sparse).toBeUndefined()
  })
})
