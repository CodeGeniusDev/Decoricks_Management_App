import { NextRequest } from 'next/server'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { validationError } from '@/lib/api-response'
import { csvResponse } from '@/lib/csv-response'
import { toCsv } from '@/lib/finance'
import { paisaToPkr } from '@/lib/money'
import { formatKarachiDate } from '@/lib/date'
import { getOrderCollection, type Order } from '@/lib/models/Sales'
import { ensureOrdersIndexes } from '@/lib/models/Sales'
import {
  buildOrderFilter,
  orderParamsFromUrl,
} from '@/lib/inventory-sales-filters'

/**
 * GET /api/orders/export — the filtered order list as CSV.
 *
 * Same filter builder as `GET /api/orders` (search, status, payment status,
 * channel, ship-from location, Karachi date range), so the file matches the
 * screen exactly. Money leaves as decimal PKR; dates as Karachi dates — the
 * reader is a partner with a spreadsheet, not the database.
 */
const day = (value?: string | Date | null): string =>
  value ? formatKarachiDate(new Date(value), 'date') : ''

async function __GET(request: NextRequest) {
  try {
    await authorize('sales', 'view')

    const url = new URL(request.url)
    for (const key of url.searchParams.keys()) {
      if (
        !['search', 'status', 'paymentStatus', 'channel', 'location', 'from', 'to'].includes(key)
      ) {
        return validationError('Unknown parameter', [
          { path: key, message: `Parameter "${key}" is not supported by this export` },
        ])
      }
    }

    const filter = buildOrderFilter(orderParamsFromUrl(url))

    const db = await getDatabase()
    await ensureOrdersIndexes(db)
    // No pagination here on purpose: the export is the whole filtered set.
    // Cap defensively — this is an internal tool, not a bulk data pipe.
    const orders = (await getOrderCollection(db)
      .find(filter as never)
      .sort({ createdAt: -1 })
      .limit(10000)
      .toArray()) as unknown as Order[]

    const csv = toCsv<Order>(orders, [
      { key: 'orderNumber', label: 'Order #', value: (row) => row.orderNumber },
      { key: 'createdAt', label: 'Created (Karachi)', value: (row) => day(row.createdAt) },
      { key: 'customerName', label: 'Customer', value: (row) => row.customerName },
      { key: 'customerPhone', label: 'Phone', value: (row) => row.customerPhone },
      { key: 'customerCity', label: 'City', value: (row) => row.customerCity },
      { key: 'customerAddress', label: 'Address', value: (row) => row.customerAddress ?? '' },
      {
        key: 'items',
        label: 'Items',
        value: (row) =>
          row.items.map((i) => `${i.productName} x${i.quantity}`).join('; '),
      },
      {
        key: 'units',
        label: 'Units',
        value: (row) => row.items.reduce((sum, i) => sum + i.quantity, 0),
      },
      {
        key: 'subtotal',
        label: 'Subtotal (PKR)',
        value: (row) => paisaToPkr(row.subtotal).toFixed(2),
      },
      {
        key: 'shippingCost',
        label: 'Shipping (PKR)',
        value: (row) => paisaToPkr(row.shippingCost ?? 0).toFixed(2),
      },
      {
        key: 'courierCharges',
        label: 'Courier charges (PKR)',
        value: (row) => paisaToPkr(row.courierCharges ?? 0).toFixed(2),
      },
      {
        key: 'total',
        label: 'Total (PKR)',
        value: (row) => paisaToPkr(row.total).toFixed(2),
      },
      { key: 'channel', label: 'Channel', value: (row) => row.salesChannel },
      { key: 'location', label: 'Shipped from', value: (row) => row.shipFromLocation ?? '' },
      { key: 'status', label: 'Order status', value: (row) => row.orderStatus },
      { key: 'paymentMethod', label: 'Payment method', value: (row) => row.paymentMethod },
      { key: 'paymentStatus', label: 'Payment status', value: (row) => row.paymentStatus },
      { key: 'codOutcome', label: 'COD outcome', value: (row) => row.codOutcome },
      { key: 'deliveryDate', label: 'Delivery date', value: (row) => day(row.deliveryDate) },
      { key: 'cashReceived', label: 'COD cash received', value: (row) => day(row.codCashReceivedAt) },
    ])

    return csvResponse(csv, 'orders')
  } catch (error) {
    console.error('GET /api/orders/export failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
