import { ObjectId } from 'mongodb'

/*
 * A tiny in-memory stand-in for the MongoDB driver, good enough to run the
 * real Phase 5 write paths (`stock-service`, `insertIdempotent`, routes) without
 * a replica set. It exists because the behaviour that matters in this phase is
 * query semantics, not storage:
 *
 *   • a unique index on `idempotencyKey` that raises error code 11000, so a
 *     replayed create is detected the way production detects it;
 *   • single-document read-modify-write for `updateOne`, so a guarded
 *     `{ quantity: { $gte: n } }` filter is evaluated against the state at the
 *     moment the update is applied — the property that makes two concurrent
 *     sales of the last unit serialize instead of both succeeding;
 *   • `$inc`, `$set`, `$setOnInsert` and upsert.
 *
 * Only the operators the app actually uses are implemented; anything else is an
 * explicit error rather than a silent no-op, so a test can never pass by
 * accident.
 */

export type Doc = Record<string, unknown>

const DUPLICATE_KEY = 11000

export class DuplicateKeyError extends Error {
  code = DUPLICATE_KEY
  constructor(key: string) {
    super(`E11000 duplicate key error collection: index: ${key}`)
    this.name = 'DuplicateKeyError'
  }
}

const same = (a: unknown, b: unknown): boolean => {
  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b)
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : Number(a)
    const bt = b instanceof Date ? b.getTime() : Number(b)
    return at === bt
  }
  if (typeof a === 'object' && (a === null || b === null)) return a === b
  if (typeof a === 'object' || typeof b === 'object') return String(a) === String(b)
  return a === b
}

const getPath = (doc: Doc, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, part) => (acc == null ? acc : (acc as Doc)[part]), doc)

const setPath = (doc: Doc, path: string, value: unknown): void => {
  const parts = path.split('.')
  const last = parts.pop() as string
  let target = doc
  for (const part of parts) {
    target[part] = (target[part] ?? {}) as Doc
    target = target[part] as Doc
  }
  target[last] = value
}

/**
 * A transaction, modelled the way the app uses one: every write registers the
 * inverse of what it did, and a rollback replays those inverses in reverse.
 * Unlike a whole-database snapshot, an undo log leaves a CONCURRENT committed
 * transaction's writes alone, which is exactly the property the last-unit race
 * test needs.
 */
export class MemSession {
  readonly id = 'mem-session'
  private readonly undo: Array<() => void> = []

  record(inverse: () => void): void {
    this.undo.push(inverse)
  }

  commit(): void {
    this.undo.length = 0
  }

  rollback(): void {
    while (this.undo.length) (this.undo.pop() as () => void)()
  }

  /*
   * Driver-shaped surface, so `runInTransaction` (which calls
   * `client.startSession()` then `session.withTransaction(...)`) runs against
   * this fake unmodified.
   */
  async withTransaction(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      const result = await fn()
      this.commit()
      return result
    } catch (error) {
      this.rollback()
      throw error
    }
  }

  async endSession(): Promise<void> {
    this.rollback()
  }
}

/** Reads the `session` out of a driver options bag, if the caller passed one. */
const sessionOf = (opts: unknown): MemSession | undefined => {
  const candidate =
    opts && typeof opts === 'object' && 'session' in (opts as Record<string, unknown>)
      ? (opts as { session: unknown }).session
      : opts
  return candidate instanceof MemSession ? candidate : undefined
}

/** A filter value like `{ $gte: 3 }` is a condition, not a literal to compare. */
const isOperatorObject = (value: unknown): boolean =>
  !!value &&
  typeof value === 'object' &&
  !(value instanceof ObjectId) &&
  !(value instanceof Date) &&
  Object.keys(value as Doc).some((key) => key.startsWith('$'))

