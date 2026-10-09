import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getSupplierCollection, supplierToJSON } from '@/lib/models/Operations'
import { supplierSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)
const badId = () => validationError('Invalid supplier id', [{ path: 'id', message: 'Malformed id' }])

/** GET /api/suppliers/[id] */
async function __GET(_request: NextRequest, context: RouteContext) {
  try {
    await authorize('suppliers', 'view')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const doc = await getSupplierCollection(db).findOne({ _id: new ObjectId(id) } as never)
    if (!doc) return notFoundError('Supplier not found')

    return successResponse(supplierToJSON(doc))
  } catch (error) {
    console.error('GET /api/suppliers/[id] failed:', error)
    return handleRouteError(error)
  }
}

/** PUT /api/suppliers/[id] */
async function __PUT(request: NextRequest, context: RouteContext) {
  try {
    await authorize('suppliers', 'edit')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const parsed = supplierSchema.partial().safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    const col = getSupplierCollection(db)
    const _id = new ObjectId(id)

    if (parsed.data.name) {
      const clash = await col.findOne({
        name: { $regex: `^${parsed.data.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
        _id: { $ne: _id },
      } as never)
      if (clash) {
        return validationError('Supplier already exists', [
          { path: 'name', message: 'A supplier with this name already exists' },
        ])
      }
    }

    const result = await col.updateOne(
      { _id } as never,
      { $set: { ...parsed.data, updatedAt: getKarachiDate() } } as never
    )
    if (result.matchedCount === 0) return notFoundError('Supplier not found')

    const updated = await col.findOne({ _id } as never)
    return successResponse(supplierToJSON(updated!))
  } catch (error) {
    console.error('PUT /api/suppliers/[id] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * DELETE /api/suppliers/[id]
 *
 * Suppliers referenced by expense records are deactivated instead of removed so
 * historical data keeps a valid reference.
 */
async function __DELETE(_request: NextRequest, context: RouteContext) {
  try {
    await authorize('suppliers', 'delete')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const col = getSupplierCollection(db)
    const _id = new ObjectId(id)

    const existing = await col.findOne({ _id } as never)
    if (!existing) return notFoundError('Supplier not found')

    const expenseRef = await db
      .collection('expenses')
      .countDocuments({ vendorId: id } as never)
      .catch(() => 0)

    if (expenseRef > 0) {
      await col.updateOne({ _id } as never, { $set: { isActive: false, updatedAt: getKarachiDate() } } as never)
      const updated = await col.findOne({ _id } as never)
      return successResponse({
        ...supplierToJSON(updated!),
        deactivated: true,
        message: `Referenced by ${expenseRef} expense record(s), so it was deactivated instead of deleted.`,
      })
    }

    await col.deleteOne({ _id } as never)
    return successResponse({ _id: id })
  } catch (error) {
    console.error('DELETE /api/suppliers/[id] failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const PUT = withAuth(__PUT)
export const DELETE = withAuth(__DELETE)
