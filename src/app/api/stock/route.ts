import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize, authorizeStockWrite, requireAuth } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getProductCollection, getStockCollection, stockToJSON } from '@/lib/models/Product'
import { ensureInventoryIndexes } from '@/lib/models/Inventory'
import { stockAdjustmentSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { recordAuditEntry } from '@/lib/audit'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'
import { getAllowNegativeStock, postMovement, runInTransaction } from '@/lib/stock-service'
import { deriveStock } from '@/lib/stock-math'

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

/**
 * GET /api/stock
 *
 * Stock rows (available projection) joined to product names and the derived
 * damaged/returned pools, so the inventory tables need a single request.
 * Damaged and returned are NEVER typed in; they come from the movement ledger.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('inventory', 'view')

    const { searchParams } = new URL(request.url)
    const productId = searchParams.get('productId')
    const location = searchParams.get('location')

    const db = await getDatabase()
    await ensureInventoryIndexes(db)
    const stockCol = getStockCollection(db)

    const filter: Record<string, unknown> = {}
    if (productId && isObjectId(productId)) filter.productId = new ObjectId(productId)
    if (location) filter.location = location

    const [rows, products, movements] = await Promise.all([
      stockCol.find(filter).sort({ updatedAt: -1 }).toArray(),
      getProductCollection(db).find({}).toArray(),
      db.collection('stockMovements').find({}).toArray(),
    ])

    const nameById = new Map(products.map((p) => [p._id!.toString(), p.name]))
    const derived = deriveStock(
      movements.map((m) => ({ ...m, productId: m.productId.toString() })) as never
    )

    return successResponse(
      rows.map((row) => {
        const pool = derived.get(`${row.productId.toString()}|${row.location}`) ?? {
          available: 0,
          damaged: 0,
          returned: 0,
        }
        return {
          ...stockToJSON(row),
          productName: nameById.get(row.productId.toString()) ?? 'Unknown product',
          damaged: pool.damaged,
          returned: pool.returned,
        }
      })
    )
  } catch (error) {
    console.error('GET /api/stock failed:', error)
    return handleRouteError(error)
  }
}

/**
 * POST /api/stock — the ONLY typed stock number in the app: a physical count.
 *
 * Phase 5 removed the old "set quantity" upsert. A count becomes an
 * `adjustment` movement carrying the signed difference against the current
 * projection, so the ledger stays the single source of truth and every count
 * correction is visible and reversible.
 */
async function __POST(request: NextRequest) {
  try {
    const body = await request.json()
    const parsed = stockAdjustmentSchema.safeParse(body)
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const { productId, location, countedQuantity, reason, idempotencyKey } = parsed.data

    // STRICT rule (Phase 5 decision): every stock write checks the location.
    await authorizeStockWrite([location])
    const auth = await requireAuth()

    const db = await getDatabase()
    const product = await getProductCollection(db).findOne({ _id: new ObjectId(productId) } as never)
    if (!product) return notFoundError('Product not found')

    const allowNegative = await getAllowNegativeStock(db)
    const movementDate = getKarachiDate()

    const result = await runInTransaction(async (session) => {
      const oid = new ObjectId(productId)
      const row = await getStockCollection(db).findOne({ productId: oid, location } as never, { session })
      const current = row?.quantity ?? 0
      const delta = countedQuantity - current
      if (delta === 0) {
        return { kind: 'noop' as const }
      }

      const posted = await postMovement(
        db,
        {
          productId: oid,
          movementType: 'adjustment',
          quantity: Math.abs(delta),
          toLocation: location,
          fromLocation: location,
          direction: delta > 0 ? 'in' : 'out',
          referenceType: 'adjustment',
          idempotencyKey,
          notes: reason,
          date: movementDate,
          createdBy: auth.user._id as ObjectId,
          allowNegative,
        },
        session
      )

      const after = await getStockCollection(db).findOne({ productId: oid, location } as never, { session })
      return {
        kind: 'posted' as const,
        movement: posted.movement,
        created: posted.created,
        row: after,
        delta,
        previous: current,
      }
    })

    if (result.kind === 'noop') {
      return validationError('No adjustment needed', [
        { path: 'countedQuantity', message: 'Counted quantity matches the system quantity; no adjustment needed.' },
      ])
    }

    if (result.movement && result.created) {
      const meta = await getRequestMeta()
      await recordAuditEntry(db, {
        userId: auth.user._id as ObjectId,
        userEmail: auth.user.email,
        action: 'stock_adjustment_posted',
        entityType: 'stock',
        entityId: result.movement._id ?? null,
        oldValue: { location, quantity: result.previous },
        newValue: { location, quantity: result.row?.quantity ?? 0 },
        details: `Count adjustment of ${result.delta > 0 ? '+' : ''}${result.delta} for ${product.name} @ ${location}: ${reason}`,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
    }

    return successResponse({
      movement: result.movement,
      row: result.row ? stockToJSON(result.row) : null,
      replay: result.created === false,
    })
  } catch (error) {
    console.error('POST /api/stock failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
