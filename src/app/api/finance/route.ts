import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/mongodb'
import {
  getIncomeCollection,
  getExpenseCollection,
  getTransferCollection,
  ensureFinanceIndexes,
} from '@/lib/models/Finance'
import { incomeSchema, expenseSchema, transferSchema } from '@/lib/schemas/finance'
import { getKarachiDate } from '@/lib/date'
import { formatPaisa } from '@/lib/money'
import { errorResponse, validationError } from '@/lib/api-response'
import { ObjectId, type Filter } from 'mongodb'

/**
 * GET /api/finance
 *
 * Lists financial entries. The client (useFinanceData) calls this on mount and
 * after every mutation, so it must exist for the Finance module to show data.
 *
 * Query params:
 *   type     income | expense | transfer | all   (default: all)
 *   page     1-based page number                (default: 1)
 *   limit    page size, max 200                 (default: 50)
 *   category filter by category
 *   startDate / endDate  ISO date range filters
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('finance', 'view')

    const { searchParams } = new URL(request.url)

    const type = (searchParams.get('type') || 'all').toLowerCase()
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '50', 10) || 50))
    const category = searchParams.get('category') || undefined
    const startDateRaw = searchParams.get('startDate')
    const endDateRaw = searchParams.get('endDate')

    const startDate = startDateRaw ? new Date(startDateRaw) : undefined
    const endDate = endDateRaw ? new Date(endDateRaw) : undefined

    if ((startDateRaw && isNaN(startDate!.getTime())) || (endDateRaw && isNaN(endDate!.getTime()))) {
      return validationError('Invalid date filter', [
        { path: startDateRaw ? 'startDate' : 'endDate', message: 'Must be a valid ISO date' },
      ])
    }

    const db = await getDatabase()

    const dateFilter: Record<string, Date> = {}
    if (startDate) dateFilter.$gte = startDate
    if (endDate) dateFilter.$lte = endDate

    const buildFilter = (
      extra: Record<string, unknown> = {}
    ): Filter<Record<string, unknown>> => {
      const filter: Record<string, unknown> = { ...extra }
      if (category) filter.category = category
      if (Object.keys(dateFilter).length > 0) filter.date = dateFilter
      return filter as Filter<Record<string, unknown>>
    }

    const wantsIncome = type === 'all' || type === 'income'
    const wantsExpense = type === 'all' || type === 'expense'
    const wantsTransfer = type === 'all' || type === 'transfer'

    const [incomePage, expensePage, transferPage] = await Promise.all([
      wantsIncome
        ? (async () => {
            const col = getIncomeCollection(db)
            const [items, total] = await Promise.all([
              col
                .find(buildFilter())
                .sort({ date: -1, createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .toArray(),
              col.countDocuments(buildFilter()),
            ])
            return {
              items: items.map((i) => ({
                _id: i._id?.toString(),
                incomeNumber: i.incomeNumber,
                amount: i.amount,
                amountDisplay: formatPaisa(i.amount),
                category: i.category,
                source: i.source,
                description: i.description,
                date: i.date,
                createdAt: i.createdAt,
                type: 'income' as const,
              })),
              pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
            }
          })()
        : Promise.resolve(null),
      wantsExpense
        ? (async () => {
            const col = getExpenseCollection(db)
            const [items, total] = await Promise.all([
              col
                .find(buildFilter())
                .sort({ date: -1, createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .toArray(),
              col.countDocuments(buildFilter()),
            ])
            return {
              items: items.map((e) => ({
                _id: e._id?.toString(),
                expenseNumber: e.expenseNumber,
                amount: e.amount,
                amountDisplay: formatPaisa(e.amount),
                category: e.category,
                description: e.description,
                date: e.date,
                createdAt: e.createdAt,
                type: 'expense' as const,
              })),
              pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
            }
          })()
        : Promise.resolve(null),
      wantsTransfer
        ? (async () => {
            const col = getTransferCollection(db)
            const [items, total] = await Promise.all([
              col
                .find(buildFilter())
                .sort({ date: -1, createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .toArray(),
              col.countDocuments(buildFilter()),
            ])
            return {
              items: items.map((t) => ({
                _id: t._id?.toString(),
                transferNumber: t.transferNumber,
                fromAccount: t.fromAccount,
                toAccount: t.toAccount,
                amount: t.amount,
                amountDisplay: formatPaisa(t.amount),
                description: t.description,
                date: t.date,
                createdAt: t.createdAt,
                type: 'transfer' as const,
              })),
              pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
            }
          })()
        : Promise.resolve(null),
    ])

    return NextResponse.json({
      success: true,
      data: {
        income: incomePage,
        expenses: expensePage,
        transfers: transferPage,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('GET /api/finance failed:', error)
    return errorResponse(
      error instanceof Error ? error.message : 'Internal server error',
      500
    )
  }
}

/**
 * POST /api/finance
 *
 * Creates income / expense / transfer records. `clientRequestId` is optional and
 * acts as an idempotency key: repeating a request that carries an id already
 * stored against that record type returns the original record instead of writing
 * a duplicate.
 */