/** Operator-aware document matcher. */
export const matches = (doc: Doc, filter: Doc): boolean =>
  Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') {
      return (condition as Doc[]).every((sub) => matches(doc, sub))
    }
    if (key === '$or') {
      return (condition as Doc[]).some((sub) => matches(doc, sub))
    }
    const actual = getPath(doc, key)

    if (condition && typeof condition === 'object' && !(condition instanceof ObjectId) && !(condition instanceof Date)) {
      const ops = condition as Doc
      for (const [op, expected] of Object.entries(ops)) {
        switch (op) {
          case '$gte':
            if (!(Number(actual) >= Number(expected))) return false
            break
          case '$lte':
            if (!(Number(actual) <= Number(expected))) return false
            break
          case '$gt':
            if (!(Number(actual) > Number(expected))) return false
            break
          case '$lt':
            if (!(Number(actual) < Number(expected))) return false
            break
          case '$ne':
            if (same(actual, expected)) return false
            break
          case '$in':
            if (!(expected as unknown[]).some((v) => same(actual, v))) return false
            break
          case '$nin':
            if ((expected as unknown[]).some((v) => same(actual, v))) return false
            break
          case '$exists': {
            const exists = actual !== undefined && actual !== null
            if (expected ? !exists : exists) return false
            break
          }
          case '$regex': {
            const re = new RegExp(expected as string, (ops.$options as string) ?? '')
            if (!re.test(String(actual ?? ''))) return false
            break
          }
          case '$options':
            break
          default:
            throw new Error(`mem-mongo: unsupported operator on "${key}": ${op}`)
        }
      }
      return true
    }
    return same(actual, condition)
  })

class MemCursor {
  constructor(private rows: Doc[]) {}

  sort(spec: Doc = {}): MemCursor {
    const entries = Object.entries(spec)
    return new MemCursor(
      [...this.rows].sort((a, b) => {
        for (const [key, dir] of entries) {
          const av = getPath(a, key)
          const bv = getPath(b, key)
          const an = av instanceof Date ? av.getTime() : Number(av ?? 0)
          const bn = bv instanceof Date ? bv.getTime() : Number(bv ?? 0)
          // Only compare numerically when BOTH sides are real numbers: `NaN`
          // never equals `NaN`, so a numeric-first comparison would make the
          // sort unstable for string fields and silently return the first row
          // instead of the highest.
          if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) {
            return dir === -1 ? bn - an : an - bn
          }
          const cmp = String(av ?? '').localeCompare(String(bv ?? ''))
          if (cmp !== 0) return dir === -1 ? -cmp : cmp
        }
        return 0
      })
    )
  }

  skip(n: number): MemCursor {
    return new MemCursor(this.rows.slice(n))
  }

  limit(n: number): MemCursor {
    return new MemCursor(this.rows.slice(0, n))
  }

  project(): MemCursor {
    return new MemCursor(this.rows)
  }

  async toArray(): Promise<Doc[]> {
    return this.rows.map((row) => ({ ...row }))
  }

  async next(): Promise<Doc | null> {
    const first = this.rows[0]
    return first ? { ...first } : null
  }
}

export interface MemCollectionOptions {
  /** Field names enforced unique (sparse: undefined/absent values always pass). */
  unique?: string[]
}

export class MemCollection {
  docs: Doc[] = []
  updateCount = 0
  insertCount = 0
  private unique: string[]

  constructor(options: MemCollectionOptions = {}) {
    this.unique = options.unique ?? []
  }

  reset(rows: Doc[] = []): void {
    this.docs = rows.map((row) => ({ ...row }))
    this.updateCount = 0
    this.insertCount = 0
  }

  /** Test-side seeding that bypasses the insert hooks but keeps the unique index. */
  push(...documents: unknown[]): void {
    for (const doc of documents) {
      const asDoc = doc as Doc
      const _id = (asDoc._id as ObjectId) ?? new ObjectId()
      this.docs.push({ ...asDoc, _id })
    }
  }

  find(filter: Doc = {}, _opts?: unknown): MemCursor {
    return new MemCursor(this.docs.filter((doc) => matches(doc, filter)))
  }

  async findOne(filter: Doc = {}, _opts?: unknown): Promise<Doc | null> {
    const hit = this.docs.find((doc) => matches(doc, filter))
    return hit ? { ...hit } : null
  }

  async countDocuments(filter: Doc = {}): Promise<number> {
    return this.docs.filter((doc) => matches(doc, filter)).length
  }

  async createIndex(spec: Doc): Promise<string> {
    return Object.keys(spec).join('_')
  }

  /** The routes use aggregate() only for figures this fake is not asked to prove. */
  aggregate(): MemCursor {
    return new MemCursor([])
  }

  async insertOne(doc: Doc, opts?: unknown): Promise<{ acknowledged: true; insertedId: ObjectId }> {
    const _id = (doc._id as ObjectId) ?? new ObjectId()
    for (const key of this.unique) {
      const value = doc[key]
      if (value === undefined || value === null) continue
      if (this.docs.some((existing) => existing[key] !== undefined && same(existing[key], value))) {
        throw new DuplicateKeyError(key)
      }
    }
    const stored = { ...doc, _id }
    this.docs.push(stored)
    this.insertCount += 1
    sessionOf(opts)?.record(() => {
      const at = this.docs.indexOf(stored)
      if (at >= 0) this.docs.splice(at, 1)
    })
    return { acknowledged: true, insertedId: _id }
  }

