import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase, getMongoClient } from '@/lib/mongodb'
import { getStockCollection, stockToJSON } from '@/lib/models/Product'
import { stockTransferSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { errorResponse, successResponse, validationError } from '@/lib/api-response'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorizeStockWrite } from '@/lib/authorization'

/**
 * POST /api/stock/transfer
 *
 * Moves quantity between locations. Both legs run inside a single transaction so
 * a failure on either side can never silently destroy stock — previously the
 * source was decremented first and a failed destination write lost the units.
 *
 * The source decrement is additionally guarded by a `quantity >= amount` filter
 * so a concurrent transfer cannot drive stock negative.
 */

async function __POST(request: NextRequest) {
  try {
    const parsed = stockTransferSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const { productId, quantity, fromLocation, toLocation } = parsed.data

    // A transfer moves stock at *both* ends, so it needs authority over both
    // locations (SPEC §4.2: the Lahore exception covers Lahore only).
    await authorizeStockWrite([fromLocation, toLocation])
    const db = await getDatabase()
    const stockCol = getStockCollection(db)
    const oid = new ObjectId(productId)
    const now = getKarachiDate()

    const source = await stockCol.findOne({ productId: oid, location: fromLocation } as never)
    const available = source?.quantity ?? 0
    if (available < quantity) {
      return validationError('Not enough stock', [
        { path: 'quantity', message: `Only ${available} unit(s) available at ${fromLocation}` },
      ])
    }

    const decrementFilter = {
      productId: oid,
      location: fromLocation,
      quantity: { $gte: quantity },
    } as never
    const decrementUpdate = {
      $inc: { quantity: -quantity },
      $set: { lastUpdated: now, updatedAt: now },
    } as never
    const incrementFilter = { productId: oid, location: toLocation } as never
    const incrementUpdate = {
      $inc: { quantity },
      $set: { lastUpdated: now, updatedAt: now },
    } as never

    const client = await getMongoClient()
    const session = client.startSession()

    try {
      let transferApplied = false

      await session.withTransaction(async () => {
        const decrement = await stockCol.updateOne(decrementFilter, decrementUpdate, { session } as never)
        if (decrement.modifiedCount === 0) {
          // Abort without throwing a driver-specific error so the caller gets a
          // friendly validation response instead of a 500.
          throw new TransferConflictError()
        }

        await stockCol.updateOne(incrementFilter, incrementUpdate, {
          session,
          upsert: true,
        } as never)

        transferApplied = true
      })

      if (!transferApplied) {
        throw new TransferConflictError()
      }
    } finally {
      await session.endSession()
    }

    const rows = await stockCol.find({ productId: oid } as never).toArray()
    return successResponse(rows.map(stockToJSON))
  } catch (error) {
    if (error instanceof TransferConflictError) {
      return validationError('Stock changed, try again', [
        { path: 'quantity', message: 'Stock was modified by someone else. Reload and retry.' },
      ])
    }
    console.error('POST /api/stock/transfer failed:', error)
    return handleRouteError(error)
  }
}

class TransferConflictError extends Error {
  constructor() {
    super('Stock was modified by someone else')
    this.name = 'TransferConflictError'
  }
}

export const POST = withAuth(__POST)