async function __POST(request: NextRequest) {
  try {
    await authorize('finance', 'create')

    const body = await request.json()
    const { type, ...data } = body

    // Validate before touching Mongo: a malformed request should be a 400
    // whether or not the database happens to be reachable.
    if (type !== 'income' && type !== 'expense' && type !== 'transfer') {
      return validationError(`Invalid finance type. Must be 'income', 'expense', or 'transfer'.`, [
        { path: 'type', message: 'Unsupported entry type' },
      ])
    }

    const dummyUserId = '507f1f77bcf86cd799439011' // dev placeholder

    // Each branch validates its own payload before connecting to Mongo, so a
    // malformed request is a 400 whether or not the database is reachable, and
    // `validated` stays narrowed to that branch's schema.
    if (type === 'income') {
      const parsed = incomeSchema.safeParse(data)
      if (!parsed.success) {
        return validationError(
          'Validation failed',
          parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
        )
      }
      const validated = parsed.data

      const db = await getDatabase()
      const now = getKarachiDate()
      await ensureFinanceIndexes(db)
      const incomeCol = getIncomeCollection(db)

      const existing = await findByClientRequestId(incomeCol, data.clientRequestId)
      if (existing) {
        return NextResponse.json(
          {
            success: true,
            data: serializeIncome(existing),
            timestamp: new Date().toISOString(),
          },
          { status: 200 }
        )
      }

      const count = await incomeCol.countDocuments()
      const incomeNumber = `INC-${String(count + 1).padStart(5, '0')}`

      const doc = {
        incomeNumber,
        amount: validated.amount,
        category: validated.category,
        source: validated.source,
        description: validated.description,
        referenceId: validated.referenceId ? new ObjectId(validated.referenceId) : undefined,
        referenceType: validated.referenceType,
        clientRequestId: typeof data.clientRequestId === 'string' ? data.clientRequestId : undefined,
        date: new Date(validated.date),
        createdAt: now,
        updatedAt: now,
        createdBy: new ObjectId(dummyUserId),
      }

      let result
      try {
        result = await incomeCol.insertOne(doc as any)
      } catch (insertError) {
        // Lost an idempotency race: the unique index rejected a duplicate
        // clientRequestId, so return the record that won instead of 500ing.
        if (isDuplicateKeyError(insertError)) {
          const raced = await findByClientRequestId(incomeCol, data.clientRequestId)
          if (raced) {
            return NextResponse.json(
              { success: true, data: serializeIncome(raced), timestamp: new Date().toISOString() },
              { status: 200 }
            )
          }
        }
        throw insertError
      }

      return NextResponse.json(
        {
          success: true,
          data: serializeIncome({
            _id: result.insertedId,
            incomeNumber,
            ...validated,
            date: new Date(validated.date),
            createdAt: now,
          }),
          timestamp: new Date().toISOString(),
        },
        { status: 201 }
      )
    }

    if (type === 'expense') {
      const parsed = expenseSchema.safeParse(data)
      if (!parsed.success) {
        return validationError(
          'Validation failed',
          parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
        )
      }
      const validated = parsed.data

      const db = await getDatabase()
      const now = getKarachiDate()
      await ensureFinanceIndexes(db)
      const expenseCol = getExpenseCollection(db)

      const existing = await findByClientRequestId(expenseCol, data.clientRequestId)
      if (existing) {
        return NextResponse.json(
          {
            success: true,
            data: serializeExpense(existing),
            timestamp: new Date().toISOString(),
          },
          { status: 200 }
        )
      }

      const count = await expenseCol.countDocuments()
      const expenseNumber = `EXP-${String(count + 1).padStart(5, '0')}`

      const doc = {
        expenseNumber,
        amount: validated.amount,
        category: validated.category,
        vendorId: validated.vendorId ? new ObjectId(validated.vendorId) : undefined,
        description: validated.description,
        referenceId: validated.referenceId ? new ObjectId(validated.referenceId) : undefined,
        referenceType: validated.referenceType,
        clientRequestId: typeof data.clientRequestId === 'string' ? data.clientRequestId : undefined,
        date: new Date(validated.date),
        createdAt: now,
        updatedAt: now,
        createdBy: new ObjectId(dummyUserId),
      }

      let result
      try {
        result = await expenseCol.insertOne(doc as any)
      } catch (insertError) {
        // Lost an idempotency race: the unique index rejected a duplicate
        // clientRequestId, so return the record that won instead of 500ing.
        if (isDuplicateKeyError(insertError)) {
          const raced = await findByClientRequestId(expenseCol, data.clientRequestId)
          if (raced) {
            return NextResponse.json(
              { success: true, data: serializeExpense(raced), timestamp: new Date().toISOString() },
              { status: 200 }
            )
          }
        }
        throw insertError
      }

      return NextResponse.json(
        {
          success: true,
          data: serializeExpense({
            _id: result.insertedId,
            expenseNumber,
            ...validated,
            date: new Date(validated.date),
            createdAt: now,
          }),
          timestamp: new Date().toISOString(),
        },
        { status: 201 }
      )
    }

    if (type === 'transfer') {
      const parsed = transferSchema.safeParse(data)
      if (!parsed.success) {
        return validationError(
          'Validation failed',
          parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
        )
      }
      const validated = parsed.data

      const db = await getDatabase()
      const now = getKarachiDate()
      await ensureFinanceIndexes(db)
      const transferCol = getTransferCollection(db)

      const existing = await findByClientRequestId(transferCol, data.clientRequestId)
      if (existing) {
        return NextResponse.json(
          {
            success: true,
            data: serializeTransfer(existing),
            timestamp: new Date().toISOString(),
          },
          { status: 200 }
        )
      }

      const count = await transferCol.countDocuments()
      const transferNumber = `TRF-${String(count + 1).padStart(5, '0')}`

      const doc = {
        transferNumber,
        fromAccount: validated.fromAccount,
        toAccount: validated.toAccount,
        amount: validated.amount,
        description: validated.description,
        clientRequestId: typeof data.clientRequestId === 'string' ? data.clientRequestId : undefined,
        date: new Date(validated.date),
        createdAt: now,
        updatedAt: now,
        createdBy: new ObjectId(dummyUserId),
      }

      let result
      try {
        result = await transferCol.insertOne(doc as any)
      } catch (insertError) {
        // Lost an idempotency race: the unique index rejected a duplicate
        // clientRequestId, so return the record that won instead of 500ing.
        if (isDuplicateKeyError(insertError)) {
          const raced = await findByClientRequestId(transferCol, data.clientRequestId)
          if (raced) {
            return NextResponse.json(
              { success: true, data: serializeTransfer(raced), timestamp: new Date().toISOString() },
              { status: 200 }
            )
          }
        }
        throw insertError
      }

      return NextResponse.json(
        {
          success: true,
          data: serializeTransfer({
            _id: result.insertedId,
            transferNumber,
            ...validated,
            date: new Date(validated.date),
            createdAt: now,
          }),
          timestamp: new Date().toISOString(),
        },
        { status: 201 }
      )
    }

    // Unreachable: `type` is validated above. Kept as a guard so a future
    // schema change cannot silently fall through to a 200 with no record.
    return validationError('Unsupported entry type', [
      { path: 'type', message: 'Unsupported entry type' },
    ])
  } catch (error) {
    console.error('POST /api/finance failed:', error)
    return handleRouteError(error)
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000
}

async function findByClientRequestId<T extends { clientRequestId?: string }>(
  col: { findOne: (filter: unknown) => Promise<T | null> },
  clientRequestId: unknown
): Promise<T | null> {
  if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) return null
  return col.findOne({ clientRequestId })
}

function serializeIncome(doc: Record<string, any>) {
  return {
    _id: doc._id?.toString(),
    incomeNumber: doc.incomeNumber,
    amount: doc.amount,
    amountDisplay: formatPaisa(doc.amount),
    category: doc.category,
    source: doc.source,
    description: doc.description,
    date: doc.date,
    createdAt: doc.createdAt,
    type: 'income' as const,
  }
}

function serializeExpense(doc: Record<string, any>) {
  return {
    _id: doc._id?.toString(),
    expenseNumber: doc.expenseNumber,
    amount: doc.amount,
    amountDisplay: formatPaisa(doc.amount),
    category: doc.category,
    description: doc.description,
    date: doc.date,
    createdAt: doc.createdAt,
    type: 'expense' as const,
  }
}

function serializeTransfer(doc: Record<string, any>) {
  return {
    _id: doc._id?.toString(),
    transferNumber: doc.transferNumber,
    fromAccount: doc.fromAccount,
    toAccount: doc.toAccount,
    amount: doc.amount,
    amountDisplay: formatPaisa(doc.amount),
    description: doc.description,
    date: doc.date,
    createdAt: doc.createdAt,
    type: 'transfer' as const,
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
