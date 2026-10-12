import { ObjectId, type ClientSession, type Db } from 'mongodb'
import { getMongoClient } from '@/lib/mongodb'
import { getProductCollection, getStockCollection, type Location, type Product } from '@/lib/models/Product'
import {
  getStockMovementCollection,
  insertIdempotent,
  type StockMovement,
  type StockReferenceType,
} from '@/lib/models/Inventory'
import { getBusinessSettingsCollection } from '@/lib/models/Ledger'
import { movementEffects, weightedAverageCost, type MovementType } from '@/lib/stock-math'
import { HttpError } from '@/lib/http'

/**
 * Phase 5 stock write path.
 *
 * Every stock change in the app goes through `postMovement` (or
 * `reverseMovement`) inside `runInTransaction`. The two invariants this module
 * owns:
 *
 *   1. The append-only movement is the source of truth; the `stock` row is a
 *      materialized projection of the AVAILABLE pool only, kept in the same
 *      transaction so a crash can never leave the two inconsistent.
 *   2. Negative stock is blocked by an atomic guarded `$inc`
 *      (`quantity >= needed`), not by read-then-write. Two simultaneous sales
 *      of the last unit cannot both succeed: one filter matches, the other
 *      matches zero documents and is rejected — unless the Founder has
 *      explicitly enabled `allowNegativeStock` in business settings.
 */

export class InsufficientStockError extends HttpError {
  constructor(productId: string, location: string, needed: number, available: number) {
    super(
      `Not enough stock at ${location}: ${available} available, ${needed} required`,
      409,
      'INSUFFICIENT_STOCK',
      [{ path: 'quantity', message: `${available} unit(s) available at ${location}` }]
    )
    this.name = 'InsufficientStockError'
  }
}

/** Runs `fn` inside one MongoDB transaction, propagating its result/errors. */
export async function runInTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const client = await getMongoClient()
  const session = client.startSession()
  try {
    let result!: T
    await session.withTransaction(async () => {
      result = await fn(session)
    })
    return result
  } finally {
    await session.endSession()
  }
}

/** Founder gate for negative stock (SPEC §10.1.2: block unless explicitly allowed). */
export const getAllowNegativeStock = async (db: Db): Promise<boolean> => {
  const settings = await getBusinessSettingsCollection(db).findOne({ key: 'business' })
  return settings?.allowNegativeStock === true
}

/**
 * Apply a signed change to one product/location's available projection.
 *
 * Decrements are guarded: the update only matches while enough stock is
 * present, so concurrent writers serialize on the document instead of racing
 * on a stale read. When the guard fails we throw unless negative stock has
 * been explicitly allowed.
 */
export async function applyAvailableDelta(
  db: Db,
  productId: ObjectId,
  location: Location,
  delta: number,
  options: { allowNegative: boolean; session: ClientSession }
): Promise<void> {
  if (delta === 0) return
  const stockCol = getStockCollection(db)
  const now = new Date()

  if (delta > 0) {
    await stockCol.updateOne(
      { productId, location } as never,
      { $inc: { quantity: delta }, $set: { lastUpdated: now, updatedAt: now } } as never,
      { session: options.session, upsert: true }
    )
    return
  }

  const needed = -delta
  const guarded = await stockCol.updateOne(
    { productId, location, quantity: { $gte: needed } } as never,
    { $inc: { quantity: delta }, $set: { lastUpdated: now, updatedAt: now } } as never,
    { session: options.session }
  )
  if (guarded.modifiedCount > 0) return

  if (options.allowNegative) {
    await stockCol.updateOne(
      { productId, location } as never,
      { $inc: { quantity: delta }, $set: { lastUpdated: now, updatedAt: now } } as never,
      { session: options.session, upsert: true }
    )
    return
  }

  const current = await stockCol.findOne({ productId, location } as never, {
    session: options.session,
  })
  throw new InsufficientStockError(
    productId.toString(),
    location,
    needed,
    current?.quantity ?? 0
  )
}

export interface PostMovementInput {
  productId: ObjectId
  movementType: MovementType
  /** Positive integer; the type fixes the direction. */
  quantity: number
  fromLocation?: Location | null
  toLocation?: Location | null
  /** Paisa snapshot. Mandatory for COGS-bearing types (sale_out). */
  unitCost?: number
  /** Only for `adjustment`. */
  direction?: 'in' | 'out'
  referenceId?: ObjectId | null
  referenceType?: StockReferenceType | null
  reversesId?: ObjectId
  isReversal?: boolean
  idempotencyKey?: string
  notes?: string
  date?: Date
  createdBy: ObjectId
  allowNegative: boolean
}

/**
 * Insert one movement and update the available projection to match, in the
 * caller's transaction. A movement with an `idempotencyKey` that already
 * exists is a replay: the original is returned and NO further delta applied,
 * so retries can never double-count.
 */
