import { NextRequest } from 'next/server'
import type { PermissionModule } from '@/lib/models/User'
import { handleRouteError, withAuth } from '@/lib/http'
import { resolveViewScopes } from '@/lib/authorization'
import { getDatabase, withMongoRetry } from '@/lib/mongodb'
import { resolveReportRange } from '@/lib/cash-flow'
import { errorResponse, successResponse } from '@/lib/api-response'
import { buildDashboardMetrics } from '@/lib/metrics/dashboard-metrics'

/**
 * GET /api/dashboard?period=day|week|month|custom[&date=YYYY-MM-DD][&from=…&to=…]
 *
 * The Phase 8 dashboard's single aggregate source (METRICS.md §I). It composes
 * the existing P&L / cash-flow / inventory / budget / task engines over one
 * ledger read — the same calls `/api/reports/period` and the reconciliation panel
 * make — so dashboard = reports = ledger by construction, not by coincidence.
 *
 * Authorization is per-widget and server-side (`resolveViewScopes`): a block for
 * a module the caller cannot view is never assembled, so its numbers never enter
 * the response. `resolveReportRange` maps the brief's "today / this week / this
 * month / custom" selector onto Karachi boundaries and rejects invalid or
 * inverted ranges with 400 rather than silently clipping.
 *
 * This route supersedes the legacy `/api/dashboard/summary` (left in place, but
 * no longer a source of any dashboard figure).
 */

// Financial figures are never cached — a stale number is worse than a refetch
// (brief §6: "cache only if it can never show a stale financial number").
export const dynamic = 'force-dynamic'
export const revalidate = 0

const DASHBOARD_MODULES: PermissionModule[] = ['finance', 'sales', 'inventory', 'budget', 'tasks']

async function __GET(request: NextRequest) {
  try {
    const scopes = await resolveViewScopes(DASHBOARD_MODULES)

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
    const metrics = await withMongoRetry(async () => {
      const db = await getDatabase()
      return buildDashboardMetrics({
        db,
        range: resolved.range,
        period: resolved.period,
        viewable: scopes.viewable,
        now,
      })
    })

    return successResponse(metrics)
  } catch (error) {
    console.error('GET /api/dashboard failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
