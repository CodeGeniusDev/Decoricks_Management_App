import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getProductCollection, getStockCollection, productToJSON } from '@/lib/models/Product'
import { productSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { recordAuditEntry } from '@/lib/audit'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

const badId = () => validationError('Invalid product id', [{ path: 'id', message: 'Malformed id' }])

/** GET /api/products/[id] */
async function __GET(_request: NextRequest, context: RouteContext) {
  try {
    await authorize('inventory', 'view')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const doc = await getProductCollection(db).findOne({ _id: new ObjectId(id) } as never)
    if (!doc) return notFoundError('Product not found')

    return successResponse(productToJSON(doc))
  } catch (error) {
    console.error('GET /api/products/[id] failed:', error)
    return handleRouteError(error)
  }
}

/** PUT /api/products/[id] */
async function __PUT(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('inventory', 'edit')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const body = await request.json()
    const parsed = productSchema.partial().safeParse(body)
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    const col = getProductCollection(db)
    const _id = new ObjectId(id)

    const before = await col.findOne({ _id } as never)
    if (!before) return notFoundError('Product not found')

    if (parsed.data.sku) {
      const clash = await col.findOne({ sku: parsed.data.sku, _id: { $ne: _id } } as never)
      if (clash) {
        return validationError('SKU already exists', [{ path: 'sku', message: 'This SKU is already in use' }])
      }
    }

    const result = await col.updateOne(
      { _id } as never,
      { $set: { ...parsed.data, updatedAt: getKarachiDate() } } as never
    )
    if (result.matchedCount === 0) return notFoundError('Product not found')

    const updated = await col.findOne({ _id } as never)
    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'product_updated',
      entityType: 'product',
      entityId: _id,
      oldValue: productToJSON(before),
      newValue: updated ? productToJSON(updated) : undefined,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    return successResponse(productToJSON(updated!))
  } catch (error) {
    console.error('PUT /api/products/[id] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * DELETE /api/products/[id]
 *
 * Refuses while stock remains, so deleting a product can never orphan or
 * silently discard real stock records.
 */
async function __DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('inventory', 'delete')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const _id = new ObjectId(id)

    const productCol = getProductCollection(db)
    const before = await productCol.findOne({ _id } as never)
    if (!before) return notFoundError('Product not found')

    const stockCol = getStockCollection(db)
    const stockRows = await stockCol.find({ productId: _id } as never).toArray()
    const total = stockRows.reduce((sum, s) => sum + s.quantity, 0)

    if (total > 0) {
      return validationError('Product still has stock', [
        { path: 'stock', message: `Remove the remaining ${total} unit(s) before deleting this product` },
      ])
    }

    if (stockRows.length > 0) await stockCol.deleteMany({ productId: _id } as never)

    const result = await productCol.deleteOne({ _id } as never)
    if (result.deletedCount === 0) return notFoundError('Product not found')

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'product_deleted',
      entityType: 'product',
      entityId: _id,
      oldValue: productToJSON(before),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    return successResponse({ _id: id })
  } catch (error) {
    console.error('DELETE /api/products/[id] failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const PUT = withAuth(__PUT)
export const DELETE = withAuth(__DELETE)
