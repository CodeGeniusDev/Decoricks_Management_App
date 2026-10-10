import { NextRequest, NextResponse } from 'next/server'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { handleRouteError, withAuth } from '@/lib/http'
import { validationError } from '@/lib/api-response'
import { transactionQuerySchema } from '@/lib/schemas/finance'
import { ENTRY_TYPE_LABELS, toCsv } from '@/lib/finance'
import { paisaToPkr } from '@/lib/money'
import {
  buildLedgerFilter,
  buildSerializeContext,
  formatEntryDate,
  loadAccounts,
  loadCategories,
  serializeEntry,
  type EntrySerialized,
} from '@/lib/finance-ledger'
import { getLedgerCollection } from '@/lib/models/Ledger'

/**
 * GET /api/finance/export
 *
 * Streams the filtered ledger as CSV. The same filters as the list endpoint are
 * honoured, so "export what I'm looking at" is exact. Money is exported as a
 * decimal PKR figure (never a float-in-name-only paisa integer) to match every
 * other ledger surface.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('finance', 'view')

    const params = Object.fromEntries(new URL(request.url).searchParams.entries())
    const parsed = transactionQuerySchema.safeParse({ ...params, page: '1', limit: '100' })
    if (!parsed.success) {
      return validationError(
        'Invalid query',
        parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      )
    }

    const db = await getDatabase()
    const { filter } = buildLedgerFilter(parsed.data)

    const [entries, accounts, categories] = await Promise.all([
      getLedgerCollection(db).find(filter as never).sort({ date: -1, createdAt: -1 }).toArray(),
      loadAccounts(db),
      loadCategories(db),
    ])
    const ctx = buildSerializeContext(accounts, categories)
    const rows = entries.map((doc) => serializeEntry(doc, ctx))

    const csv = toCsv<EntrySerialized>(rows, [
      { key: 'date', label: 'Date', value: (row) => formatEntryDate(row.date) },
      { key: 'type', label: 'Type', value: (row) => ENTRY_TYPE_LABELS[row.type] ?? row.type },
      {
        key: 'amount',
        label: 'Amount (PKR)',
        value: (row) => paisaToPkr(row.isReversal ? -row.amount : row.amount).toFixed(2),
      },
      { key: 'account', label: 'Account', value: (row) => row.accountName ?? '' },
      { key: 'fromAccount', label: 'From account', value: (row) => row.fromAccountName ?? '' },
      { key: 'toAccount', label: 'To account', value: (row) => row.toAccountName ?? '' },
      { key: 'category', label: 'Category', value: (row) => row.categoryLabel ?? '' },
      { key: 'partner', label: 'Partner', value: (row) => row.partnerName ?? '' },
      { key: 'paymentMethod', label: 'Payment method', value: (row) => row.paymentMethod ?? '' },
      { key: 'note', label: 'Note', value: (row) => row.note ?? '' },
      { key: 'status', label: 'Status', value: (row) => (row.isReversal ? 'Reversal' : 'Posted') },
    ])

    const filename = `decoricks-transactions-${new Date().toISOString().slice(0, 10)}.csv`

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
