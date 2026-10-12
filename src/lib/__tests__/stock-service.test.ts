import { describe, it, expect, beforeEach } from 'vitest'
import { ObjectId, type ClientSession, type Db } from 'mongodb'
import {
  InsufficientStockError,
  applyAvailableDelta,
  applyPurchaseWeightedAverageCost,
  getAllowNegativeStock,
  getAvailableAt,
  getTotalAvailable,
  postMovement,
  reverseMovement,
} from '@/lib/stock-service'
import { deriveStock, cogsFromMovements, type MovementLike } from '@/lib/stock-math'
import type { Product } from '@/lib/models/Product'
import { createMemDb, type MemDb } from './helpers/mem-mongo'

/*
 * The Phase 5 stock writer, tested against an in-memory stand-in for MongoDB
 * that preserves the two properties production relies on: per-document atomic
 * read-modify-write (so a guard is evaluated at apply time, not read time) and
 * a unique index on `idempotencyKey` (so a replay is detected, not duplicated).
 *
 * Everything here is about the invariants, so the numbers are deliberately
 * small and the assertions are about counts and pool values, not formatting.
 */

const PRODUCT_ID = new ObjectId('507f1f77bcf86cd799439011')
const ACTOR = new ObjectId('507f1f77bcf86cd7994390aa')
const SESSION = { id: 'test-session' } as unknown as ClientSession

let mem: MemDb
let db: Db

const seed = (productId: ObjectId, location: string, quantity: number) => {
  mem.collection('stock').docs.push({
    _id: new ObjectId(),
    productId,
    location,
    quantity,
    lastUpdated: new Date(),
    updatedAt: new Date(),
  })
}

type PostInput = Omit<Parameters<typeof postMovement>[1], 'createdBy' | 'allowNegative'> &
  Partial<Pick<Parameters<typeof postMovement>[1], 'createdBy' | 'allowNegative'>>

/**
 * Every write goes through a transaction, because that is what the app does:
 * a movement that fails halfway must vanish from the ledger entirely, not stay
 * appended with its projection leg missing.
 */
const post = (input: PostInput) =>
  mem.inTransaction((session) =>
    postMovement(
      db,
      {
        ...input,
        createdBy: input.createdBy ?? ACTOR,
        allowNegative: input.allowNegative ?? false,
      },
      session as unknown as ClientSession
    )
  )

/** Stored movement shape, as the fake collection keeps it. */
interface RawMovement {
  _id: ObjectId
  productId: ObjectId
  movementType: string
  quantity: number
  fromLocation?: string | null
  toLocation?: string | null
  unitCost?: number
  isReversal?: boolean
  status?: string
  reversedBy?: ObjectId
}

const rawMovements = () => mem.collection('stockMovements').docs as unknown as RawMovement[]

/** The derived pools for one product, straight off the movement ledger. */
const derivedPools = () => {
  const movements = rawMovements().map((m) => ({ ...m, productId: String(m.productId) }))
  return deriveStock(movements as unknown as MovementLike[])
}

type ReverseInput = Parameters<typeof reverseMovement>[2]

/** `createdBy` is always the same test actor; the transaction is always real. */
const rev = (
  id: ObjectId,
  input: Pick<ReverseInput, 'allowNegative'> & Partial<Omit<ReverseInput, 'allowNegative'>>
) =>
  mem.inTransaction((session) =>
    reverseMovement(
      db,
      id,
      { ...input, createdBy: input.createdBy ?? ACTOR },
      session as unknown as ClientSession
    )
  )

beforeEach(() => {
  mem = createMemDb()
  db = mem.handle as unknown as Db
})

