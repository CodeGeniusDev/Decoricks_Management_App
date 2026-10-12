import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getProductCollection, getStockCollection, productToJSON, ensureProductIndexes } from '@/lib/models/Product'
import { productSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { recordAuditEntry } from '@/lib/audit'
import { errorResponse, successResponse, validationError } from '@/lib/api-response'
import { buildProductFilter, productParamsFromUrl } from '@/lib/inventory-sales-filters'

/**
 * GET /api/products
 *
 * Returns products together with their per-location stock so the inventory
 * table can render both from a single request (previously the page shipped
 * hardcoded product and stock rows).
 *
 * Query params:
 *   search   case-insensitive match on name or sku
 *   category filter by exact category
 *   active   'true' | 'false' to filter by isActive (default: all)
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('inventory', 'view')

    const { searchParams } = new URL(request.url)

    const db = await getDatabase()
    await ensureProductIndexes(db)
    const products = getProductCollection(db)
    const stock = getStockCollection(db)

    // The same builder backs `/api/products/export`, so the CSV always contains
    // the rows the screen is showing.
    const filter = buildProductFilter(productParamsFromUrl(new URL(request.url)))

    const [docs, stockRows] = await Promise.all([
      products.find(filter).sort({ createdAt: -1 }).toArray(),
      stock.find({}).toArray(),
    ])

    // Index stock by product id once instead of per product.
    const stockByProduct = new Map<string, Record<string, number>>()
    for (const row of stockRows) {
      const key = row.productId.toString()
      const bucket = stockByProduct.get(key) ?? {}
      bucket[row.location] = row.quantity
      stockByProduct.set(key, bucket)
    }

    return successResponse(
      docs.map((p) => {
        const id = p._id?.toString() ?? ''
        const levels = stockByProduct.get(id) ?? {}
        return {
          ...productToJSON(p),
          totalQuantity: Object.values(levels).reduce((a, b) => a + b, 0),
          stockByLocation: levels,
        }
      })
    )
  } catch (error) {
    console.error('GET /api/products failed:', error)
    return handleRouteError(error)
  }
}

/**
 * POST /api/products — creates a product.
 *
 * Phase 5 rules: SKU uniqueness is enforced by the unique index (a
 * read-then-write check alone loses under concurrency), and the endpoint
 * accepts an idempotency key so a retried create returns the original instead
 * of failing on a duplicate SKU.
 */
async function __POST(request: NextRequest) {
  try {
    const auth = await authorize('inventory', 'create')

    const body = await request.json()
    const parsed = productSchema.safeParse(body)
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    await ensureProductIndexes(db)
    const col = getProductCollection(db)
    const now = getKarachiDate()

    if (parsed.data.idempotencyKey) {
      const replay = await col.findOne({ idempotencyKey: parsed.data.idempotencyKey } as never)
      if (replay) return successResponse(productToJSON(replay))
    }

    const duplicate = await col.findOne({ sku: parsed.data.sku })
    if (duplicate) {
      return validationError('SKU already exists', [{ path: 'sku', message: 'This SKU is already in use' }])
    }

    const { idempotencyKey, ...fields } = parsed.data
    const doc = {
      ...fields,
      description: parsed.data.description || undefined,
      isActive: parsed.data.isActive ?? true,
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    }

    let result
    try {
      result = await col.insertOne(doc as never)
    } catch (error) {
      const code = (error as { code?: number })?.code
      if (code === 11000) {
        // Concurrent duplicate: SKU clash or a replayed idempotency key.
        if (idempotencyKey) {
          const existing = await col.findOne({ idempotencyKey } as never)
          if (existing) return successResponse(productToJSON(existing))
        }
        return validationError('SKU already exists', [
          { path: 'sku', message: 'This SKU is already in use' },
        ])
      }
      throw error
    }
    const created = { ...doc, _id: result.insertedId }

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'product_created',
      entityType: 'product',
      entityId: result.insertedId,
      newValue: productToJSON(created),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    return successResponse(productToJSON(created), 201)
  } catch (error) {
    console.error('POST /api/products failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
