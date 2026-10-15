import { NextRequest } from 'next/server'
import { handleRouteError, withAuth } from '@/lib/http'
import { requireFounder } from '@/lib/authorization'
import { getDatabase, withMongoRetry } from '@/lib/mongodb'
import { resolveReportRange } from '@/lib/cash-flow'
import { errorResponse, successResponse } from '@/lib/api-response'
import { reconcile } from '@/lib/metrics/reconciliation'

/**
 * GET /api/dashboard/reconciliation?period=…&date=…|&from=…&to=…
 *
 * The Founder-only reconciliation panel (METRICS.md §H.2, brief §5). Verifies the
 * equalities the brief demands — dashboard = reports = ledger, inventory
 * valuation = stock movements, account balances = ledger — recomputing each
 * figure independently and reporting the exact difference in paisa. A non-zero
 * difference is a visible FAIL; nothing is hidden or auto-corrected.
 *
 * Gated by `requireFounder`, which is deliberately the founder ROLE, not a
 * permission grant — no Partner can open it (brief §8).
 */

// Never cached: a reconciliation must always read the live ledger.
export const dynamic = 'force-dynamic'
export const revalidate = 0

async function __GET(request: NextRequest) {
  try {
    await requireFounder()

    const { searchParams } = new URL(request.url)
    const resolved = resolveReportRange(searchParams)
    if (!resolved) {
      return errorResponse(
        'Invalid period. Custom ranges need valid from/to dates and from must not be after to.',
        400,
        'VALIDATION_ERROR'
      )
    }

    const now = new Date()
    const report = await withMongoRetry(async () => {
      const db = await getDatabase()
      return reconcile(db, resolved.range, now)
    })

    return successResponse(report)
  } catch (error) {
    console.error('GET /api/dashboard/reconciliation failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
