import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { ensureOperationsIndexes, getSupplierCollection, supplierToJSON } from '@/lib/models/Operations'
import { supplierSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { getActor } from '@/lib/current-user'
import { recordAuditEntry } from '@/lib/audit'
import { errorResponse, successResponse, validationError } from '@/lib/api-response'

/** GET /api/suppliers — query params: search, city, active */
async function __GET(request: NextRequest) {
  try {
    await authorize('suppliers', 'view')

    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')?.trim()
    const city = searchParams.get('city')?.trim()
    const active = searchParams.get('active')

    const db = await getDatabase()
    const col = getSupplierCollection(db)

    const filter: Record<string, unknown> = {}
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { contactPerson: { $regex: safe, $options: 'i' } },
        { productsSupplied: { $regex: safe, $options: 'i' } },
      ]
    }
    if (city) filter.city = city
    if (active === 'true') filter.isActive = true
    if (active === 'false') filter.isActive = false

    const docs = await col.find(filter).sort({ createdAt: -1 }).toArray()
    return successResponse(docs.map(supplierToJSON))
  } catch (error) {
    console.error('GET /api/suppliers failed:', error)
    return handleRouteError(error)
  }
}

/** POST /api/suppliers */
async function __POST(request: NextRequest) {
  try {
    const auth = await authorize('suppliers', 'create')

    const parsed = supplierSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    const col = getSupplierCollection(db)
    // Creates the unique supplier-name index. Without this a duplicate name can
    // slip through the check below on a concurrent insert.
    await ensureOperationsIndexes(db)
    const now = getKarachiDate()

    // Case-insensitive duplicate guard on supplier name.
    const clash = await col.findOne({ name: { $regex: `^${parsed.data.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } } as never)
    if (clash) {
      return validationError('Supplier already exists', [
        { path: 'name', message: 'A supplier with this name already exists' },
      ])
    }

    const doc = {
      name: parsed.data.name,
      contactPerson: parsed.data.contactPerson || undefined,
      phone: parsed.data.phone || undefined,
      email: parsed.data.email || undefined,
      city: parsed.data.city,
      address: parsed.data.address || undefined,
      productsSupplied: parsed.data.productsSupplied,
      notes: parsed.data.notes || undefined,
      isActive: parsed.data.isActive ?? true,
      createdAt: now,
      updatedAt: now,
      createdBy: (await getActor()).id,
    }

    const result = await col.insertOne(doc as never)
    const created = { ...doc, _id: result.insertedId }

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'supplier_created',
      entityType: 'supplier',
      entityId: result.insertedId,
      newValue: supplierToJSON(created),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    return successResponse(supplierToJSON(created), 201)
  } catch (error) {
    console.error('POST /api/suppliers failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