  async deleteOne(filter: Doc, opts?: unknown): Promise<{ acknowledged: true; deletedCount: number }> {
    const index = this.docs.findIndex((doc) => matches(doc, filter))
    if (index === -1) return { acknowledged: true, deletedCount: 0 }
    const [removed] = this.docs.splice(index, 1)
    sessionOf(opts)?.record(() => this.docs.splice(index, 0, removed))
    return { acknowledged: true, deletedCount: 1 }
  }

  /**
   * The synchronous heart of a single-document write: locate, apply, record the
   * undo. Kept synchronous on purpose — between the read and the write no other
   * caller may interleave, which is what makes `$inc` and a guarded `$gte`
   * behave like MongoDB's atomic per-document operations.
   */
  private applyOne(
    filter: Doc,
    update: { $inc?: Doc; $set?: Doc; $setOnInsert?: Doc },
    opts: { upsert?: boolean; session?: unknown },
    session: MemSession | undefined
  ): {
    matchedCount: number
    upsertedId: unknown
    before: Doc | null
    after: Doc | null
  } {
    const index = this.docs.findIndex((doc) => matches(doc, filter))
    if (index === -1) {
      if (!opts.upsert) {
        return { matchedCount: 0, upsertedId: null, before: null, after: null }
      }
      const created: Doc = {}
      // Equality parts of the filter seed the new document, like MongoDB does.
      // ObjectId/Date values are equality conditions and must be carried over;
      // only operator objects (`{ $gte: … }`) are not.
      for (const [key, value] of Object.entries(filter)) {
        if (key.startsWith('$')) continue
        if (isOperatorObject(value)) continue
        created[key] = value
      }
      for (const [key, value] of Object.entries(update.$set ?? {})) setPath(created, key, value)
      for (const [key, value] of Object.entries(update.$setOnInsert ?? {})) setPath(created, key, value)
      for (const [key, value] of Object.entries(update.$inc ?? {})) {
        setPath(created, key, Number(getPath(created, key) ?? 0) + Number(value))
      }
      // An explicit `_id` in the filter is carried onto the new document, as
      // MongoDB does — a counter upserted by `_id` has to be findable by that
      // same `_id` afterwards, or it would never increment.
      const _id = (created._id as ObjectId) ?? new ObjectId()
      const stored = { ...created, _id }
      this.docs.push(stored)
      this.updateCount += 1
      session?.record(() => {
        const at = this.docs.indexOf(stored)
        if (at >= 0) this.docs.splice(at, 1)
      })
      return { matchedCount: 0, upsertedId: _id, before: null, after: stored }
    }

    const target = this.docs[index]
    const before = { ...target }
    for (const [key, value] of Object.entries(update.$set ?? {})) setPath(target, key, value)
    for (const [key, value] of Object.entries(update.$inc ?? {})) {
      setPath(target, key, Number(getPath(target, key) ?? 0) + Number(value))
    }
    this.updateCount += 1
    session?.record(() => {
      if (this.docs[index] === target) this.docs[index] = before
    })
    return { matchedCount: 1, upsertedId: null, before, after: target }
  }

  /**
   * Applies one atomic read-modify-write on a single document. The body yields
   * to the microtask queue BEFORE reading, so two concurrent updates interleave
   * exactly as two MongoDB writers would: the second one sees the first one's
   * committed state, and a guard that no longer matches simply matches nothing.
   */
  async updateOne(
    filter: Doc,
    update: { $inc?: Doc; $set?: Doc; $setOnInsert?: Doc },
    opts: { upsert?: boolean; session?: unknown } = {}
  ): Promise<{ acknowledged: true; matchedCount: number; modifiedCount: number; upsertedId: ObjectId | null }> {
    await Promise.resolve()
    const result = this.applyOne(filter, update, opts, sessionOf(opts.session ?? opts))
    return {
      acknowledged: true,
      matchedCount: result.matchedCount,
      modifiedCount: result.matchedCount,
      upsertedId: result.upsertedId as ObjectId | null,
    }
  }