describe('postMovement', () => {
  it('a purchase lifts the available projection at the receiving location', async () => {
    await post({
      productId: PRODUCT_ID,
      movementType: 'purchase_in',
      quantity: 10,
      toLocation: 'sheikhupura',
      unitCost: 50_000,
    })

    expect(await getAvailableAt(db, PRODUCT_ID, 'sheikhupura', SESSION)).toBe(10)
    expect(mem.collection('stockMovements').docs).toHaveLength(1)
    // Stock is never typed: the projection must equal what the ledger implies.
    expect(derivedPools().get(`${PRODUCT_ID.toString()}|sheikhupura`)).toEqual({
      available: 10,
      damaged: 0,
      returned: 0,
    })
  })

  it('a transfer moves units between locations without creating or destroying any', async () => {
    seed(PRODUCT_ID, 'sheikhupura', 10)

    await post({
      productId: PRODUCT_ID,
      movementType: 'transfer',
      quantity: 4,
      fromLocation: 'sheikhupura',
      toLocation: 'lahore',
    })

    expect(await getTotalAvailable(db, PRODUCT_ID, SESSION)).toBe(10)
    expect(await getAvailableAt(db, PRODUCT_ID, 'sheikhupura', SESSION)).toBe(6)
    expect(await getAvailableAt(db, PRODUCT_ID, 'lahore', SESSION)).toBe(4)
  })

  it('blocks a sale of stock that is not there, and leaves the ledger untouched', async () => {
    seed(PRODUCT_ID, 'lahore', 2)

    const error = await post({
      productId: PRODUCT_ID,
      movementType: 'sale_out',
      quantity: 3,
      fromLocation: 'lahore',
      unitCost: 50_000,
    }).catch((e) => e)

    expect(error).toBeInstanceOf(InsufficientStockError)
    expect((error as InsufficientStockError).status).toBe(409)
    expect((error as InsufficientStockError).message).toMatch(/2 available, 3 required/)
    // Nothing was appended, so nothing can be derived or reported later.
    expect(mem.collection('stockMovements').docs).toHaveLength(0)
    expect(await getAvailableAt(db, PRODUCT_ID, 'lahore', SESSION)).toBe(2)
  })

  it('lets two simultaneous sales of the last unit through only once', async () => {
    seed(PRODUCT_ID, 'lahore', 1)

    const attempts = await Promise.allSettled([
      post({
        productId: PRODUCT_ID,
        movementType: 'sale_out',
        quantity: 1,
        fromLocation: 'lahore',
        unitCost: 50_000,
        idempotencyKey: 'race-a',
      }),
      post({
        productId: PRODUCT_ID,
        movementType: 'sale_out',
        quantity: 1,
        fromLocation: 'lahore',
        unitCost: 50_000,
        idempotencyKey: 'race-b',
      }),
    ])

    const ok = attempts.filter((a) => a.status === 'fulfilled')
    const failed = attempts.filter((a) => a.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientStockError)

    // Exactly one movement is on the books and stock is exactly zero: no
    // overselling and no phantom reservation.
    expect(mem.collection('stockMovements').docs).toHaveLength(1)
    expect(await getAvailableAt(db, PRODUCT_ID, 'lahore', SESSION)).toBe(0)
  })

  it('allows the negative leg when the Founder switched the setting on', async () => {
    mem.collection('businessSettings').docs.push({ key: 'business', allowNegativeStock: true })
    expect(await getAllowNegativeStock(db)).toBe(true)

    await post({
      productId: PRODUCT_ID,
      movementType: 'sale_out',
      quantity: 5,
      fromLocation: 'sheikhupura',
      unitCost: 50_000,
      allowNegative: true,
    })

    expect(await getAvailableAt(db, PRODUCT_ID, 'sheikhupura', SESSION)).toBe(-5)
  })

  it('treats a replayed idempotency key as the original, never a second movement', async () => {
    const input = {
      productId: PRODUCT_ID,
      movementType: 'purchase_in' as const,
      quantity: 10,
      toLocation: 'sheikhupura' as const,
      idempotencyKey: 'purchase-1-in',
    }

    const first = await post(input)
    const replay = await post(input)

    expect(first.created).toBe(true)
    expect(replay.created).toBe(false)
    expect(String(replay.movement._id)).toBe(String(first.movement._id))
    expect(mem.collection('stockMovements').docs).toHaveLength(1)
    // The retry must not lift stock twice.
    expect(await getAvailableAt(db, PRODUCT_ID, 'sheikhupura', SESSION)).toBe(10)
  })

  it('rejects a non-positive or fractional quantity before touching anything', async () => {
    for (const quantity of [0, -3, 1.5]) {
      await expect(
        post({
          productId: PRODUCT_ID,
          movementType: 'purchase_in',
          quantity,
          toLocation: 'sheikhupura',
        })
      ).rejects.toThrow(/positive integer/)
    }
    expect(mem.collection('stockMovements').docs).toHaveLength(0)
  })

  it('derives damaged and returned pools instead of storing them', async () => {
    seed(PRODUCT_ID, 'lahore', 5)

    await post({ productId: PRODUCT_ID, movementType: 'sale_out', quantity: 3, fromLocation: 'lahore', unitCost: 50_000 })
    await post({ productId: PRODUCT_ID, movementType: 'return_damaged', quantity: 1, toLocation: 'lahore', unitCost: 50_000 })
    await post({ productId: PRODUCT_ID, movementType: 'return_writeoff', quantity: 1, toLocation: 'lahore', unitCost: 50_000 })

    const pools = derivedPools().get(`${PRODUCT_ID.toString()}|lahore`)
    // The ledger alone says: 3 sold out, 1 damaged return, 1 written-off return.
    expect(pools).toEqual({ available: -3, damaged: 1, returned: 2 })
    // And the projection it maintains agrees once the seeded opening stock is
    // counted: 5 on hand, 3 sold → 2 available. Damaged and written-off units
    // never re-enter that pool.
    expect(await getAvailableAt(db, PRODUCT_ID, 'lahore', SESSION)).toBe(2)
    // Damaged and written-off returns keep their cost of sales: the cost was real.
    expect(cogsFromMovements(rawMovements() as unknown as MovementLike[])).toBe(3 * 50_000)
  })
})

