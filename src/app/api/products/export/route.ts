import { NextRequest } from 'next/server'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { validationError } from '@/lib/api-response'
import { csvResponse } from '@/lib/csv-response'
import { toCsv } from '@/lib/finance'
import { paisaToPkr } from '@/lib/money'
import { buildStockSummary, type StockSummaryItem } from '@/lib/stock-summary'
import { getProductCollection } from '@/lib/models/Product'
import {
  buildProductFilter,
  productParamsFromUrl,
} from '@/lib/inventory-sales-filters'

/**
 * GET /api/products/export — the product list as CSV.
 *
 * The filter is built by the SAME function `GET /api/products` uses
 * (`src/lib/inventory-sales-filters.ts`), so the button genuinely exports what
 * the screen is showing. Stock figures come from `buildStockSummary`, i.e. the
 * movement ledger derivation — the same source the overview displays, never the
 * cached projection, so the two can never disagree.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('inventory', 'view')

    const params = productParamsFromUrl(new URL(request.url))
    // Reject unknown query values the same way the list route does — an export
    // silently ignoring a typo'd filter would hand out the wrong file.
    for (const key of new URL(request.url).searchParams.keys()) {
      if (!['search', 'category', 'active'].includes(key)) {
        return validationError('Unknown parameter', [
          { path: key, message: `Parameter "${key}" is not supported by this export` },
        ])
      }
    }
    const filter = buildProductFilter(params)

    const db = await getDatabase()
    // Only the ids are needed to scope the export; the summary provides the
    // rest (names, costs and derived pools all live there too). A filter that
    // matches nothing is a valid empty export, not an error.
    const matching = await getProductCollection(db)
      .find(filter as never, { projection: { _id: 1 } } as never)
      .toArray()

    const idSet = new Set(matching.map((p) => p._id!.toString()))
    const summary = await buildStockSummary(db, { includeArchived: true })
    const items = summary.items.filter((item) => idSet.has(item._id))

    const csv = toCsv<StockSummaryItem>(items, [
      { key: 'sku', label: 'SKU', value: (row) => row.sku },
      { key: 'name', label: 'Name', value: (row) => row.name },
      { key: 'category', label: 'Category', value: (row) => row.category },
      { key: 'status', label: 'Status', value: (row) => (row.isActive ? 'active' : 'archived') },
      {
        key: 'cost',
        label: 'Weighted avg cost (PKR)',
        value: (row) => paisaToPkr(row.cost).toFixed(2),
      },
      {
        key: 'sellingPrice',
        label: 'Selling price (PKR)',
        value: (row) => paisaToPkr(row.sellingPrice).toFixed(2),
      },
      { key: 'reorderLevel', label: 'Reorder level', value: (row) => row.reorderLevel ?? '' },
      {
        key: 'sheikhupura',
        label: 'Sheikhupura available',
        value: (row) => row.byLocation.find((l) => l.location === 'sheikhupura')?.available ?? 0,
      },
      {
        key: 'lahore',
        label: 'Lahore available',
        value: (row) => row.byLocation.find((l) => l.location === 'lahore')?.available ?? 0,
      },
      { key: 'damaged', label: 'Damaged (all)', value: (row) => row.totalDamaged },
      { key: 'returned', label: 'Returned (all)', value: (row) => row.totalReturned },
      { key: 'total', label: 'Total available', value: (row) => row.totalAvailable },
      {
        key: 'valuation',
        label: 'Valuation (PKR)',
        value: (row) => paisaToPkr(row.valuation).toFixed(2),
      },
      { key: 'lowStock', label: 'Low stock', value: (row) => (row.lowStock ? 'yes' : '') },
    ])

    return csvResponse(csv, 'products')
  } catch (error) {
    console.error('GET /api/products/export failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
