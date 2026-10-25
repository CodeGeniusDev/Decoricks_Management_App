import { NextRequest, NextResponse } from 'next/server'
import { ClientSession, ObjectId } from 'mongodb'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { ensureFinanceDefaults } from '@/lib/finance-defaults'
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
import { runInTransaction } from '@/lib/stock-service'

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
    await ensureFinanceDefaults(db)
    const meta = await getRequestMeta()
    const actor: ActorContext & { ipAddress?: string | null; userAgent?: string | null } = {
      id: auth.user._id as ObjectId,
      name: auth.user.name,
      email: auth.user.email,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    }

    const { doc, created } = await runInTransaction((session: ClientSession) =>
      reverseLedgerEntry(db, id, parsed.data.reason, actor, parsed.data.idempotencyKey, {
        session,
        audit: false,
      })
    )

    if (created) {
      const originalId = doc.reversesId?.toString() ?? id
      await import('@/lib/audit').then(({ recordAuditEntry }) =>
        recordAuditEntry(db, {
          userId: actor.id,
          userEmail: actor.email,
          action: 'transaction_reversed',
          entityType: 'finance',
          entityId: originalId === doc._id?.toString() ? doc._id : (doc.reversesId ?? null),
          oldValue: { status: 'posted' },
          newValue: {
            status: 'reversed',
            reversalId: doc._id?.toString(),
            reason: parsed.data.reason ?? null,
          },
          details: `Reversed transaction ${originalId}`,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        })
      )
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

export const POST = withAuth(__POST)
