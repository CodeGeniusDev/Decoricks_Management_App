import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { getRequestMeta, HttpError, handleRouteError, withAuth } from '@/lib/http'
import { recordAuditEntry } from '@/lib/audit'
import { successResponse, validationError } from '@/lib/api-response'
import { accountCreateSchema } from '@/lib/schemas/finance'
import { getAccountBalances } from '@/lib/finance-ledger'
import { getAccountCollection, type Account } from '@/lib/models/Ledger'
import { serializeAccount } from '@/lib/finance-serializers'


async function __GET() {
  try {
    await authorize('finance', 'view')
    const db = await getDatabase()
    const { accounts, balances } = await getAccountBalances(db)
    return successResponse({
      accounts: accounts.map((account) => serializeAccount(account, balances[account._id!.toString()] ?? 0)),
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

/** Only the Founder (by way of `finance.approve`) may add accounts. */
async function __POST(request: NextRequest) {
  try {
    const auth = await authorize('finance', 'approve')
    const body = await request.json().catch(() => null)
    const parsed = accountCreateSchema.safeParse(body)
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      )
    }

    const db = await getDatabase()
    const collection = getAccountCollection(db)
    const name = parsed.data.name.trim()

    const existing = await collection.findOne({ name })
    if (existing) throw new HttpError('An account with that name already exists', 409, 'DUPLICATE')

    const now = new Date()
    const doc: Account = {
      name,
      kind: parsed.data.kind,
      openingBalance: parsed.data.openingBalance,
      isActive: true,
      note: parsed.data.note,
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
      action: 'account_created',
      entityType: 'finance',
      entityId: result.insertedId,
      newValue: { name: doc.name, kind: doc.kind, openingBalance: doc.openingBalance },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return NextResponse.json(
      {
        success: true,
        data: serializeAccount(doc, doc.openingBalance),
        timestamp: new Date().toISOString(),
      },
      { status: 201 }
    )
  } catch (error) {
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
