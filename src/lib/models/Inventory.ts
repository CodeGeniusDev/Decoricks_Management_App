import { Db, Collection, ObjectId, type ClientSession } from 'mongodb'
import type { Location } from '@/lib/models/Product'
import type { MovementType } from '@/lib/stock-math'

/**
 * Phase 5 inventory core documents (SPEC §3.1.5 extended per the Phase 5
 * brief): the append-only `stockMovements` ledger and the `purchases`
 * collection that feeds it.
 *
 * `stockMovements` is never mutated beyond the `status`/`reversedBy`
 * bookkeeping fields. A correction is a NEW movement with `isReversal: true`
 * linked to the original via `reversesId` — the same trick the Phase 3 money
 * ledger uses, so every derived stock figure cancels exactly when a movement
 * is corrected.
 */

export type StockReferenceType = 'order' | 'purchase' | 'transfer' | 'adjustment' | 'return'

export interface StockMovement {
  _id?: ObjectId
  productId: ObjectId
  movementType: MovementType
  /** Always a positive integer; the type (and `isReversal`) fixes the sign. */
  quantity: number
  fromLocation?: Location | null
  toLocation?: Location | null
  /** Paisa snapshot at time of movement. Drives COGS on sale_out. */
  unitCost?: number
  /** Only meaningful for `adjustment`: the sign the quantity takes. */
  direction?: 'in' | 'out'
  referenceId?: ObjectId | null
  referenceType?: StockReferenceType | null
  /** Set on a correction movement: the movement it reverses. */
  reversesId?: ObjectId
  /** Set on the original once a reversal exists. */
  reversedBy?: ObjectId
  isReversal: boolean
  status: 'posted' | 'reversed'
  /** Unique sparse index: replays of the same operation never double-post. */
  idempotencyKey?: string
  notes?: string
  /** Business date (Karachi midnight when typed as a plain date). */
  date: Date
  createdAt: Date
  createdBy: ObjectId
}

export interface Purchase {
  _id?: ObjectId
  /** PUR-YYYYMM-NNNN, unique, auto-generated. */
  purchaseNumber: string
  supplierId?: ObjectId | null
  /** Snapshot of the supplier name at purchase time for history stability. */
  supplierName?: string
  productId: ObjectId
  productName: string
  location: Location
  quantity: number
  /** Paisa paid per unit on this purchase. */
  unitCost: number
  /** Paisa, quantity × unitCost. Mirrors the linked ledger expense. */
  totalCost: number
  /** The transactions row created alongside this purchase. */
  ledgerTransactionId?: ObjectId
  /** The stockMovements purchase_in row created alongside this purchase. */
  movementId?: ObjectId
  date: Date
  notes?: string
  idempotencyKey?: string
  createdAt: Date
  createdBy: ObjectId
}

export const getStockMovementCollection = (db: Db): Collection<StockMovement> =>
  db.collection<StockMovement>('stockMovements')

export const getPurchaseCollection = (db: Db): Collection<Purchase> =>
  db.collection<Purchase>('purchases')

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000

/**
 * One purchase record per (order line, etc.) without ever double-inserting:
 * try the insert, and on a duplicate idempotency key return the winner. The
 * unique sparse index (ensured below) is the real arbiter under concurrency.
 */
export async function insertIdempotent<T extends { _id?: ObjectId; idempotencyKey?: string }>(
  collection: Collection<T>,
  doc: T,
  session?: ClientSession
): Promise<{ doc: T; created: boolean }> {
  const opts = session ? { session } : {}
  try {
    const result = await collection.insertOne(doc as never, opts)
    doc._id = result.insertedId as ObjectId
    return { doc, created: true }
  } catch (error) {
    if (isDuplicateKeyError(error) && doc.idempotencyKey) {
      const existing = await collection.findOne({ idempotencyKey: doc.idempotencyKey } as never, opts)
      if (existing) return { doc: existing as unknown as T, created: false }
    }
    throw error
  }
}

let inventoryIndexesPromise: Promise<void> | null = null

/** Memoised per process; failures logged, never thrown (reads must survive). */
export function ensureInventoryIndexes(db: Db): Promise<void> {
  if (!inventoryIndexesPromise) {
    inventoryIndexesPromise = (async () => {
      try {
        await Promise.all([
          getStockMovementCollection(db).createIndex(
            { idempotencyKey: 1 },
            { unique: true, sparse: true, name: 'movements_idempotency_unique' }
          ),
          getStockMovementCollection(db).createIndex(
            { productId: 1, date: -1 },
            { name: 'movements_product_date' }
          ),
          getStockMovementCollection(db).createIndex(
            { referenceId: 1, referenceType: 1 },
            { name: 'movements_reference' }
          ),
          getStockMovementCollection(db).createIndex({ movementType: 1 }, { name: 'movements_type' }),
          getStockMovementCollection(db).createIndex({ date: -1, createdAt: -1 }, { name: 'movements_date' }),
          getStockMovementCollection(db).createIndex({ reversesId: 1 }, { name: 'movements_reverses' }),

          getPurchaseCollection(db).createIndex(
            { purchaseNumber: 1 },
            { unique: true, name: 'purchases_number_unique' }
          ),
          getPurchaseCollection(db).createIndex(
            { idempotencyKey: 1 },
            { unique: true, sparse: true, name: 'purchases_idempotency_unique' }
          ),
          getPurchaseCollection(db).createIndex({ date: -1 }, { name: 'purchases_date' }),
          getPurchaseCollection(db).createIndex({ productId: 1 }, { name: 'purchases_product' }),

          // The stock projection is upserted by several transactional writers;
          // the unique compound index is what makes a guarded $inc race-safe.
          db.collection('stock').createIndex(
            { productId: 1, location: 1 },
            { unique: true, name: 'stock_product_location_unique' }
          ),
        ])
      } catch (error) {
        inventoryIndexesPromise = null
        console.error('ensureInventoryIndexes failed:', error)
      }
    })()
  }
  return inventoryIndexesPromise
}

export const movementToJSON = (m: StockMovement) => ({
  _id: m._id?.toString(),
  productId: m.productId.toString(),
  movementType: m.movementType,
  quantity: m.quantity,
  fromLocation: m.fromLocation ?? null,
  toLocation: m.toLocation ?? null,
  unitCost: m.unitCost,
  direction: m.direction,
  referenceId: m.referenceId?.toString() ?? null,
  referenceType: m.referenceType ?? null,
  reversesId: m.reversesId?.toString(),
  reversedBy: m.reversedBy?.toString(),
  isReversal: m.isReversal,
  status: m.status,
  idempotencyKey: m.idempotencyKey,
  notes: m.notes,
  date: m.date,
  createdAt: m.createdAt,
  createdBy: m.createdBy.toString(),
})

export const purchaseToJSON = (p: Purchase) => ({
  _id: p._id?.toString(),
  purchaseNumber: p.purchaseNumber,
  supplierId: p.supplierId?.toString() ?? null,
  supplierName: p.supplierName,
  productId: p.productId.toString(),
  productName: p.productName,
  location: p.location,
  quantity: p.quantity,
  unitCost: p.unitCost,
  totalCost: p.totalCost,
  ledgerTransactionId: p.ledgerTransactionId?.toString(),
  movementId: p.movementId?.toString(),
  date: p.date,
  notes: p.notes,
  idempotencyKey: p.idempotencyKey,
  createdAt: p.createdAt,
  createdBy: p.createdBy.toString(),
})
