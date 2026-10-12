import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorizeStockWrite, requireAuth } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { ensureInventoryIndexes, getPurchaseCollection, purchaseToJSON } from '@/lib/models/Inventory'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'
import { recordAuditEntry } from '@/lib/audit'
import { reverseLedgerEntry, type ActorContext } from '@/lib/finance-ledger'
import { getAllowNegativeStock, reverseMovement, runInTransaction } from '@/lib/stock-service'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

/**
 * POST /api/purchases/[id]/cancel
 *
 * Cancelling a purchase posts a linked REVERSAL of the `purchase_in` movement
 * and a linked REVERSAL of the `product_purchasing` expense — nothing is
 * deleted or edited. If some of the bought units have already left stock the
 * reversal would drive the location negative and is refused unless the
 * Founder has allowed negative stock; that is deliberate, the physical loss
 * should be recorded as damage/write-off instead of pretending the purchase
 * never happened.
 */
async function __POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    if (!isObjectId(id)) {
      return validationError('Invalid purchase id', [{ path: 'id', message: 'Malformed id' }])
    }

    const body = await request.json().catch(() => ({}))
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : ''
    if (!reason) {
      return validationError('Validation failed', [
        { path: 'reason', message: 'A reason is required to cancel a purchase' },
      ])
    }
    const idempotencyKey =
      typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim().length >= 8
        ? body.idempotencyKey.trim()
        : undefined

    const db = await getDatabase()
    await ensureInventoryIndexes(db)

    const purchase = await getPurchaseCollection(db).findOne({ _id: new ObjectId(id) } as never)
    if (!purchase) return notFoundError('Purchase not found')
    if (!purchase.movementId) {
      return validationError('Purchase has no stock movement to reverse', [
        { path: 'id', message: 'This purchase is missing its linked movement and cannot be cancelled here' },
      ])
    }

    await authorizeStockWrite([purchase.location])
    const auth = await requireAuth()
    const actor: ActorContext = {
      id: auth.user._id as ObjectId,
      name: auth.user.name,
      email: auth.user.email,
    }

    const allowNegative = await getAllowNegativeStock(db)
    const purchaseId = purchase._id!.toString()
    const movementId = purchase.movementId

    const result = await runInTransaction(async (session) => {
      const reversal = await reverseMovement(
        db,
        movementId,
        {
          createdBy: actor.id,
          reason: `Purchase ${purchase.purchaseNumber} cancelled: ${reason}`,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:movement` : `purchase:${purchaseId}:cancel-movement`,
          allowNegative,
        },
        session
      )

      let ledgerReversal = null as null | { _id?: ObjectId }
      if (purchase.ledgerTransactionId) {
        const rev = await reverseLedgerEntry(
          db,
          purchase.ledgerTransactionId.toString(),
          `Purchase ${purchase.purchaseNumber} cancelled: ${reason}`,
          actor,
          idempotencyKey ? `${idempotencyKey}:expense` : `purchase:${purchaseId}:cancel-expense`,
          { session }
        )
        ledgerReversal = rev.doc
      }

      return { reversal: reversal.reversal, reversalCreated: reversal.created, ledgerReversal }
    })

    if (result.reversalCreated) {
      const meta = await getRequestMeta()
      await recordAuditEntry(db, {
        userId: actor.id,
        userEmail: actor.email,
        action: 'purchase_cancelled',
        entityType: 'purchase',
        entityId: purchase._id ?? null,
        oldValue: purchaseToJSON(purchase),
        details: `Cancelled ${purchase.purchaseNumber}: ${reason}`,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
    }

    return successResponse({ replay: !result.reversalCreated })
  } catch (error) {
    console.error('POST /api/purchases/[id]/cancel failed:', error)
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