describe('applyAvailableDelta', () => {
  it('guards the decrement on the document, not on a stale read', async () => {
    seed(PRODUCT_ID, 'sheikhupura', 4)

    // A read-then-write would happily go to -1 here; the guard must refuse.
    await expect(
      applyAvailableDelta(db, PRODUCT_ID, 'sheikhupura', -5, { allowNegative: false, session: SESSION })
    ).rejects.toBeInstanceOf(InsufficientStockError)
    expect(await getAvailableAt(db, PRODUCT_ID, 'sheikhupura', SESSION)).toBe(4)

    await applyAvailableDelta(db, PRODUCT_ID, 'sheikhupura', -4, { allowNegative: false, session: SESSION })
    expect(await getAvailableAt(db, PRODUCT_ID, 'sheikhupura', SESSION)).toBe(0)
  })

  it('is a no-op for a zero delta', async () => {
    await applyAvailableDelta(db, PRODUCT_ID, 'lahore', 0, { allowNegative: false, session: SESSION })
    expect(mem.collection('stock').docs).toHaveLength(0)
  })
})

describe('reverseMovement', () => {
  it('cancels the original in every derived figure and marks it reversed', async () => {
    seed(PRODUCT_ID, 'lahore', 6)

    const original = await post({
      productId: PRODUCT_ID,
      movementType: 'sale_out',
      quantity: 2,
      fromLocation: 'lahore',
      unitCost: 50_000,
      idempotencyKey: 'order-1-out-0',
    })
    expect(await getAvailableAt(db, PRODUCT_ID, 'lahore', SESSION)).toBe(4)

    const reversal = await rev(original.movement._id!, {
      reason: 'Order cancelled',
      idempotencyKey: 'order-1-cancel',
      allowNegative: false,
    })

    expect(reversal.created).toBe(true)
    // Restores the units and erases the COGS the original added.
    expect(await getAvailableAt(db, PRODUCT_ID, 'lahore', SESSION)).toBe(6)
    const rows = rawMovements()
    expect(cogsFromMovements(rows as unknown as MovementLike[])).toBe(0)
    expect(rows).toHaveLength(2)

    const stored = rows.find((r) => String(r._id) === String(original.movement._id))
    expect(stored?.status).toBe('reversed')
    expect(String(stored?.reversedBy)).toBe(String(reversal.reversal._id))

    // The reversal mirrors the original exactly, so a cancel of a transfer lands
    // on both legs.
    const reversalRow = rows.find((r) => r.isReversal)
    expect(reversalRow?.movementType).toBe('sale_out')
    expect(reversalRow?.quantity).toBe(2)
    expect(reversalRow?.fromLocation).toBe('lahore')
    expect(reversalRow?.unitCost).toBe(50_000)
  })

  it('refuses to reverse the same movement twice, and to reverse a reversal', async () => {
    const original = await post({
      productId: PRODUCT_ID,
      movementType: 'purchase_in',
      quantity: 5,
      toLocation: 'sheikhupura',
    })

    await rev(original.movement._id!, { allowNegative: false })

    await expect(rev(original.movement._id!, { allowNegative: false })).rejects.toMatchObject({
      status: 409,
    })

    const rows = rawMovements()
    const reversalId = rows.find((r) => r.isReversal)?._id as ObjectId
    await expect(rev(reversalId, { allowNegative: false })).rejects.toThrow(/reversal/i)

    // Only the original purchase and its one reversal are on the books.
    expect(rows).toHaveLength(2)
    expect(await getAvailableAt(db, PRODUCT_ID, 'sheikhupura', SESSION)).toBe(0)
  })

  it('replays a repeated cancel without restoring the units a second time', async () => {
    seed(PRODUCT_ID, 'lahore', 3)
    const original = await post({
      productId: PRODUCT_ID,
      movementType: 'sale_out',
      quantity: 3,
      fromLocation: 'lahore',
      unitCost: 50_000,
    })
    expect(await getAvailableAt(db, PRODUCT_ID, 'lahore', SESSION)).toBe(0)

    await rev(original.movement._id!, { allowNegative: false, idempotencyKey: 'order-9-cancel' })
    const afterFirst = await getAvailableAt(db, PRODUCT_ID, 'lahore', SESSION)
    expect(afterFirst).toBe(3)

    const replay = await rev(original.movement._id!, {
      allowNegative: false,
      idempotencyKey: 'order-9-cancel',
    })

    expect(replay.created).toBe(false)
    expect(await getAvailableAt(db, PRODUCT_ID, 'lahore', SESSION)).toBe(afterFirst)
    expect(rawMovements()).toHaveLength(2)
  })

  it('404s on a movement that does not exist', async () => {
    await expect(rev(new ObjectId(), { allowNegative: false })).rejects.toMatchObject({ status: 404 })
  })
})

