import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { getRequestMeta, handleRouteError, withAuth } from '@/lib/http'
import { validationError } from '@/lib/api-response'
import { reverseTransactionSchema } from '@/lib/schemas/finance'
import {
  buildSerializeContext,
  loadAccounts,
  loadCategories,
  reverseLedgerEntry,
  serializeEntry,
  type ActorContext,
} from '@/lib/finance-ledger'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * POST /api/finance/transactions/[id]/reverse
 *
 * Corrects a posted entry by appending its mirror image. There is no edit and
 * no delete: the original stays visible and is marked `reversed`. Reversing
 * requires `finance.approve` (Founder by default), and a reversal entry cannot
 * itself be reversed or be reversed twice.
 */
async function __POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('finance', 'approve')
    const { id } = await context.params

    const body = await request.json().catch(() => ({}))
    const parsed = reverseTransactionSchema.safeParse(body ?? {})
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
    const actor = {
      id: auth.user._id as ObjectId,
      name: auth.user.name,
      email: auth.user.email,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    }

    const { doc, created } = await reverseLedgerEntry(
      db,
      id,
      parsed.data.reason,
      actor,
      parsed.data.idempotencyKey
    )

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

export const POST = withAuth(__POST)
