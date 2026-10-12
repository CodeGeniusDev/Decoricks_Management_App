import { NextRequest } from 'next/server'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { validationError } from '@/lib/api-response'
import { csvResponse } from '@/lib/csv-response'
import { toCsv } from '@/lib/finance'
import { paisaToPkr } from '@/lib/money'
import { buildStockSummary, type StockSummaryItem } from '@/lib/stock-summary'

/**
 * GET /api/stock/export — stock per product per location as CSV.
 *
 * Built from `buildStockSummary`, the same ledger derivation the overview
 * renders: available, damaged and returned pools per location, valued at the
 * weighted average cost. There is no typed-in stock figure anywhere, so the
 * file cannot show a number the app does not stand behind.
 *
 * Query: `includeArchived=true` to include archived products' stock.
 */
interface StockExportRow {
  sku: string
  name: string
  category: string
  status: string
  location: string
  available: number
  damaged: number
  returned: number
  cost: number
  valuation: number
  reorderLevel: number | null
  lowStock: boolean
}

const flatten = (items: StockSummaryItem[]): StockExportRow[] =>
  items.flatMap((item) =>
    item.byLocation.map((row) => ({
      sku: item.sku,
      name: item.name,
      category: item.category,
      status: item.isActive ? 'active' : 'archived',
      location: row.location,
      available: row.available,
      damaged: row.damaged,
      returned: row.returned,
      cost: item.cost,
      valuation: row.valuation,
      reorderLevel: item.reorderLevel,
      lowStock: item.lowStock,
    }))
  )

async function __GET(request: NextRequest) {
  try {
    await authorize('inventory', 'view')

    const { searchParams } = new URL(request.url)
    for (const key of searchParams.keys()) {
      if (key !== 'includeArchived') {
        return validationError('Unknown parameter', [
          { path: key, message: `Parameter "${key}" is not supported by this export` },
        ])
      }
    }
    const includeArchived = searchParams.get('includeArchived') === 'true'

    const db = await getDatabase()
    const summary = await buildStockSummary(db, { includeArchived })
    const rows = flatten(summary.items)

    const csv = toCsv<StockExportRow>(rows, [
      { key: 'sku', label: 'SKU', value: (row) => row.sku },
      { key: 'name', label: 'Product', value: (row) => row.name },
      { key: 'category', label: 'Category', value: (row) => row.category },
      { key: 'status', label: 'Status', value: (row) => row.status },
      { key: 'location', label: 'Location', value: (row) => row.location },
      { key: 'available', label: 'Available', value: (row) => row.available },
      { key: 'damaged', label: 'Damaged', value: (row) => row.damaged },
      { key: 'returned', label: 'Returned', value: (row) => row.returned },
      {
        key: 'cost',
        label: 'Weighted avg cost (PKR)',
        value: (row) => paisaToPkr(row.cost).toFixed(2),
      },
      {
        key: 'valuation',
        label: 'Valuation (PKR)',
        value: (row) => paisaToPkr(row.valuation).toFixed(2),
      },
      { key: 'reorderLevel', label: 'Reorder level', value: (row) => row.reorderLevel ?? '' },
      { key: 'lowStock', label: 'Low stock', value: (row) => (row.lowStock ? 'yes' : '') },
    ])

    return csvResponse(csv, 'stock')
  } catch (error) {
    console.error('GET /api/stock/export failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
