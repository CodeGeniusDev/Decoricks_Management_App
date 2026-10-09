import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { getDatabase } from '@/lib/mongodb'
import { getProductCollection, getStockCollection, productToJSON } from '@/lib/models/Product'
import { productSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { errorResponse, successResponse, validationError } from '@/lib/api-response'

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
    const search = searchParams.get('search')?.trim()
    const category = searchParams.get('category')?.trim()
    const activeRaw = searchParams.get('active')

    const db = await getDatabase()
    const products = getProductCollection(db)
    const stock = getStockCollection(db)

    const filter: Record<string, unknown> = {}
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      filter.$or = [{ name: { $regex: safe, $options: 'i' } }, { sku: { $regex: safe, $options: 'i' } }]
    }
    if (category) filter.category = category
    if (activeRaw === 'true') filter.isActive = true
    if (activeRaw === 'false') filter.isActive = false

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

/** POST /api/products — creates a product. */
async function __POST(request: NextRequest) {
  try {
    await authorize('inventory', 'create')

    const body = await request.json()
    const parsed = productSchema.safeParse(body)
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    const col = getProductCollection(db)
    const now = getKarachiDate()

    const duplicate = await col.findOne({ sku: parsed.data.sku })
    if (duplicate) {
      return validationError('SKU already exists', [{ path: 'sku', message: 'This SKU is already in use' }])
    }

    const doc = {
      ...parsed.data,
      description: parsed.data.description || undefined,
      isActive: parsed.data.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    }

    const result = await col.insertOne(doc)
    return successResponse({ ...doc, _id: result.insertedId.toString() }, 201)
  } catch (error) {
    console.error('POST /api/products failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
