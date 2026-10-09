import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/mongodb'
import {
  getIncomeCollection,
  getExpenseCollection,
  getTransferCollection,
  type Income,
  type Expense,
  type Transfer,
} from '@/lib/models/Finance'
import { incomeSchema, expenseSchema, transferSchema } from '@/lib/schemas/finance'
import { getKarachiDate } from '@/lib/date'
import { errorResponse, validationError, notFoundError } from '@/lib/api-response'
import { ObjectId, type Collection } from 'mongodb'

type FinanceType = 'income' | 'expense' | 'transfer'

type RouteContext = { params: Promise<{ type: string; id: string }> }

function isFinanceType(value: string): value is FinanceType {
  return value === 'income' || value === 'expense' || value === 'transfer'
}

function resolveCollection(db: Awaited<ReturnType<typeof getDatabase>>, type: FinanceType) {
  if (type === 'income') return getIncomeCollection(db)
  if (type === 'expense') return getExpenseCollection(db)
  return getTransferCollection(db)
}

function toObjectId(id: string): ObjectId | null {
  return /^[0-9a-fA-F]{24}$/.test(id) ? new ObjectId(id) : null
}

function zodDetails(error: { errors: Array<{ path: (string | number)[]; message: string }> }) {
  return error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
}

/**
 * PUT /api/finance/[type]/[id]
 *
 * `type` and `id` come from the route path — they must never be read from the
 * request body, otherwise every update returned 400 and the UI silently failed
 * to save edits.
 */
async function __PUT(request: NextRequest, context: RouteContext) {
  try {
    await authorize('finance', 'edit')

    const { type, id } = await context.params

    if (!isFinanceType(type)) {
      return validationError(`Invalid finance type: ${type}`, [
        { path: 'type', message: 'Must be income, expense or transfer' },
      ])
    }

    const _id = toObjectId(id)
    if (!_id) {
      return validationError('Invalid record id', [{ path: 'id', message: 'Malformed ObjectId' }])
    }

    const body = await request.json()
    // Strip routing keys if a client echoes them back in the body.
    const { type: _ignoredType, id: _ignoredId, ...data } = body ?? {}

    const db = await getDatabase()
    const now = getKarachiDate()
    const col = resolveCollection(db, type)

    const existing = await col.findOne({ _id } as never)
    if (!existing) {
      return notFoundError(`${type} record not found`)
    }

    if (type === 'income') {
      const parsed = incomeSchema.safeParse(data)
      if (!parsed.success) return validationError('Validation failed', zodDetails(parsed.error))
      const validated = parsed.data

      const result = await (col as Collection<Income>).updateOne(
        { _id } as never,
        {
          $set: {
            amount: validated.amount,
            category: validated.category,
            source: validated.source,
            description: validated.description,
            referenceId: validated.referenceId ? new ObjectId(validated.referenceId) : undefined,
            referenceType: validated.referenceType,
            date: new Date(validated.date),
            updatedAt: now,
          },
        } as never
      )

      if (result.matchedCount === 0) return notFoundError('Income record not found')

      return NextResponse.json({
        success: true,
        data: { _id: id, type: 'income', ...validated },
        timestamp: new Date().toISOString(),
      })
    }

    if (type === 'expense') {
      const parsed = expenseSchema.safeParse(data)
      if (!parsed.success) return validationError('Validation failed', zodDetails(parsed.error))
      const validated = parsed.data

      const result = await (col as Collection<Expense>).updateOne(
        { _id } as never,
        {
          $set: {
            amount: validated.amount,
            category: validated.category,
            vendorId: validated.vendorId ? new ObjectId(validated.vendorId) : undefined,
            description: validated.description,
            referenceId: validated.referenceId ? new ObjectId(validated.referenceId) : undefined,
            referenceType: validated.referenceType,
            date: new Date(validated.date),
            updatedAt: now,
          },
        } as never
      )

      if (result.matchedCount === 0) return notFoundError('Expense record not found')

      return NextResponse.json({
        success: true,
        data: { _id: id, type: 'expense', ...validated },
        timestamp: new Date().toISOString(),
      })
    }

    const parsed = transferSchema.safeParse(data)
    if (!parsed.success) return validationError('Validation failed', zodDetails(parsed.error))
    const validated = parsed.data

    const result = await (col as Collection<Transfer>).updateOne(
      { _id } as never,
      {
        $set: {
          fromAccount: validated.fromAccount,
          toAccount: validated.toAccount,
          amount: validated.amount,
          description: validated.description,
          date: new Date(validated.date),
          updatedAt: now,
        },
      } as never
    )

    if (result.matchedCount === 0) return notFoundError('Transfer record not found')

    return NextResponse.json({
      success: true,
      data: { _id: id, type: 'transfer', ...validated },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('PUT /api/finance/[type]/[id] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * DELETE /api/finance/[type]/[id]
 *
 * Reads the record type and id from the route path (query params are ignored).
 */
async function __DELETE(request: NextRequest, context: RouteContext) {
  try {
    await authorize('finance', 'delete')

    const { type, id } = await context.params

    if (!isFinanceType(type)) {
      return validationError(`Invalid finance type: ${type}`, [
        { path: 'type', message: 'Must be income, expense or transfer' },
      ])
    }

    const _id = toObjectId(id)
    if (!_id) {
      return validationError('Invalid record id', [{ path: 'id', message: 'Malformed ObjectId' }])
    }

    const db = await getDatabase()
    const col = resolveCollection(db, type)

    const result = await col.deleteOne({ _id } as never)

    if (result.deletedCount === 0) {
      return notFoundError(`${type} record not found`)
    }

    return NextResponse.json({
      success: true,
      data: { _id: id, type },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('DELETE /api/finance/[type]/[id] failed:', error)
    return handleRouteError(error)
  }
}

export const PUT = withAuth(__PUT)
export const DELETE = withAuth(__DELETE)
