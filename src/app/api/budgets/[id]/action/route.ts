import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getBudgetCollection, budgetToJSON } from '@/lib/models/Operations'
import { budgetActionSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'
import { recordAuditEntry } from '@/lib/audit'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)
const badId = () => validationError('Invalid budget id', [{ path: 'id', message: 'Malformed id' }])

/** Which permission each lifecycle action needs, and the transitions it allows. */
type BudgetStatus = 'draft' | 'active' | 'archived'
const ACTION_RULES: Record<
  'approve' | 'archive' | 'reopen',
  { permission: string; from: BudgetStatus[]; to: BudgetStatus }
> = {
  approve: { permission: 'approve', from: ['draft'], to: 'active' },
  archive: { permission: 'edit', from: ['draft', 'active'], to: 'archived' },
  reopen: { permission: 'edit', from: ['archived'], to: 'draft' },
}

/**
 * POST /api/budgets/[id]/action
 *
 * Budget lifecycle without hard deletes: `approve` (draft → active, Founder's
 * `budget.approve`), `archive` (the only way a budget is ever "removed" — the
 * document, its revisions and its audit trail all survive) and `reopen`
 * (archived → draft, back through the edit permission).
 */
async function __POST(request: NextRequest, context: RouteContext) {
  try {
    const parsed = budgetActionSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const { action } = parsed.data
    const rules = ACTION_RULES[action]
    const auth = await authorize('budget', rules.permission)

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const col = getBudgetCollection(db)
    const _id = new ObjectId(id)

    const existing = await col.findOne({ _id } as never)
    if (!existing) return notFoundError('Budget not found')

    if (!rules.from.includes(existing.status)) {
      return validationError('Invalid transition', [
        {
          path: 'action',
          message: `A ${existing.status} budget cannot be ${action}d`,
        },
      ])
    }

    const now = getKarachiDate()
    const update: Record<string, unknown> = { status: rules.to, updatedAt: now }
    if (action === 'approve') {
      update.approvedBy = auth.user.name
      update.approvedAt = now
    }

    await col.updateOne({ _id } as never, { $set: update } as never)
    const updated = await col.findOne({ _id } as never)

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: `budget_${action}`,
      entityType: 'budget',
      entityId: _id,
      oldValue: { status: existing.status },
      newValue: { status: rules.to, reason: parsed.data.reason },
      details:
        `Budget ${existing.budgetNumber ?? existing.name} ${existing.status} → ${rules.to}` +
        (parsed.data.reason ? ` (${parsed.data.reason})` : ''),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(budgetToJSON(updated!))
  } catch (error) {
    console.error('POST /api/budgets/[id]/action failed:', error)
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
