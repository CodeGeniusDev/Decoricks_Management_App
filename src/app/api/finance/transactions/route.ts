import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { ensureFinanceDefaults } from '@/lib/finance-defaults'
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
import { notifyFinanceEntryCreated } from '@/lib/notifications/wiring'

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
    await ensureFinanceDefaults(db)
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
    /*
     * One authorization per request, and its result is reused for the actor
     * identity below. This route used to call `authorize()` again after parsing,
     * which measured as the only doubled session lookup in the whole suite
     * (`auth:session=133ms x2` across 36 posts on a production build against the
     * M0 cluster) for a second answer that cannot differ from the first:
     * `ledgerEntrySchema` is a `z.discriminatedUnion('type', …)`, so a payload
     * that parses carries exactly the `type` string this gate was chosen on — no
     * transform, default or coercion is involved on the discriminator.
     */
    const auth = await authorize('finance', type === 'partner_withdrawal' ? 'approve' : 'create')

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
    await ensureFinanceDefaults(db)
    const meta = await getRequestMeta()

    const actor: ActorContext = {
      id: auth.user._id as ObjectId,
      name: auth.user.name,
      email: auth.user.email,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    }

    const { doc, created } = await createLedgerEntry(db, parsed.data, actor)

    // Phase 9 notifications — fired only for a genuinely new entry (a replay of
    // the same idempotency key returns `created: false`, so an offline retry or
    // double-click never alerts twice). Shared with the offline sync route via
    // `notifyFinanceEntryCreated` — online and offline alerts cannot drift.
    if (created && doc._id) {
      await notifyFinanceEntryCreated(db, doc)
    }

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
