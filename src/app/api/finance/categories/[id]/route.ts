import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { getRequestMeta, HttpError, handleRouteError, withAuth } from '@/lib/http'
import { recordAuditEntry } from '@/lib/audit'
import { validationError } from '@/lib/api-response'
import { categoryUpdateSchema } from '@/lib/schemas/finance'
import { getFinanceCategoryCollection, type FinanceCategory } from '@/lib/models/Ledger'
import { serializeCategory } from '@/lib/finance-serializers'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * PATCH /api/finance/categories/[id]
 *
 * Renames the human label or toggles a category active/inactive. The stable
 * `name` slug is immutable: transactions reference it, so renaming it would
 * orphan history. Founders edit the label instead.
 */
async function __PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('finance', 'approve')
    const { id } = await context.params
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return validationError('Invalid category id', [{ path: 'id', message: 'Malformed id' }])
    }

    const parsed = categoryUpdateSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      )
    }

    const db = await getDatabase()
    const collection = getFinanceCategoryCollection(db)
    const objectId = new ObjectId(id)

    const existing = await collection.findOne({ _id: objectId })
    if (!existing) throw new HttpError('Category not found', 404, 'NOT_FOUND')

    const update: Partial<FinanceCategory> = { updatedAt: new Date() }
    if (parsed.data.label !== undefined) update.label = parsed.data.label.trim()
    if (parsed.data.isActive !== undefined) update.isActive = parsed.data.isActive

    await collection.updateOne({ _id: objectId }, { $set: update })

    const updated = { ...existing, ...update } as FinanceCategory
    updated._id = objectId

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'category_updated',
      entityType: 'finance',
      entityId: objectId,
      oldValue: { label: existing.label, isActive: existing.isActive },
      newValue: { label: updated.label, isActive: updated.isActive },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return NextResponse.json({
      success: true,
      data: serializeCategory(updated),
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export const PATCH = withAuth(__PATCH)
