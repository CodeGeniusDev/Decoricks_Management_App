import { NextRequest } from 'next/server'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { successResponse } from '@/lib/api-response'
import { buildStockSummary } from '@/lib/stock-summary'

/**
 * GET /api/stock/summary — the Inventory overview screen in one request.
 *
 * Stock by location, inventory valuation and the low-stock list. Every pool
 * (available included) is DERIVED from the movement ledger by
 * `buildStockSummary`, so the overview always shows what the ledger proves, not
 * what a cached projection happens to contain. Valuation uses SPEC §5.7:
 * available units × weighted average cost per product.
 *
 * The same builder backs the stock CSV export and the calculation panel, which
 * is what makes the three figures on those screens provably the same numbers.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('inventory', 'view')

    const { searchParams } = new URL(request.url)
    const includeArchived = searchParams.get('includeArchived') === 'true'
    const productId = searchParams.get('productId') ?? undefined

    const db = await getDatabase()
    const summary = await buildStockSummary(db, { includeArchived, productId })

    return successResponse(summary)
  } catch (error) {
    console.error('GET /api/stock/summary failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
