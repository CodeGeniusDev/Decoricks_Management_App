'use client'

/**
 * Orders list (SPEC §5.5, §2.1).
 *
 * Search covers the order number and the customer's name or phone — that is
 * how a courier complaint actually gets looked up. Filters are server-side
 * (date range on the Karachi calendar, status, payment, channel, ship-from
 * location) and the CSV export honours the exact same filter set.
 *
 * Creating an order reserves (deducts) stock at the ship-from location on the
 * server, atomically. The form shows the current pools; it never lets a typed
 * stock number through. Lifecycle actions (dispatch, deliver, cash, cancel,
 * refuse, return) live on the order detail screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { PageTransition } from '@/components/PageTransition'
import { PageHeader } from '@/components/layout/Page'
import { SubNav } from '@/components/layout/SubNav'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Table } from '@/components/ui/Table'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { ExportLink } from '@/components/ui/ExportLink'
import { Toast } from '@/components/ui/Toast'
import { apiJson } from '@/lib/api-client'
import { formatPaisa } from '@/lib/money'
import { formatKarachiDate } from '@/lib/date'
import { useAuth } from '@/components/auth/AuthProvider'
import { can, canWriteStockLocation } from '@/lib/permissions-client'
import {
  ORDER_STATUSES,
  ORDER_STATUS_BADGE,
  ORDER_STATUS_LABELS,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_LABELS,
  SALES_SUBNAV,
  COD_OUTCOME_LABELS,
  type OrderView,
  type OrdersView,
} from '@/modules/sales/sales-ui'
import type { ProductView, StockPools, StockSummaryView } from '@/modules/inventory/inventory-ui'
import { OrderFormModal } from '@/modules/sales/OrderFormModal'
import { useRealtimeSync } from '@/lib/sync/useRealtime'

const LIMIT = 25

const LOCATION_LABELS: Record<string, string> = {
  sheikhupura: 'Sheikhupura',
  lahore: 'Lahore',
}

const EMPTY_FILTERS = {
  search: '',
  status: '',
  paymentStatus: '',
  channel: '',
  location: '',
  from: '',
  to: '',
}

type Filters = typeof EMPTY_FILTERS

const buildFilterQuery = (filters: Filters): string => {
  const params = new URLSearchParams()
  if (filters.search.trim()) params.set('search', filters.search.trim())
  if (filters.status) params.set('status', filters.status)
  if (filters.paymentStatus) params.set('paymentStatus', filters.paymentStatus)
  if (filters.channel) params.set('channel', filters.channel)
  if (filters.location) params.set('location', filters.location)
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  return params.toString()
}

export default function SalesOrdersPage() {
  const { user } = useAuth()
  const canCreate = user ? can({ role: user.role }, 'sales', 'create') : false
  const canWriteLocation = useCallback(
    (location: string) => canWriteStockLocation({ role: user?.role ?? '' }, location),
    [user?.role]
  )
  const canShipAnywhere =
    canWriteStockLocation({ role: user?.role ?? '' }, 'sheikhupura') ||
    canWriteStockLocation({ role: user?.role ?? '' }, 'lahore')

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<OrdersView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [products, setProducts] = useState<ProductView[]>([])
  const [pools, setPools] = useState<Record<string, StockPools>>({})

  const [formOpen, setFormOpen] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const requestSeq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  const setFilter = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }))
    setPage(1)
  }

  const load = useCallback(async (currentFilters: Filters, currentPage: number) => {
    const seq = ++requestSeq.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const params = new URLSearchParams(buildFilterQuery(currentFilters))
    params.set('page', String(currentPage))
    params.set('limit', String(LIMIT))

    try {
      const result = await apiJson<OrdersView>(`/api/orders?${params.toString()}`, {
        signal: controller.signal,
      })
      if (seq === requestSeq.current) {
        setData(result)
        setError(null)
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : 'Failed to load orders')
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    const timer = setTimeout(() => void load(filters, page), filters.search ? 350 : 0)
    return () => clearTimeout(timer)
  }, [filters, page, reloadTick, load])

  // Live cross-device refresh. `load` is race-guarded and swaps `data` in place
  // without touching `loading`, so an incoming order change updates the table
  // silently. Paused while the order form modal is open so it can never disturb a
  // half-filled order; applied once the modal closes.
  const salesRemoteDirtyRef = useRef(false)
  useRealtimeSync(
    'sales',
    () => {
      if (formOpen) {
        salesRemoteDirtyRef.current = true
        return
      }
      void load(filters, page)
    },
    user != null
  )
  useEffect(() => {
    if (!formOpen && salesRemoteDirtyRef.current) {
      salesRemoteDirtyRef.current = false
      void load(filters, page)
    }
  }, [formOpen, filters, page, load])

  // Order form reference data: active products plus the ledger-derived pools.
  useEffect(() => {
    if (!canCreate) return
    let cancelled = false
    const loadForm = async () => {
      try {
        const [productData, summaryData] = await Promise.all([
          apiJson<ProductView[]>('/api/products'),
          apiJson<StockSummaryView>('/api/stock/summary'),
        ])
        if (cancelled) return
        setProducts(productData.filter((p) => p.isActive))
        const map: Record<string, StockPools> = {}
        for (const item of summaryData.items) {
          for (const row of item.byLocation) {
            map[`${item._id}|${row.location}`] = {
              available: row.available,
              damaged: row.damaged,
              returned: row.returned,
            }
          }
        }
        setPools(map)
      } catch {
        // Not fatal: opening the form with no products just shows the picker empty.
      }
    }
    void loadForm()
    return () => {
      cancelled = true
    }
  }, [canCreate])

  // Channels already used, as free-text suggestions in the order form.
  const channels = useMemo(() => {
    const set = new Set<string>()
    for (const order of data?.orders ?? []) if (order.salesChannel) set.add(order.salesChannel)
    return [...set].sort()
  }, [data])

  const handleSaved = (order: OrderView, created: boolean) => {
    setToast({
      type: 'success',
      message: created
        ? `${order.orderNumber} created — stock reserved at ${
            LOCATION_LABELS[order.shipFromLocation ?? ''] ?? order.shipFromLocation ?? 'the'
          } location.`
        : `${order.orderNumber} updated and re-reserved.`,
    })
    setPage(1)
    setReloadTick((t) => t + 1)
  }

  const columns = [
    { key: 'number', label: 'Order' },
    { key: 'date', label: 'Date' },
    { key: 'customer', label: 'Customer' },
    { key: 'items', label: 'Items' },
    { key: 'total', label: 'Total' },
    { key: 'channel', label: 'Channel' },
    { key: 'status', label: 'Status' },
    { key: 'payment', label: 'COD' },
    { key: 'actions', label: '' },
  ]

  const rows = (data?.orders ?? []).map((order) => ({
    _id: order._id,
    number: <span className="font-mono text-xs text-ink-secondary">{order.orderNumber}</span>,
    date: formatKarachiDate(new Date(order.createdAt), 'date'),
    customer: (
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-decoricks-dark">{order.customerName}</p>
        <p className="text-xs text-ink-muted">
          {order.customerCity} · {order.customerPhone}
        </p>
      </div>
    ),
    items: (
      <span>
        {order.items.reduce((sum, i) => sum + i.quantity, 0)}
        <span className="ml-1 text-xs text-ink-muted">
          ({order.items.length} line{order.items.length === 1 ? '' : 's'})
        </span>
      </span>
    ),
    total: <span className="font-medium text-decoricks-dark">{formatPaisa(order.total)}</span>,
    channel: (
      <span className="text-xs text-ink-secondary">
        {order.salesChannel}
        {order.shipFromLocation && (
          <span className="block text-xs text-ink-muted">
            from {LOCATION_LABELS[order.shipFromLocation] ?? order.shipFromLocation}
          </span>
        )}
      </span>
    ),
    status: (
      <Badge variant={ORDER_STATUS_BADGE[order.orderStatus] ?? 'default'} size="sm">
        {ORDER_STATUS_LABELS[order.orderStatus] ?? order.orderStatus}
      </Badge>
    ),
    payment: (
      <span className="text-xs text-ink-secondary">
        {order.paymentStatus === 'received'
          ? 'Cash received'
          : order.paymentStatus === 'refunded'
            ? 'Refunded'
            : (COD_OUTCOME_LABELS[order.codOutcome] ?? order.codOutcome)}
      </span>
    ),
    actions: (
      <Link
        href={`/sales/${order._id}`}
        className="inline-flex h-11 min-h-[44px] items-center rounded-md px-3 text-sm font-medium text-decoricks-brown hover:underline md:h-10"
      >
        Open
      </Link>
    ),
  }))

  const exportHref = `/api/orders/export?${buildFilterQuery(filters)}`

  return (
    <PageTransition>
      <PageHeader
        title="Sales"
        description="COD orders. Creating an order reserves stock at the ship-from location; income is only posted when cash is confirmed received."
        actions={
          <>
            <ExportLink href={exportHref} />
            {canCreate && canShipAnywhere && (
              <Button onClick={() => setFormOpen(true)}>New order</Button>
            )}
          </>
        }
      />

      <SubNav items={SALES_SUBNAV} />

      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      {/* Filters */}
      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            label="Search"
            placeholder="Order #, name or phone…"
            value={filters.search}
            onChange={(e) => setFilter({ search: e.target.value })}
          />
          <Select
            label="Status"
            value={filters.status}
            onChange={(e) => setFilter({ status: e.target.value })}
            options={[
              { value: '', label: 'All statuses' },
              ...ORDER_STATUSES.map((s) => ({ value: s, label: ORDER_STATUS_LABELS[s] ?? s })),
            ]}
          />
          <Select
            label="Payment"
            value={filters.paymentStatus}
            onChange={(e) => setFilter({ paymentStatus: e.target.value })}
            options={[
              { value: '', label: 'Any payment state' },
              ...PAYMENT_STATUSES.map((s) => ({ value: s, label: PAYMENT_STATUS_LABELS[s] ?? s })),
            ]}
          />
          <Select
            label="Location shipped from"
            value={filters.location}
            onChange={(e) => setFilter({ location: e.target.value })}
            options={[
              { value: '', label: 'All locations' },
              { value: 'sheikhupura', label: 'Sheikhupura' },
              { value: 'lahore', label: 'Lahore' },
            ]}
          />
          <Input
            label="Channel"
            placeholder="e.g. instagram"
            value={filters.channel}
            onChange={(e) => setFilter({ channel: e.target.value })}
          />
          <Input
            label="From (Karachi date)"
            type="date"
            value={filters.from}
            onChange={(e) => setFilter({ from: e.target.value })}
          />
          <Input
            label="To (Karachi date)"
            type="date"
            value={filters.to}
            onChange={(e) => setFilter({ to: e.target.value })}
          />
          <div className="flex items-end">
            <Button
              variant="outline"
              onClick={() => {
                setFilters(EMPTY_FILTERS)
                setPage(1)
              }}
            >
              Clear filters
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        {loading ? (
          <div className="p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} variant="rect" className="mb-2 h-12" />
            ))}
          </div>
        ) : error ? (
          <ErrorState
            title="Could not load orders"
            description={error}
            action={{ label: 'Retry', onClick: () => void load({ ...filters }, page) }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={
              filters.search ||
              filters.status ||
              filters.paymentStatus ||
              filters.channel ||
              filters.location ||
              filters.from ||
              filters.to
                ? 'No orders match'
                : 'No orders yet'
            }
            description={
              filters.search ||
              filters.status ||
              filters.paymentStatus ||
              filters.channel ||
              filters.location ||
              filters.from ||
              filters.to
                ? 'Try widening the filters or the date range.'
                : 'Create the first order when a customer confirms on COD.'
            }
            action={
              canCreate && canShipAnywhere
                ? { label: 'New order', onClick: () => setFormOpen(true) }
                : undefined
            }
          />
        ) : (
          <>
            <div className="hidden md:block">
              <Table
                caption="Orders"
                columns={columns}
                data={rows}
                rowKey="_id"
                pagination={{
                  currentPage: data?.pagination.page ?? 1,
                  totalPages: data?.pagination.totalPages ?? 1,
                  onPageChange: setPage,
                }}
              />
            </div>
            <ul className="divide-y divide-line-subtle md:hidden">
              {(data?.orders ?? []).map((order) => (
                <li key={order._id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-decoricks-dark">
                        {order.customerName}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {order.orderNumber} · {formatKarachiDate(new Date(order.createdAt), 'date')}
                      </p>
                    </div>
                    <Badge variant={ORDER_STATUS_BADGE[order.orderStatus] ?? 'default'} size="sm">
                      {ORDER_STATUS_LABELS[order.orderStatus] ?? order.orderStatus}
                    </Badge>
                  </div>
                  <div className="mt-2 flex items-end justify-between gap-2">
                    <p className="text-xs text-ink-secondary">
                      {order.items.reduce((sum, i) => sum + i.quantity, 0)} units ·{' '}
                      {order.salesChannel}
                      {order.shipFromLocation &&
                        ` · from ${LOCATION_LABELS[order.shipFromLocation] ?? order.shipFromLocation}`}
                    </p>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-decoricks-dark">
                        {formatPaisa(order.total)}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {order.paymentStatus === 'received'
                          ? 'Cash received'
                          : order.paymentStatus === 'refunded'
                            ? 'Refunded'
                            : (COD_OUTCOME_LABELS[order.codOutcome] ?? order.codOutcome)}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2">
                    <Link
                      href={`/sales/${order._id}`}
                      className="inline-flex h-11 min-h-[44px] items-center rounded-md px-3 text-sm font-medium text-decoricks-brown hover:underline"
                    >
                      Open order
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-3 px-4 py-3 md:hidden">
              <p className="text-xs text-ink-muted">
                Page {data?.pagination.page ?? 1} of {data?.pagination.totalPages ?? 1} ·{' '}
                {data?.pagination.total ?? 0} orders
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(data?.pagination.page ?? 1) <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(data?.pagination.page ?? 1) >= (data?.pagination.totalPages ?? 1)}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
            <p className="hidden px-4 pb-3 pt-1 text-xs text-ink-muted md:block">
              {data?.pagination.total ?? 0} matching orders
            </p>
          </>
        )}
      </Card>

      <OrderFormModal
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        order={null}
        products={products}
        pools={pools}
        canWriteLocation={canWriteLocation}
        channels={channels}
        onSaved={handleSaved}
      />
    </PageTransition>
  )
}
