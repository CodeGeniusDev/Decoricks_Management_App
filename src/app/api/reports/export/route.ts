import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { authorizeAllViews } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { errorResponse } from '@/lib/api-response'
import { recordAuditEntry } from '@/lib/audit'
import { toKarachiInputDate } from '@/lib/form-helpers'
import { buildPeriodReport, resolvePeriodRange } from '@/lib/reports/period-report'
import { reportToCsv, reportToPdf } from '@/lib/reports/render'

/**
 * GET /api/reports/export?period=week|month&date=YYYY-MM-DD&format=csv|pdf
 *
 * Permission-checked + audit-logged download of the weekly/monthly report.
 * METRICS §L:
 *  - "A user cannot export a figure they cannot view server-side" — the whole
 *    aggregation is gated behind `authorizeAllViews`, identical to the on-screen
 *    `/api/reports/period` route.
 *  - "export what I'm looking at" — it reuses `buildPeriodReport`, the exact
 *    engine behind the summary, so a downloaded file can never disagree with the
 *    screen. No formula duplication.
 *  - Every file is stamped with its generated-at moment and Asia/Karachi period,
 *    and money is the report's own `formatPaisa` display strings.
 */
export const dynamic = 'force-dynamic'

async function __GET(request: NextRequest) {
  try {
    const auth = await authorizeAllViews(['finance', 'inventory', 'sales', 'tasks'])

    const searchParams = new URL(request.url).searchParams
    const format = searchParams.get('format')
    if (format !== 'csv' && format !== 'pdf') {
      return errorResponse("Invalid format — expected 'csv' or 'pdf'", 400, 'VALIDATION_ERROR')
    }

    const range = resolvePeriodRange(searchParams)
    if (!range.ok) {
      return errorResponse(range.message, 400, 'VALIDATION_ERROR')
    }

    const report = await buildPeriodReport(range)
    const meta = { generatedAt: new Date() }

    // Audit the export BEFORE returning the bytes, so a download is always
    // recorded even if the client drops the connection mid-transfer.
    const db = await getDatabase()
    const reqMeta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'export',
      entityType: 'report',
      entityId: null,
      details: `Exported ${report.period} report as ${format.toUpperCase()}`,
      newValue: {
        format,
        period: report.period,
        rangeStart: report.rangeStart,
        rangeEnd: report.rangeEnd,
      },
      outcome: 'success',
      ipAddress: reqMeta.ipAddress,
      userAgent: reqMeta.userAgent,
    })

    const day = toKarachiInputDate(range.rangeStart.toISOString())
    const filename = `decoricks-${report.period}-report-${day}.${format}`

    if (format === 'csv') {
      const csv = reportToCsv(report, meta)
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      })
    }

    const pdfBytes = await reportToPdf(report, meta)
    return new NextResponse(pdfBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    console.error('GET /api/reports/export failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
