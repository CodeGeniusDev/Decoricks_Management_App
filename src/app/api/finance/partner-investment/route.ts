import { NextRequest, NextResponse } from 'next/server'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { handleRouteError, withAuth } from '@/lib/http'
import { getLedgerCollection } from '@/lib/models/Ledger'
import { karachiDateInputRange } from '@/lib/finance'
import { computePartnerInvestment } from '@/lib/partner-investment'
import { successResponse, validationError } from '@/lib/api-response'
import { normalizeEntry } from '@/lib/finance-ledger'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * GET /api/finance/partner-investment
 *
 * Returns partner investment summary for a date range.
 * Includes per-partner capital, withdrawals, and net balance.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('finance', 'view')

    const { searchParams } = new URL(request.url)
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

    if (!startDate || !endDate) {
      return validationError('Date range is required', [
        { path: 'startDate', message: 'Start date is required' },
        { path: 'endDate', message: 'End date is required' },
      ])
    }

    const startRange = karachiDateInputRange(startDate)
    const endRange = karachiDateInputRange(endDate)

    if (!startRange || !endRange) {
      return validationError('Invalid date format', [
        { path: 'startDate', message: 'Use YYYY-MM-DD format' },
        { path: 'endDate', message: 'Use YYYY-MM-DD format' },
      ])
    }

    if (endRange.start < startRange.start) {
      return validationError('Invalid date range', [
        { path: 'endDate', message: 'End date must be on or after start date' },
      ])
    }

    const db = await getDatabase()
    const ledger = getLedgerCollection(db)

    // Fetch ledger entries in the date range
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

    return successResponse(summary)
  } catch (error) {
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
