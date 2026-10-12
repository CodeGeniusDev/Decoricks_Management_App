import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorizeStockWrite, requireAuth } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { getProductCollection } from '@/lib/models/Product'
import { ensureInventoryIndexes } from '@/lib/models/Inventory'
import { stockDamageSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'
import { recordAuditEntry } from '@/lib/audit'
import { LOCATION_LABELS } from '@/lib/stock-math'
import { getAllowNegativeStock, postMovement, runInTransaction } from '@/lib/stock-service'

/**
 * POST /api/stock/damage
 *
 * Physical losses found in the warehouse (not customer returns, which go
 * through the returns flow): `damage` moves units available → damaged, a
 * `writeoff` removes them entirely. Both are append-only movements; the
 * damaged/returned pools are derived, never typed.
 */
async function __POST(request: NextRequest) {
  try {
    const parsed = stockDamageSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const { productId, location, quantity, type, reason, idempotencyKey } = parsed.data

    await authorizeStockWrite([location])
    const auth = await requireAuth()

    const db = await getDatabase()
    await ensureInventoryIndexes(db)
    const oid = new ObjectId(productId)

    const product = await getProductCollection(db).findOne({ _id: oid } as never)
    if (!product) return notFoundError('Product not found')

    const allowNegative = await getAllowNegativeStock(db)

    const result = await runInTransaction(async (session) => {
      const posted = await postMovement(
        db,
        {
          productId: oid,
          movementType: type,
          quantity,
          fromLocation: location,
          referenceType: 'adjustment',
          idempotencyKey,
          notes: reason,
          date: getKarachiDate(),
          createdBy: auth.user._id as ObjectId,
          allowNegative,
        },
        session
      )
      return posted
    })

    if (result.created) {
      const meta = await getRequestMeta()
      await recordAuditEntry(db, {
        userId: auth.user._id as ObjectId,
        userEmail: auth.user.email,
        action: type === 'damage' ? 'stock_damaged' : 'stock_written_off',
        entityType: 'stock',
        entityId: result.movement._id ?? oid,
        details: `${quantity} unit(s) of ${product.name} ${type === 'damage' ? 'damaged' : 'written off'} at ${
          LOCATION_LABELS[location] ?? location
        }: ${reason}`,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
    }

    return successResponse({ movement: result.movement, replay: !result.created })
  } catch (error) {
    console.error('POST /api/stock/damage failed:', error)
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