export async function postMovement(
  db: Db,
  input: PostMovementInput,
  session: ClientSession
): Promise<{ movement: StockMovement; created: boolean }> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new HttpError('Movement quantity must be a positive integer', 400, 'VALIDATION_ERROR', [
      { path: 'quantity', message: 'Must be a positive integer' },
    ])
  }

  const movements = getStockMovementCollection(db)
  const now = new Date()
  const key = input.idempotencyKey

  if (key) {
    const existing = await movements.findOne({ idempotencyKey: key } as never, { session })
    if (existing) return { movement: existing, created: false }
  }

  const doc: StockMovement = {
    productId: input.productId,
    movementType: input.movementType,
    quantity: input.quantity,
    fromLocation: input.fromLocation ?? null,
    toLocation: input.toLocation ?? null,
    unitCost: input.unitCost,
    direction: input.direction,
    referenceId: input.referenceId ?? null,
    referenceType: input.referenceType ?? null,
    reversesId: input.reversesId,
    isReversal: input.isReversal ?? false,
    status: 'posted',
    idempotencyKey: key,
    notes: input.notes,
    date: input.date ?? now,
    createdAt: now,
    createdBy: input.createdBy,
  }

  const inserted = await insertIdempotent(movements, doc, session)
  if (!inserted.created) return { movement: inserted.doc, created: false }

  // The projection tracks the AVAILABLE pool only; damaged/returned pools are
  // derived on read. Group effects by location and sum the available change.
  const deltas = new Map<string, number>()
  const asLike = { ...inserted.doc, productId: inserted.doc.productId.toString() }
  for (const effect of movementEffects(asLike)) {
    if (effect.available === 0) continue
    deltas.set(effect.location, (deltas.get(effect.location) ?? 0) + effect.available)
  }
  for (const [location, delta] of deltas) {
    await applyAvailableDelta(db, inserted.doc.productId, location as Location, delta, {
      allowNegative: input.allowNegative,
      session,
    })
  }

  return { movement: inserted.doc, created: true }
}

export interface ReverseMovementInput {
  createdBy: ObjectId
  reason?: string
  idempotencyKey?: string
  date?: Date
  allowNegative: boolean
}

/**
 * Correct a posted movement with a linked reversal movement (never an edit,
 * never a delete). The reversal carries the original's type, quantity,
 * locations and unitCost so every derived figure — including COGS — cancels
 * exactly, and the original is marked `reversed`.
 */
export async function reverseMovement(
  db: Db,
  originalId: ObjectId | string,
  input: ReverseMovementInput,
  session: ClientSession
): Promise<{ reversal: StockMovement; created: boolean }> {
  const oid = typeof originalId === 'string' ? new ObjectId(originalId) : originalId
  const movements = getStockMovementCollection(db)

  if (input.idempotencyKey) {
    const existing = await movements.findOne({ idempotencyKey: input.idempotencyKey } as never, {
      session,
    })
    if (existing) return { reversal: existing, created: false }
  }

  const original = await movements.findOne({ _id: oid } as never, { session })
  if (!original) {
    throw new HttpError('Stock movement not found', 404, 'NOT_FOUND')
  }
  if (original.isReversal) {
    throw new HttpError('A reversal movement cannot itself be reversed', 409, 'ALREADY_REVERSED')
  }
  if (original.status === 'reversed' || original.reversedBy) {
    throw new HttpError('This movement has already been reversed', 409, 'ALREADY_REVERSED')
  }

  const posted = await postMovement(
    db,
    {
      productId: original.productId,
      movementType: original.movementType,
      quantity: original.quantity,
      fromLocation: original.fromLocation,
      toLocation: original.toLocation,
      unitCost: original.unitCost,
      direction: original.direction,
      referenceId: original.referenceId,
      referenceType: original.referenceType,
      reversesId: original._id,
      isReversal: true,
      idempotencyKey: input.idempotencyKey,
      notes: input.reason ? `Reversal: ${input.reason}` : `Reversal of ${oid.toString()}`,
      date: input.date,
      createdBy: input.createdBy,
      // A reversal ADDS back what the original removed; blocking here would
      // only ever bite reversals of purchase_in-style outflows, which are
      // corrections the Founder should be able to make.
      allowNegative: input.allowNegative,
    },
    session
  )

  if (posted.created) {
    await movements.updateOne(
      { _id: oid } as never,
      { $set: { status: 'reversed', reversedBy: posted.movement._id } } as never,
      { session }
    )
  }

  return { reversal: posted.movement, created: posted.created }
}

/** Current available units at one location, from the projection (in-session). */
export async function getAvailableAt(
  db: Db,
  productId: ObjectId,
  location: Location,
  session?: ClientSession
): Promise<number> {
  const row = await getStockCollection(db).findOne(
    { productId, location } as never,
    session ? { session } : {}
  )
  return row?.quantity ?? 0
}

/** Total available units across all locations, from the projection. */
export async function getTotalAvailable(
  db: Db,
  productId: ObjectId,
  session?: ClientSession
): Promise<number> {
  const rows = await getStockCollection(db)
    .find({ productId } as never, session ? { session } : {})
    .toArray()
  return rows.reduce((sum, row) => sum + row.quantity, 0)
}

/**
 * Weighted average cost update for a purchase (SPEC §5.3): recomputes the
 * product's `cost` from the current on-hand quantity and the incoming
 * receipt. Exported separately so tests and the purchase route share one
 * definition; `product.cost` is the WAC — the only place it is written.
 */
export async function applyPurchaseWeightedAverageCost(
  db: Db,
  product: Product,
  inQty: number,
  inCost: number,
  session: ClientSession
): Promise<{ wacBefore: number; wacAfter: number }> {
  const stockQty = await getTotalAvailable(db, product._id!, session)
  const wacBefore = product.cost
  const wacAfter = weightedAverageCost(stockQty, wacBefore, inQty, inCost)

  await getProductCollection(db).updateOne(
    { _id: product._id } as never,
    { $set: { cost: wacAfter, updatedAt: new Date() } } as never,
    { session }
  )
  return { wacBefore, wacAfter }
}
