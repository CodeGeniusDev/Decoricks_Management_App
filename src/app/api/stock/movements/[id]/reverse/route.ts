import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorizeStockWrite, requireAuth } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { getStockMovementCollection, ensureInventoryIndexes, movementToJSON } from '@/lib/models/Inventory'
import { stockMovementReverseSchema } from '@/lib/schemas/operations'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'
import { recordAuditEntry } from '@/lib/audit'
import { getAllowNegativeStock, reverseMovement, runInTransaction } from '@/lib/stock-service'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

/**
 * POST /api/stock/movements/[id]/reverse
 *
 * Corrections on the movement ledger are LINKED REVERSALS, never edits or
 * deletes: a new movement flips every effect of the original (type, quantity,
 * locations and unitCost are mirrored) and the original is marked reversed.
 * Reversing an order's sale_out is handled by the order cancel flow; this
 * endpoint is for mistakes made directly on the ledger (wrong count, wrong
 * transfer, mis-keyed purchase quantity).
 */
async function __POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    if (!isObjectId(id)) {
      return validationError('Invalid movement id', [{ path: 'id', message: 'Malformed id' }])
    }

    const parsed = stockMovementReverseSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    await ensureInventoryIndexes(db)

    const original = await getStockMovementCollection(db).findOne({ _id: new ObjectId(id) } as never)
    if (!original) return notFoundError('Stock movement not found')
    if (original.isReversal || original.status === 'reversed') {
      return validationError('Already corrected', [
        { path: 'id', message: 'This movement has already been reversed' },
      ])
    }

    // The reversal touches the same locations as the original; STRICT rule:
    // every stock write checks per location.
    const locations = [...new Set([original.fromLocation, original.toLocation].filter(Boolean))] as string[]
    await authorizeStockWrite(locations.length > 0 ? locations : ['sheikhupura', 'lahore'])
    const auth = await requireAuth()

    const allowNegative = await getAllowNegativeStock(db)

    const result = await runInTransaction(async (session) =>
      reverseMovement(
        db,
        new ObjectId(id),
        {
          createdBy: auth.user._id as ObjectId,
          reason: parsed.data.reason,
          idempotencyKey: parsed.data.idempotencyKey,
          allowNegative,
        },
        session
      )
    )

    if (result.created) {
      const meta = await getRequestMeta()
      await recordAuditEntry(db, {
        userId: auth.user._id as ObjectId,
        userEmail: auth.user.email,
        action: 'stock_movement_reversed',
        entityType: 'stock',
        entityId: original._id ?? null,
        oldValue: { status: original.status },
        newValue: { status: 'reversed', reversalId: result.reversal._id?.toString(), reason: parsed.data.reason },
        details: `Reversed ${original.movementType} of ${original.quantity} unit(s): ${parsed.data.reason}`,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
    }

    return successResponse({ movement: movementToJSON(result.reversal), replay: !result.created })
  } catch (error) {
    console.error('POST /api/stock/movements/[id]/reverse failed:', error)
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
