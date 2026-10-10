import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { getRequestMeta, handleRouteError, withAuth } from '@/lib/http'
import { successResponse, validationError } from '@/lib/api-response'
import { ledgerEntrySchema, transactionQuerySchema } from '@/lib/schemas/finance'
import {
  buildLedgerFilter,
  buildSerializeContext,
  createLedgerEntry,
  listLedger,
  loadAccounts,
  loadCategories,
  serializeEntry,
  type ActorContext,
} from '@/lib/finance-ledger'

/**
 * GET /api/finance/transactions
 *
 * Paginated, filtered ledger with totals, averages and day/week/month figures.
 * Every read requires `finance.view`.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('finance', 'view')

    const params = Object.fromEntries(new URL(request.url).searchParams.entries())
    const parsed = transactionQuerySchema.safeParse(params)
    if (!parsed.success) {
      return validationError(
        'Invalid query',
        parsed.error.errors.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        }))
      )
    }

    const db = await getDatabase()
    const { filter, range } = buildLedgerFilter(parsed.data)
    const result = await listLedger(db, {
      filter,
      range,
      page: parsed.data.page,
      limit: parsed.data.limit,
    })

    return successResponse(result)
  } catch (error) {
    return handleRouteError(error)
  }
}

/**
 * POST /api/finance/transactions
 *
 * Creates a ledger entry. Withdrawals are additionally gated on
 * `finance.approve` (Founder by default) and the withdrawal-lock setting; every
 * other type needs `finance.create`.
 */
async function __POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null)
    if (body === null || typeof body !== 'object') {
      return validationError('A JSON body is required')
    }

    const type = (body as { type?: unknown }).type
    if (type === 'partner_withdrawal') {
      await authorize('finance', 'approve')
    } else {
      await authorize('finance', 'create')
    }

    const parsed = ledgerEntrySchema.safeParse(body)
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        }))
      )
    }

    const db = await getDatabase()
    const meta = await getRequestMeta()
    const auth = await authorize(
      'finance',
      parsed.data.type === 'partner_withdrawal' ? 'approve' : 'create'
    )

    const actor: ActorContext = {
      id: auth.user._id as ObjectId,
      name: auth.user.name,
      email: auth.user.email,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    }

    const { doc, created } = await createLedgerEntry(db, parsed.data, actor)

    const [accounts, categories] = await Promise.all([loadAccounts(db), loadCategories(db)])
    const ctx = buildSerializeContext(accounts, categories)

    return NextResponse.json(
      {
        success: true,
        data: serializeEntry(doc, ctx),
        timestamp: new Date().toISOString(),
      },
      { status: created ? 201 : 200 }
    )
  } catch (error) {
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
