import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { getRequestMeta, HttpError, handleRouteError, withAuth } from '@/lib/http'
import { recordAuditEntry } from '@/lib/audit'
import { validationError } from '@/lib/api-response'
import { accountUpdateSchema } from '@/lib/schemas/finance'
import { getAccountBalances } from '@/lib/finance-ledger'
import { getAccountCollection, type Account } from '@/lib/models/Ledger'
import { serializeAccount } from '@/lib/finance-serializers'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * PATCH /api/finance/accounts/[id]
 *
 * Renames / retypes / deactivates an account. The opening balance is editable
 * because it is a configuration value, not a posted transaction — changing it is
 * audited and never rewrites ledger history.
 */
async function __PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('finance', 'approve')
    const { id } = await context.params

    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return validationError('Invalid account id', [
        { path: 'id', message: 'Malformed id' },
      ])
    }

    const body = await request.json().catch(() => ({}))
    const parsed = accountUpdateSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      )
    }

    const db = await getDatabase()
    const collection = getAccountCollection(db)
    const objectId = new ObjectId(id)

    const existing = await collection.findOne({ _id: objectId })
    if (!existing) throw new HttpError('Account not found', 404, 'NOT_FOUND')

    const update: Partial<Account> = { updatedAt: new Date() }
    if (parsed.data.name !== undefined) {
      const name = parsed.data.name.trim()
      if (name !== existing.name) {
        const duplicate = await collection.findOne({ name, _id: { $ne: objectId } })
        if (duplicate) throw new HttpError('An account with that name already exists', 409, 'DUPLICATE')
      }
      update.name = name
    }
    if (parsed.data.kind !== undefined) update.kind = parsed.data.kind
    if (parsed.data.openingBalance !== undefined) update.openingBalance = parsed.data.openingBalance
    if (parsed.data.isActive !== undefined) update.isActive = parsed.data.isActive
    if (parsed.data.note !== undefined) update.note = parsed.data.note

    await collection.updateOne({ _id: objectId }, { $set: update })

    const { balances } = await getAccountBalances(db)
    const updated = { ...existing, ...update } as Account
    updated._id = objectId

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'account_updated',
      entityType: 'finance',
      entityId: objectId,
      oldValue: serializedForAudit(existing),
      newValue: serializedForAudit(updated),
      details: 'Updated finance account configuration',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return NextResponse.json({
      success: true,
      data: serializeAccount(updated, balances[id] ?? updated.openingBalance),
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

const serializedForAudit = (account: Account) => ({
  name: account.name,
  kind: account.kind,
  openingBalance: account.openingBalance,
  isActive: account.isActive,
  note: account.note,
})

export const PATCH = withAuth(__PATCH)
