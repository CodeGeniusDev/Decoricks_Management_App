import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getStockCollection, stockToJSON } from '@/lib/models/Product'
import { ensureInventoryIndexes } from '@/lib/models/Inventory'
import { stockTransferSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { successResponse, validationError } from '@/lib/api-response'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorizeStockWrite, requireAuth } from '@/lib/authorization'
import { recordAuditEntry } from '@/lib/audit'
import { getAllowNegativeStock, postMovement, runInTransaction } from '@/lib/stock-service'

/**
 * POST /api/stock/transfer
 *
 * Phase 5: a transfer is now a `transfer` MOVEMENT on the append-only ledger,
 * not a raw pair of `$inc`s. The movement and both projection legs still run
 * in one transaction, and the source leg is still a guarded `$gte` decrement,
 * so a concurrent transfer can never drive stock negative. Transfers are
 * neither purchases nor sales and never touch the money ledger.
 *
 * SPEC §4.2: a transfer writes stock at BOTH ends, so it needs authority over
 * both locations (the Lahore exception covers Lahore only).
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

    const { productId, quantity, fromLocation, toLocation, idempotencyKey, notes } = parsed.data

    await authorizeStockWrite([fromLocation, toLocation])
    const auth = await requireAuth()

    const db = await getDatabase()
    await ensureInventoryIndexes(db)
    const oid = new ObjectId(productId)
    const allowNegative = await getAllowNegativeStock(db)

    const result = await runInTransaction(async (session) => {
      const posted = await postMovement(
        db,
        {
          productId: oid,
          movementType: 'transfer',
          quantity,
          fromLocation,
          toLocation,
          referenceType: 'transfer',
          idempotencyKey,
          notes,
          date: getKarachiDate(),
          createdBy: auth.user._id as ObjectId,
          allowNegative,
        },
        session
      )
      const rows = await getStockCollection(db).find({ productId: oid } as never, { session }).toArray()
      return { movement: posted.movement, created: posted.created, rows }
    })

    if (result.created) {
      const meta = await getRequestMeta()
      await recordAuditEntry(db, {
        userId: auth.user._id as ObjectId,
        userEmail: auth.user.email,
        action: 'stock_transfer_completed',
        entityType: 'stock',
        entityId: result.movement._id ?? oid,
        details: `Moved ${quantity} unit(s) from ${fromLocation} to ${toLocation}`,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
    }

    return successResponse({
      movements: result.movement,
      stock: result.rows.map(stockToJSON),
      replay: !result.created,
    })
  } catch (error) {
    console.error('POST /api/stock/transfer failed:', error)
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