describe('applyPurchaseWeightedAverageCost', () => {
  const product = (cost: number): Product => ({
    _id: PRODUCT_ID,
    sku: 'VASE',
    name: 'Vase',
    category: 'decor',
    cost,
    sellingPrice: 120_000,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  it('runs the SPEC §5.3 example: 10 @ 500 then 5 @ 600 becomes 533.33', async () => {
    mem.collection('products').push(product(50_000))
    seed(PRODUCT_ID, 'sheikhupura', 10)

    const stored = mem.collection('products').docs[0] as unknown as Product
    const { wacBefore, wacAfter } = await applyPurchaseWeightedAverageCost(
      db,
      { ...stored, _id: PRODUCT_ID },
      5,
      60_000,
      SESSION
    )

    expect(wacBefore).toBe(50_000)
    // (10 × 50,000 + 5 × 60,000) / 15 = 53,333.33 → 53,333 paisa.
    expect(wacAfter).toBe(53_333)
    expect((mem.collection('products').docs[0] as unknown as Product).cost).toBe(53_333)
  })

  it('takes the incoming cost alone when nothing is on hand', async () => {
    mem.collection('products').push(product(0))
    const stored = mem.collection('products').docs[0] as unknown as Product

    const { wacAfter } = await applyPurchaseWeightedAverageCost(
      db,
      { ...stored, _id: PRODUCT_ID },
      4,
      75_000,
      SESSION
    )
    expect(wacAfter).toBe(75_000)
  })

  it('weights a partial receipt against real remaining stock, not against purchases', async () => {
    // 2 left at 50,000, then 8 bought at 60,000 → 58,000, not 55,000.
    mem.collection('products').push(product(50_000))
    seed(PRODUCT_ID, 'sheikhupura', 2)

    const stored = mem.collection('products').docs[0] as unknown as Product
    const { wacAfter } = await applyPurchaseWeightedAverageCost(
      db,
      { ...stored, _id: PRODUCT_ID },
      8,
      60_000,
      SESSION
    )
    expect(wacAfter).toBe(58_000)
  })
})

describe('getAllowNegativeStock', () => {
  it('is false when no settings document exists', async () => {
    expect(await getAllowNegativeStock(db)).toBe(false)
  })

  it('reads only an explicit true', async () => {
    mem.collection('businessSettings').docs.push({ key: 'business', allowNegativeStock: 'yes' })
    expect(await getAllowNegativeStock(db)).toBe(false)

    mem.collection('businessSettings').docs.length = 0
    mem.collection('businessSettings').docs.push({ key: 'business', allowNegativeStock: true })
    expect(await getAllowNegativeStock(db)).toBe(true)
  })
})
