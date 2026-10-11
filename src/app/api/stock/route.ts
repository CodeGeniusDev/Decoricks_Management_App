import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize, authorizeStockWrite, requireAuth } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getProductCollection, getStockCollection, stockToJSON } from '@/lib/models/Product'
import { stockSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { recordAuditEntry } from '@/lib/audit'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

/**
 * GET /api/stock
 *
 * Stock rows joined to their product names, so the Stock Levels table needs a
 * single request.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('inventory', 'view')

    const { searchParams } = new URL(request.url)
    const productId = searchParams.get('productId')
    const location = searchParams.get('location')

    const db = await getDatabase()
    const stockCol = getStockCollection(db)

    const filter: Record<string, unknown> = {}
    if (productId && isObjectId(productId)) filter.productId = new ObjectId(productId)
    if (location) filter.location = location

    const [rows, products] = await Promise.all([
      stockCol.find(filter).sort({ updatedAt: -1 }).toArray(),
      getProductCollection(db).find({}).toArray(),
    ])

    const nameById = new Map(products.map((p) => [p._id!.toString(), p.name]))

    return successResponse(
      rows.map((row) => ({
        ...stockToJSON(row),
        productName: nameById.get(row.productId.toString()) ?? 'Unknown product',
      }))
    )
  } catch (error) {
    console.error('GET /api/stock failed:', error)
    return handleRouteError(error)
  }
}

/**
 * POST /api/stock
 *
 * Sets the quantity for a product at a location (upsert), which is what the
 * inventory "Add Product" and stock-edit forms do.
 *
 * SPEC §4.2 Inventory row marks `create`/`edit` as "❌ (except Lahore stock)"
 * for Hasnat and Ali, so this endpoint authorises on the *location* rather than
 * the generic grant alone. The check has to read the parsed body, which is why
 * it cannot be the one-line guard used elsewhere.
 */
async function __POST(request: NextRequest) {
  try {
    const body = await request.json()
    const parsed = stockSchema.safeParse(body)
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const location = parsed.data.location
    await authorizeStockWrite([location])

    const db = await getDatabase()
    const productId = new ObjectId(parsed.data.productId)
    const now = getKarachiDate()

    const product = await getProductCollection(db).findOne({ _id: productId } as never)
    if (!product) return notFoundError('Product not found')

    const stockCol = getStockCollection(db)
    const before = await stockCol.findOne({ productId, location } as never)
    const result = await stockCol.updateOne(
      { productId, location } as never,
      { $set: { quantity: parsed.data.quantity, lastUpdated: now, updatedAt: now } } as never,
      { upsert: true }
    )

    const row = await stockCol.findOne({ productId, location } as never)

    const auth = await requireAuth()
    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: result.upsertedCount ? 'stock_created' : 'stock_updated',
      entityType: 'stock',
      entityId: row?._id ?? null,
      oldValue: before ? { location, quantity: before.quantity } : undefined,
      newValue: { location, quantity: parsed.data.quantity },
      details: `${product.name} @ ${location}`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    return successResponse(stockToJSON(row!), result.upsertedCount ? 201 : 200)
  } catch (error) {
    console.error('POST /api/stock failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
