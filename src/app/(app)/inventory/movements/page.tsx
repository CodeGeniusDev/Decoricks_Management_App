'use client'

/**
 * Stock movements — the append-only ledger (SPEC §3.1.5).
 *
 * Read-only by design: a posted movement is never edited or deleted. The
 * only write here is a linked REVERSAL, offered when the role can write the
 * stock the movement touched. Corrections stay visible as a pair — the
 * original plus its reversal — so the audit trail is the whole story.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { Toast } from '@/components/ui/Toast'
import { apiJson } from '@/lib/api-client'
import { formatPaisa } from '@/lib/money'
import { formatKarachiDate } from '@/lib/date'
import { useAuth } from '@/components/auth/AuthProvider'
import { canWriteStockLocation } from '@/lib/permissions-client'
import type { MovementType } from '@/lib/stock-math'
import {
  INVENTORY_SUBNAV,
  MOVEMENT_BADGE_VARIANT,
  appendRangeParams,
  type MovementView,
  type MovementsView,
  type ProductView,
} from '@/modules/inventory/inventory-ui'
import { ReverseMovementModal } from '@/modules/inventory/StockActionModals'

const LIMIT = 50

const MOVEMENT_LABELS: Record<MovementType, string> = {
  purchase_in: 'Purchase in',
  sale_out: 'Sale out',
  return_restock: 'Return — restocked',
  return_damaged: 'Return — damaged',
  return_writeoff: 'Return — written off',
  damage: 'Damage',
  writeoff: 'Write-off',
  transfer: 'Transfer',
  adjustment: 'Adjustment',
}

const LOCATION_LABELS: Record<string, string> = {
  sheikhupura: 'Sheikhupura',
  lahore: 'Lahore',
}

const EMPTY_FILTERS = {
  productId: '',
  movementType: '',
  location: '',
  from: '',
  to: '',
}

type Filters = typeof EMPTY_FILTERS

export default function StockMovementsPage() {
  const { user } = useAuth()
  const canWrite = user
    ? canWriteStockLocation({ role: user.role }, 'sheikhupura') ||
      canWriteStockLocation({ role: user.role }, 'lahore')
    : false

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<MovementsView | null>(null)
  const [products, setProducts] = useState<ProductView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reverseTarget, setReverseTarget] = useState<MovementView | null>(null)
  const [toast, setToast] = useState<string | null>(null)

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

    const params = new URLSearchParams()
    if (currentFilters.productId) params.set('productId', currentFilters.productId)
    if (currentFilters.movementType) params.set('movementType', currentFilters.movementType)
    if (currentFilters.location) params.set('location', currentFilters.location)
    appendRangeParams(params, { from: currentFilters.from, to: currentFilters.to })
    params.set('page', String(currentPage))
    params.set('limit', String(LIMIT))

    try {
      const result = await apiJson<MovementsView>(`/api/stock/movements?${params.toString()}`, {
        signal: controller.signal,
      })
      if (seq === requestSeq.current) {
        setData(result)
        setError(null)
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : 'Failed to load stock movements')
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    const timer = setTimeout(() => void load(filters, page), 0)
    return () => clearTimeout(timer)
  }, [filters, page, reloadTick, load])

  // Product picker options — every product, because archived ones still have
  // a movement history that must stay findable.
  useEffect(() => {
    let cancelled = false
    apiJson<ProductView[]>('/api/products')
      .then((result) => {
        if (!cancelled) setProducts(result)
      })
      .catch(() => {
        // Picker options are not fatal; the list itself still loads.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const canReverseRow = (movement: MovementView): boolean => {
    if (!canWrite) return false
    if (movement.isReversal || movement.status === 'reversed' || movement.reversedBy) return false
    const locs = [movement.fromLocation, movement.toLocation].filter(Boolean) as string[]
    if (locs.length === 0) return true
    return locs.every((location) => canWriteStockLocation({ role: user?.role ?? '' }, location))
  }

  const handleReversed = (message: string) => {
    setToast(message)
    setReverseTarget(null)
    setReloadTick((t) => t + 1)
  }

  const columns = [
    { key: 'date', label: 'Date' },
    { key: 'product', label: 'Product' },
    { key: 'type', label: 'Type' },
    { key: 'quantity', label: 'Qty' },
    { key: 'route', label: 'From → To' },
    { key: 'cost', label: 'Unit cost' },
    { key: 'reference', label: 'Reference' },
    { key: 'status', label: 'Status' },
    ...(canWrite ? [{ key: 'actions', label: 'Actions' }] : []),
  ]

  const rows = (data?.items ?? []).map((movement) => ({
    _id: movement._id,
    date: formatKarachiDate(new Date(movement.date), 'date'),
    product: (
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-decoricks-dark">
          {movement.productName ?? '—'}
        </p>
        {movement.notes && (
          <p className="truncate text-xs text-ink-muted" title={movement.notes}>
            {movement.notes}
          </p>
        )}
      </div>
    ),
    type: (
      <Badge variant={MOVEMENT_BADGE_VARIANT[movement.movementType]} size="sm">
        {MOVEMENT_LABELS[movement.movementType] ?? movement.movementType}
        {movement.isReversal ? ' ↩' : ''}
      </Badge>
    ),
    quantity: (
      <span
        className={
          movement.direction === 'out'
            ? 'font-medium text-status-danger'
            : 'font-medium text-status-success'
        }
      >
        {movement.direction === 'out' ? '−' : '+'}
        {movement.quantity}
      </span>
    ),
    route: (
      <span className="text-xs text-ink-secondary">
        {movement.movementType === 'transfer'
          ? `${LOCATION_LABELS[movement.fromLocation ?? ''] ?? movement.fromLocation ?? '—'} → ${
              LOCATION_LABELS[movement.toLocation ?? ''] ?? movement.toLocation ?? '—'
            }`
          : (LOCATION_LABELS[movement.toLocation ?? movement.fromLocation ?? ''] ??
            movement.toLocation ??
            movement.fromLocation ??
            '—')}
      </span>
    ),
    cost:
      movement.unitCost === undefined || movement.unitCost === null
        ? '—'
        : formatPaisa(movement.unitCost),
    reference: <span className="text-xs text-ink-muted">{movement.referenceType ?? '—'}</span>,
    status:
      movement.isReversal ? (
        <Badge variant="warning" size="sm">
          Reversal
        </Badge>
      ) : movement.status === 'reversed' || movement.reversedBy ? (
        <Badge variant="default" size="sm">
          Reversed
        </Badge>
      ) : (
        <Badge variant="success" size="sm">
          Posted
        </Badge>
      ),
    actions: canReverseRow(movement) ? (
      <Button variant="ghost" size="sm" onClick={() => setReverseTarget(movement)}>
        Reverse
      </Button>
    ) : null,
  }))

  return (
    <PageTransition>
      <PageHeader
        title="Stock movements"
        description="The append-only movement ledger. Mistakes are corrected with linked reversals, never edits."
      />

      <SubNav items={INVENTORY_SUBNAV} />

      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast} type="success" onClose={() => setToast(null)} />
        </div>
      )}

      {/* Filters */}
      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Select
            label="Product"
            value={filters.productId}
            onChange={(e) => setFilter({ productId: e.target.value })}
            options={[
              { value: '', label: 'All products' },
              ...products.map((p) => ({ value: p._id, label: `${p.name} (${p.sku})` })),
            ]}
          />
          <Select
            label="Type"
            value={filters.movementType}
            onChange={(e) => setFilter({ movementType: e.target.value })}
            options={[
              { value: '', label: 'All types' },
              ...Object.entries(MOVEMENT_LABELS).map(([value, label]) => ({ value, label })),
            ]}
          />
          <Select
            label="Location"
            value={filters.location}
            onChange={(e) => setFilter({ location: e.target.value })}
            options={[
              { value: '', label: 'All locations' },
              { value: 'sheikhupura', label: 'Sheikhupura' },
              { value: 'lahore', label: 'Lahore' },
            ]}
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
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} variant="rect" className="mb-2 h-12" />
            ))}
          </div>
        ) : error ? (
          <ErrorState
            title="Could not load movements"
            description={error}
            action={{
              label: 'Retry',
              onClick: () => void load({ ...filters }, page),
            }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No movements found"
            description={
              filters.productId || filters.movementType || filters.location || filters.from || filters.to
                ? 'Nothing matches the current filters.'
                : 'The ledger is empty. Purchases, sales, returns, transfers and counts all write here.'
            }
          />
        ) : (
          <>
            <div className="hidden md:block">
              <Table
                caption="Stock movements"
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
              {(data?.items ?? []).map((movement) => (
                <li key={movement._id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-decoricks-dark">
                        {movement.productName ?? '—'}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {formatKarachiDate(new Date(movement.date), 'date')}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 text-sm font-semibold ${
                        movement.direction === 'out' ? 'text-status-danger' : 'text-status-success'
                      }`}
                    >
                      {movement.direction === 'out' ? '−' : '+'}
                      {movement.quantity}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <Badge variant={MOVEMENT_BADGE_VARIANT[movement.movementType]} size="sm">
                      {MOVEMENT_LABELS[movement.movementType] ?? movement.movementType}
                    </Badge>
                    {movement.movementType === 'transfer' && (
                      <span className="text-xs text-ink-secondary">
                        {LOCATION_LABELS[movement.fromLocation ?? ''] ?? movement.fromLocation} →{' '}
                        {LOCATION_LABELS[movement.toLocation ?? ''] ?? movement.toLocation}
                      </span>
                    )}
                    {movement.unitCost !== undefined && movement.unitCost !== null && (
                      <span className="text-xs text-ink-muted">@ {formatPaisa(movement.unitCost)}</span>
                    )}
                    {movement.isReversal ? (
                      <Badge variant="warning" size="sm">
                        Reversal
                      </Badge>
                    ) : movement.status === 'reversed' || movement.reversedBy ? (
                      <Badge variant="default" size="sm">
                        Reversed
                      </Badge>
                    ) : null}
                  </div>
                  {movement.notes && (
                    <p className="mt-1 truncate text-xs text-ink-muted">{movement.notes}</p>
                  )}
                  {canReverseRow(movement) && (
                    <div className="mt-2">
                      <Button variant="ghost" size="sm" onClick={() => setReverseTarget(movement)}>
                        Reverse
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-3 px-4 py-3 md:hidden">
              <p className="text-xs text-ink-muted">
                Page {data?.pagination.page ?? 1} of {data?.pagination.totalPages ?? 1} ·{' '}
                {data?.pagination.total ?? 0} movements
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
              {data?.pagination.total ?? 0} matching movements
            </p>
          </>
        )}
      </Card>

      <ReverseMovementModal
        movement={
          reverseTarget
            ? {
                _id: reverseTarget._id,
                productName: reverseTarget.productName,
                movementType: reverseTarget.movementType,
                quantity: reverseTarget.quantity,
                date: reverseTarget.date,
              }
            : null
        }
        onClose={() => setReverseTarget(null)}
        onReversed={handleReversed}
      />
    </PageTransition>
  )
}
