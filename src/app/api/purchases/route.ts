import { NextRequest } from 'next/server'
import { ObjectId, type ClientSession, type Db } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize, authorizeStockWrite, requireAuth } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import {
  ensureInventoryIndexes,
  getPurchaseCollection,
  purchaseToJSON,
  type Purchase,
} from '@/lib/models/Inventory'
import { getProductCollection } from '@/lib/models/Product'
import { getSupplierCollection } from '@/lib/models/Operations'
import { purchaseSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { allocateSerial, monthPrefix } from '@/lib/serial'
import { karachiDateInputRange } from '@/lib/finance'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'
import { recordAuditEntry } from '@/lib/audit'
import { createLedgerEntry, parseLedgerDate, type ActorContext } from '@/lib/finance-ledger'
import { resolvePostingAccount } from '@/lib/ledger-accounts'
import {
  applyPurchaseWeightedAverageCost,
  getAllowNegativeStock,
  postMovement,
  runInTransaction,
} from '@/lib/stock-service'
import { formatPaisa } from '@/lib/money'

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

/** Seeded ledger category for inventory buys (SPEC Appendix A). */
const PURCHASE_CATEGORY = 'product_purchasing'

/** Builds `PUR-YYYYMM-NNNN` from an atomic per-month counter (see lib/serial). */
async function nextPurchaseNumber(db: Db, session?: ClientSession): Promise<string> {
  return allocateSerial(db, {
    collection: 'purchases',
    field: 'purchaseNumber',
    prefix: monthPrefix('PUR'),
    session,
  })
}

/**
 * GET /api/purchases
 *
 * Query params: productId, supplierId, location, from, to (YYYY-MM-DD Karachi
 * boundaries), page, limit. Product and supplier names are snapshots stored on
 * the purchase itself, so history stays readable after renames or archives.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('inventory', 'view')

    const { searchParams } = new URL(request.url)
    const page = Math.max(1, Number(searchParams.get('page') ?? 1) || 1)
    const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit') ?? 50) || 50))

    const db = await getDatabase()
    await ensureInventoryIndexes(db)

    const and: Record<string, unknown>[] = []
    const productId = searchParams.get('productId')
    if (productId && isObjectId(productId)) and.push({ productId: new ObjectId(productId) })
    const supplierId = searchParams.get('supplierId')
    if (supplierId && isObjectId(supplierId)) and.push({ supplierId: new ObjectId(supplierId) })
    const location = searchParams.get('location')
    if (location) and.push({ location })

    const from = searchParams.get('from')
    const to = searchParams.get('to')
    const dateFilter: Record<string, Date> = {}
    if (from) {
      const range = karachiDateInputRange(from)
      if (range) dateFilter.$gte = range.start
    }
    if (to) {
      const range = karachiDateInputRange(to)
      if (range) dateFilter.$lte = range.end
    }
    if (Object.keys(dateFilter).length > 0) and.push({ date: dateFilter })

    const filter = and.length === 0 ? {} : and.length === 1 ? and[0] : { $and: and }
    const col = getPurchaseCollection(db)

    const [docs, total] = await Promise.all([
      col.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      col.countDocuments(filter),
    ])

    const spentOnPage = docs.reduce((sum, p) => sum + p.totalCost, 0)

    return successResponse({
      items: docs.map(purchaseToJSON),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      totals: { filteredSpendPaisa: spentOnPage },
    })
  } catch (error) {
    console.error('GET /api/purchases failed:', error)
    return handleRouteError(error)
  }
}

/**
 * POST /api/purchases — one atomic business event:
 *
 *   stock in at cost  +  weighted-average-cost update  +  linked ledger
 *   expense (`product_purchasing`) — all inside a single MongoDB transaction.
 *
 * Money and stock can therefore never disagree: if any leg fails the whole
 * purchase rolls back. The expense is posted with a deterministic idempotency
 * key derived from the purchase id, and the purchase itself is keyed by the
 * client's idempotency key (unique sparse index), so a retried submit can
 * never double-buy stock or double-post the expense.
 *
 * STRICT authorization: a purchase writes stock at exactly one location, so
 * the location gate decides (full inventory.create, or the Lahore exception
 * for a Lahore purchase).
 */
async function __POST(request: NextRequest) {
  try {
    const parsed = purchaseSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const {
      productId,
      location,
      quantity,
      unitCost,
      supplierId,
      date,
      accountId,
      paymentMethod,
      notes,
      idempotencyKey,
    } = parsed.data

    await authorizeStockWrite([location])
    const auth = await requireAuth()
    const actor: ActorContext = {
      id: auth.user._id as ObjectId,
      name: auth.user.name,
      email: auth.user.email,
    }

    const db = await getDatabase()
    await ensureInventoryIndexes(db)

    if (idempotencyKey) {
      const replay = await getPurchaseCollection(db).findOne({ idempotencyKey } as never)
      if (replay) {
        return successResponse({ purchase: purchaseToJSON(replay), replay: true })
      }
    }

    const product = await getProductCollection(db).findOne({ _id: new ObjectId(productId) } as never)
    if (!product) return notFoundError('Product not found')
    if (!product.isActive) {
      return validationError('Product is archived', [
        { path: 'productId', message: 'Reactivate the product before purchasing it' },
      ])
    }

    let supplierName: string | undefined
    if (supplierId) {
      const supplier = await getSupplierCollection(db).findOne({ _id: new ObjectId(supplierId) } as never)
      if (!supplier) return notFoundError('Supplier not found')
      supplierName = supplier.name
    }

    const postingDate = date ? parseLedgerDate(date) : getKarachiDate()
    const totalCost = quantity * unitCost
    const allowNegative = await getAllowNegativeStock(db)
    const expenseAccountId = await resolvePostingAccount(db, accountId, 'purchasingAccountId')

    const result = await runInTransaction(async (session) => {
      const col = getPurchaseCollection(db)
      const purchaseNumber = await nextPurchaseNumber(db, session)
      const now = new Date()

      const purchaseDoc: Purchase = {
        purchaseNumber,
        supplierId: supplierId ? new ObjectId(supplierId) : null,
        supplierName,
        productId: new ObjectId(productId),
        productName: product.name,
        location,
        quantity,
        unitCost,
        totalCost,
        date: postingDate,
        notes: notes || undefined,
        idempotencyKey,
        createdAt: now,
        createdBy: actor.id,
      }

      try {
        const inserted = await col.insertOne(purchaseDoc as never, { session })
        purchaseDoc._id = inserted.insertedId
      } catch (error) {
        if ((error as { code?: number })?.code === 11000 && idempotencyKey) {
          const existing = await col.findOne({ idempotencyKey } as never, { session })
          if (existing) return { replayPurchase: existing, wacBefore: 0, wacAfter: 0 }
        }
        throw error
      }

      // WAC is recomputed against the stock held BEFORE this receipt, so it
      // must run before the purchase_in movement touches the projection.
      const { wacBefore, wacAfter } = await applyPurchaseWeightedAverageCost(
        db,
        product,
        quantity,
        unitCost,
        session
      )

      const { movement } = await postMovement(
        db,
        {
          productId: purchaseDoc.productId,
          movementType: 'purchase_in',
          quantity,
          toLocation: location,
          unitCost,
          referenceId: purchaseDoc._id,
          referenceType: 'purchase',
          idempotencyKey: `purchase:${purchaseDoc._id!.toString()}:in`,
          notes: `Purchase ${purchaseNumber}`,
          date: postingDate,
          createdBy: actor.id,
          allowNegative,
        },
        session
      )

      const ledger = await createLedgerEntry(
        db,
        {
          type: 'expense',
          amount: totalCost,
          date: postingDate instanceof Date ? postingDate.toISOString() : String(postingDate),
          accountId: expenseAccountId.toString(),
          category: PURCHASE_CATEGORY,
          paymentMethod,
          note: `Purchase ${purchaseNumber}: ${quantity} × ${product.name} @ ${formatPaisa(unitCost)}`,
          idempotencyKey: `purchase:${purchaseDoc._id!.toString()}:expense`,
        },
        actor,
        { session }
      )

      await col.updateOne(
        { _id: purchaseDoc._id } as never,
        { $set: { ledgerTransactionId: ledger.doc._id, movementId: movement._id } } as never,
        { session }
      )
      purchaseDoc.ledgerTransactionId = ledger.doc._id
      purchaseDoc.movementId = movement._id

      return { replayPurchase: null as Purchase | null, purchase: purchaseDoc, wacBefore, wacAfter, ledger: ledger.doc, created: ledger.created }
    })

    if (result.replayPurchase) {
      return successResponse({ purchase: purchaseToJSON(result.replayPurchase), replay: true })
    }

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: actor.id,
      userEmail: actor.email,
      action: 'purchase_created',
      entityType: 'purchase',
      entityId: result.purchase!._id ?? null,
      newValue: purchaseToJSON(result.purchase!),
      details: `Purchased ${quantity} × ${product.name} @ ${formatPaisa(unitCost)} into ${location}; WAC ${formatPaisa(result.wacBefore)} → ${formatPaisa(result.wacAfter)}`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(
      {
        purchase: purchaseToJSON(result.purchase!),
        wacBefore: result.wacBefore,
        wacAfter: result.wacAfter,
        ledgerEntryId: result.ledger?._id?.toString(),
        replay: false,
      },
      201
    )
  } catch (error) {
    console.error('POST /api/purchases failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