  /**
   * `updateOne` that hands back the document it produced.
   *
   * Serial allocation needs this shape specifically: reading the counter after
   * bumping it would let every concurrent caller read the same final value, so
   * the bump must return the value *this* caller allocated, from the same
   * synchronous block that applied it.
   */
  async findOneAndUpdate(
    filter: Doc,
    update: { $inc?: Doc; $set?: Doc; $setOnInsert?: Doc },
    opts: { upsert?: boolean; returnDocument?: 'before' | 'after'; session?: unknown } = {}
  ): Promise<Doc | null> {
    await Promise.resolve()
    const result = this.applyOne(filter, update, opts, sessionOf(opts.session ?? opts))
    if (result.matchedCount === 0 && result.upsertedId === null && result.after === null) return null
    const doc = opts.returnDocument === 'before' ? result.before : result.after
    return doc ? { ...doc } : null
  }

  /**
   * Minimal unordered bulk API — enough for `renumberColumnIfTight`, which
   * queues `find(...).updateOne(...)` ops and then `execute()`s them. Each op
   * is applied through the same synchronous read-modify-write as `updateOne`,
   * so a test sees the renumbered positions exactly as production would.
   */
  initializeUnorderedBulkOp(): MemBulk {
    return new MemBulk(this)
  }
}

class MemBulk {
  private readonly ops: Array<{ filter: Doc; update: { $set?: Doc; $inc?: Doc } }> = []
  private tail: { filter: Doc; update?: { $set?: Doc; $inc?: Doc } } | null = null

  constructor(private readonly col: MemCollection) {}

  find(filter: Doc): MemBulk {
    if (this.tail?.update) this.ops.push(this.tail as { filter: Doc; update: { $set?: Doc; $inc?: Doc } })
    this.tail = { filter }
    return this
  }

  updateOne(update: { $set?: Doc; $inc?: Doc }): MemBulk {
    if (!this.tail) throw new Error('mem-mongo: bulk updateOne before find')
    this.tail.update = update
    return this
  }

  async execute(): Promise<{ acknowledged: true }> {
    if (this.tail?.update) this.ops.push(this.tail as { filter: Doc; update: { $set?: Doc; $inc?: Doc } })
    for (const op of this.ops) await this.col.updateOne(op.filter, op.update)
    this.ops.length = 0
    this.tail = null
    return { acknowledged: true }
  }
}

export interface MemDb {
  /** Named access to the underlying stores, for seeding and assertions. */
  db: Record<string, MemCollection>
  /** The value to hand to app code as `Db` (cast: `mem.handle as unknown as Db`). */
  handle: unknown
  collection: (name: string) => MemCollection
  /** A standalone session, for the reads the app does outside a transaction. */
  session: MemSession
  /** The value to hand to app code as the driver client (`getMongoClient`). */
  client: { startSession: () => MemSession }
  /**
   * Runs `fn` inside one transaction and rolls every write it made back when it
   * throws — the behaviour `runInTransaction` has against real MongoDB.
   */
  inTransaction: <T>(fn: (session: MemSession) => Promise<T>) => Promise<T>
}

/**
 * Builds a fake `Db`. Collections are created on demand so a route reading a
 * name nobody registered still gets a working (empty) collection.
 */
export const createMemDb = (
  uniqueByCollection: Record<string, string[]> = {
    stockMovements: ['idempotencyKey'],
    products: ['sku', 'idempotencyKey'],
    orders: ['orderNumber', 'idempotencyKey'],
    transactions: ['idempotencyKey'],
    returns: ['returnNumber', 'idempotencyKey'],
    purchases: ['purchaseNumber', 'idempotencyKey'],
    businessSettings: ['key'],
    accounts: ['name'],
  }
): MemDb => {
  const registry = new Map<string, MemCollection>()
  const collection = (name: string): MemCollection => {
    let col = registry.get(name)
    if (!col) {
      col = new MemCollection({ unique: uniqueByCollection[name] ?? [] })
      registry.set(name, col)
    }
    return col
  }
  const named = new Proxy(
    {},
    { get: (_target, name: string) => collection(name) }
  ) as Record<string, MemCollection>

  const shared = new MemSession()

  const inTransaction: MemDb['inTransaction'] = async (fn) => {
    const session = new MemSession()
    try {
      const result = await fn(session)
      session.commit()
      return result
    } catch (error) {
      session.rollback()
      throw error
    }
  }

  return {
    db: named,
    handle: { collection },
    collection,
    session: shared,
    client: { startSession: () => new MemSession() },
    inTransaction,
  }
}
