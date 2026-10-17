import { handleRouteError, withAuth } from '@/lib/http'
import { authorizeAllViews } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { errorResponse, successResponse } from '@/lib/api-response'
import { buildPeriodReport, resolvePeriodRange } from '@/lib/reports/period-report'

/**
 * GET /api/reports/period?period=week|month&date=YYYY-MM-DD
 *
 * Backs the weekly/monthly summary. The aggregation lives in
 * `src/lib/reports/period-report.ts` (`buildPeriodReport`) so the export
 * endpoint produces byte-for-byte the same numbers — "export what I'm looking
 * at" with zero formula duplication (METRICS §H.2). This route is only the
 * authorization + range-resolution + HTTP wrapper.
 */
async function __GET(request: NextRequest) {
  try {
    await authorizeAllViews(['finance', 'inventory', 'sales', 'tasks'])

    const range = resolvePeriodRange(new URL(request.url).searchParams)
    if (!range.ok) {
      return errorResponse(range.message, 400, 'VALIDATION_ERROR')
    }

    const report = await buildPeriodReport(range)
    return successResponse(report)
  } catch (error) {
    console.error('GET /api/reports/period failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
