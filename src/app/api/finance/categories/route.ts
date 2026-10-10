import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { getRequestMeta, HttpError, handleRouteError, withAuth } from '@/lib/http'
import { recordAuditEntry } from '@/lib/audit'
import { successResponse, validationError } from '@/lib/api-response'
import { categoryCreateSchema } from '@/lib/schemas/finance'
import { getFinanceCategoryCollection, type FinanceCategory } from '@/lib/models/Ledger'
import { serializeCategory } from '@/lib/finance-serializers'

/** GET /api/finance/categories — every category (active and inactive). */
async function __GET() {
  try {
    await authorize('finance', 'view')
    const db = await getDatabase()
    const categories = await getFinanceCategoryCollection(db)
      .find({})
      .sort({ type: 1, label: 1 })
      .toArray()
    return successResponse(categories.map(serializeCategory))
  } catch (error) {
    return handleRouteError(error)
  }
}

/** POST /api/finance/categories — Founder-only category management. */
async function __POST(request: NextRequest) {
  try {
    const auth = await authorize('finance', 'approve')
    const parsed = categoryCreateSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      )
    }

    const db = await getDatabase()
    const collection = getFinanceCategoryCollection(db)
    const name = parsed.data.name.trim().toLowerCase()

    const existing = await collection.findOne({ name })
    if (existing) throw new HttpError('A category with that name already exists', 409, 'DUPLICATE')

    const now = new Date()
    const doc: FinanceCategory = {
      name,
      label: parsed.data.label.trim(),
      type: parsed.data.type,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: auth.user._id as ObjectId,
    }

    const result = await collection.insertOne(doc)
    doc._id = result.insertedId

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'category_created',
      entityType: 'finance',
      entityId: result.insertedId,
      newValue: { name: doc.name, label: doc.label, type: doc.type },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return NextResponse.json(
      { success: true, data: serializeCategory(doc), timestamp: new Date().toISOString() },
      { status: 201 }
    )
  } catch (error) {
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
