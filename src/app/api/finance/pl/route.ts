import { NextRequest } from 'next/server'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { successResponse, validationError } from '@/lib/api-response'
import { karachiCivil, karachiMidnight, type DateRange } from '@/lib/finance'
import { computeProfitLoss, monthlyProfitSeries } from '@/lib/profit-loss'
import { periodCogsInput, cogsInputsForRanges } from '@/lib/cogs-service'
import { resolveReportRange } from '@/lib/cash-flow'
import { fetchLedgerRange } from '@/lib/distribution-service'

/**
 * GET /api/finance/pl?period=day|week|month|custom&date=YYYY-MM-DD
 *                            |from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * The SPEC §5 profit-and-loss chain, computed live from the unified ledger
 * over inclusive Asia/Karachi ranges. Reversals cancel their originals, so
 * every figure traces back to transaction records. COGS comes from the Phase 5
 * movement ledger (weighted average cost); only before the first movement
 * exists does the response fall back to the explicitly PROVISIONAL ledger
 * purchasing stand-in — it never pretends to a number it does not have.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('finance', 'view')

    const { searchParams } = new URL(request.url)
    const resolved = resolveReportRange(searchParams)
    if (!resolved) {
      return validationError('Invalid period', [
        { path: 'period', message: 'Provide a valid period with date, or from and to (YYYY-MM-DD)' },
      ])
    }
    const { period, range } = resolved

    const db = await getDatabase()

    // The monthly trend always shows the trailing 12 Karachi months ending at
    // the range's month, so the fetched window is the union of both.
    const endCivil = karachiCivil(range.end)
    const seriesStartIndex = endCivil.year * 12 + (endCivil.month - 1) - 11
    const seriesStart = karachiMidnight(
      Math.floor(seriesStartIndex / 12),
      (seriesStartIndex % 12) + 1,
      1
    )
    const windowStart = new Date(Math.min(range.start.getTime(), seriesStart.getTime()))

    const all = await fetchLedgerRange(db, { start: windowStart, end: range.end })
    const inRange = all.filter(
      (entry) => new Date(entry.date).getTime() >= range.start.getTime() && new Date(entry.date).getTime() <= range.end.getTime()
    )

    const suppliedCogs = await periodCogsInput(db, range)
    const profitLoss = computeProfitLoss(inRange, { cogs: suppliedCogs })

    const monthRanges: { month: string; label: string; range: DateRange }[] = []
    let cursor = seriesStart
    for (let i = 0; i < 12; i++) {
      const civil = karachiCivil(cursor)
      const nextCivilMonth = civil.month === 12 ? { year: civil.year + 1, month: 1 } : { year: civil.year, month: civil.month + 1 }
      const start = karachiMidnight(civil.year, civil.month, 1)
      const end = new Date(karachiMidnight(nextCivilMonth.year, nextCivilMonth.month, 1).getTime() - 1)
      const key = `${civil.year}-${String(civil.month).padStart(2, '0')}`
      monthRanges.push({
        month: key,
        label: new Date(Date.UTC(civil.year, civil.month - 1, 1)).toLocaleDateString('en-GB', {
          month: 'short',
          year: '2-digit',
          timeZone: 'UTC',
        }),
        range: { start, end },
      })
      cursor = new Date(karachiMidnight(nextCivilMonth.year, nextCivilMonth.month, 1).getTime())
    }
    const monthly = monthlyProfitSeries(all, monthRanges, await cogsInputsForRanges(db, monthRanges.map((m) => m.range)))

    return successResponse({
      period,
      range: { start: range.start.toISOString(), end: range.end.toISOString() },
      profitLoss,
      monthly,
      /** How the headline numbers were derived — the calc panel reads this. */
      formulas: {
        netSales: 'Revenue − Refunds',
        grossProfit: 'Net Sales − COGS',
        netProfit: 'Gross Profit − Operating Expenses',
        cogs: profitLoss.cogsProvisional
          ? 'PROVISIONAL: ledger product_purchasing total (no inventory movements recorded yet)'
          : profitLoss.cogsSource,
      },
    })
  } catch (error) {
    console.error('GET /api/finance/pl failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
