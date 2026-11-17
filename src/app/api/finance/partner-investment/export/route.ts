import { NextRequest, NextResponse } from 'next/server'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { handleRouteError, withAuth } from '@/lib/http'
import { getLedgerCollection } from '@/lib/models/Ledger'
import { karachiDateInputRange } from '@/lib/finance'
import { computePartnerInvestment } from '@/lib/partner-investment'
import { normalizeEntry } from '@/lib/finance-ledger'

/**
 * GET /api/finance/partner-investment/export
 *
 * Exports partner investment summary as CSV.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('finance', 'view')

    const { searchParams } = new URL(request.url)
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: 'Date range is required' },
        { status: 400 }
      )
    }

    const startRange = karachiDateInputRange(startDate)
    const endRange = karachiDateInputRange(endDate)

    if (!startRange || !endRange) {
      return NextResponse.json(
        { error: 'Invalid date format' },
        { status: 400 }
      )
    }

    const db = await getDatabase()
    const ledger = getLedgerCollection(db)

    const rawEntries = await ledger
      .find({
        date: { $gte: startRange.start, $lte: endRange.end },
        type: { $in: ['partner_capital', 'partner_withdrawal'] },
      })
      .sort({ date: 1 })
      .toArray()

    // Normalize entries to convert ObjectId to string
    const entries = rawEntries.map(normalizeEntry)

    const summary = computePartnerInvestment(entries, {
      start: startRange.start,
      end: endRange.end,
    })

    // Build CSV
    const headers = ['Partner', 'Capital Invested (PKR)', 'Withdrawals (PKR)', 'Net Balance (PKR)', 'Capital Transactions', 'Withdrawal Transactions']
    const rows = summary.partners.map(
      (p) =>
        `${p.partnerName},${p.capitalIn / 100},${p.withdrawalsOut / 100},${p.netBalance / 100},${p.capitalTransactionCount},${p.withdrawalTransactionCount}`
    )

    const footer = ['', '', '', '', '', '']
    const totals = [
      'TOTAL',
      `${summary.totalCapitalIn / 100}`,
      `${summary.totalWithdrawalsOut / 100}`,
      `${summary.totalNetBalance / 100}`,
      `${summary.transactionCount}`,
      '',
    ]

    const csv = [headers.join(','), ...rows, footer.join(','), totals.join(',')].join('\n')

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="partner-investment-${startDate}-to-${endDate}.csv"`,
      },
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
