'use client'

/**
 * Inventory Overview (SPEC §2.1, §5.7).
 *
 * Stock by location, valuation, the low-stock list and the calculation panel.
 * Every number on this screen is DERIVED from the movement ledger — there is
 * no editable stock figure anywhere, which is the point of Phase 5: the shelf
 * is what the movements say it is.
 *
 * The action buttons (transfer, physical count, damage/write-off) open the
 * modals that post movements; they are hidden when the signed-in role cannot
 * write stock at ANY location (the modals themselves then restrict the
 * location pickers, and the API remains the authority).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageTransition } from '@/components/PageTransition'
import { PageHeader } from '@/components/layout/Page'
import { SubNav } from '@/components/layout/SubNav'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
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
import { useAuth } from '@/components/auth/AuthProvider'
import { canWriteStockLocation } from '@/lib/permissions-client'
import {
  INVENTORY_SUBNAV,
  type StockPools,
  type StockSummaryView,
} from '@/modules/inventory/inventory-ui'
import { CountModal, DamageModal, TransferModal } from '@/modules/inventory/StockActionModals'
import { InventoryCalcPanel } from '@/modules/inventory/InventoryCalcPanel'
import { useRealtimeSync } from '@/lib/sync/useRealtime'

const LOCATION_LABELS: Record<string, string> = {
  sheikhupura: 'Sheikhupura',
  lahore: 'Lahore',
}

export default function InventoryOverviewPage() {
  const { user } = useAuth()

  const [data, setData] = useState<StockSummaryView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stockFilter, setStockFilter] = useState<'all' | 'low'>('all')
  const [toast, setToast] = useState<string | null>(null)

  const [transferOpen, setTransferOpen] = useState(false)
  const [countOpen, setCountOpen] = useState(false)
  const [damageOpen, setDamageOpen] = useState(false)

  const requestSeq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const canWriteSheikhupura = user
    ? canWriteStockLocation({ role: user.role }, 'sheikhupura')
    : false
  const canWriteLahore = user ? canWriteStockLocation({ role: user.role }, 'lahore') : false
  const canWriteAnyStock = canWriteSheikhupura || canWriteLahore
  const canWriteLocation = useCallback(
    (location: string) => canWriteStockLocation({ role: user?.role ?? '' }, location),
    [user?.role]
  )

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      // Archived products are included on purpose: their stock is still real
      // and still on the valuation. Rows for fully exhausted archived products
      // are filtered out of the table below.
      const result = await apiJson<StockSummaryView>('/api/stock/summary?includeArchived=true', {
        signal: controller.signal,
      })
      if (seq === requestSeq.current) {
        setData(result)
        setError(null)
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : 'Failed to load stock overview')
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => abortRef.current?.abort()
  }, [load])

  // Live cross-device refresh. `load()` keeps existing data painted until the
  // new snapshot arrives, so this updates in place with no flicker. It is paused
  // while a stock-action modal is open (so a remote change can never clobber a
  // half-filled transfer/count/damage form) and applied once on close.
  const stockModalOpen = transferOpen || countOpen || damageOpen
  const remoteDirtyRef = useRef(false)
  useRealtimeSync(
    'inventory',
    () => {
      if (stockModalOpen) {
        remoteDirtyRef.current = true
        return
      }
      void load()
    },
    user != null
  )
  useEffect(() => {
    if (!stockModalOpen && remoteDirtyRef.current) {
      remoteDirtyRef.current = false
      void load()
    }
  }, [stockModalOpen, load])

  const pools = useMemo(() => {
    const map: Record<string, StockPools> = {}
    for (const item of data?.items ?? []) {
      for (const row of item.byLocation) {
        map[`${item._id}|${row.location}`] = {
          available: row.available,
          damaged: row.damaged,
          returned: row.returned,
        }
      }
    }
    return map
  }, [data])

  const pickerProducts = useMemo(
    () =>
      (data?.items ?? []).map((item) => ({
        _id: item._id,
        sku: item.sku,
        name: item.name,
      })),
    [data]
  )

  const rows = useMemo(() => {
    let items = (data?.items ?? []).filter(
      (item) =>
        item.isActive || item.totalAvailable > 0 || item.totalDamaged > 0 || item.totalReturned > 0
    )
    if (stockFilter === 'low') items = items.filter((item) => item.lowStock)
    return items
  }, [data, stockFilter])

  const handleDone = (message: string) => {
    setToast(message)
    void load()
  }

  const columns = [
    { key: 'name', label: 'Product' },
    { key: 'sheikhupura', label: 'Sheikhupura' },
    { key: 'lahore', label: 'Lahore' },
    { key: 'damaged', label: 'Damaged' },
    { key: 'returned', label: 'Returned' },
    { key: 'reorder', label: 'Reorder at' },
    { key: 'valuation', label: 'Valuation' },
  ]

  const tableRows = rows.map((item) => {
    const sheikhupura = item.byLocation.find((l) => l.location === 'sheikhupura')
    const lahore = item.byLocation.find((l) => l.location === 'lahore')
    return {
      _id: item._id,
      name: (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-decoricks-dark">{item.name}</p>
          <p className="text-xs text-ink-muted">
            {item.sku}
            {!item.isActive && (
              <Badge variant="default" size="sm" className="ml-2">
                Archived
              </Badge>
            )}
            {item.lowStock && (
              <Badge variant="warning" size="sm" className="ml-2">
                Low stock
              </Badge>
            )}
          </p>
        </div>
      ),
      sheikhupura: (
        <span className={sheikhupura?.available ? '' : 'text-ink-muted'}>
          {sheikhupura?.available ?? 0}
        </span>
      ),
      lahore: (
        <span className={lahore?.available ? '' : 'text-ink-muted'}>{lahore?.available ?? 0}</span>
      ),
      damaged: (
        <span className={item.totalDamaged ? 'text-status-warning' : 'text-ink-muted'}>
          {item.totalDamaged}
        </span>
      ),
      returned: (
        <span className={item.totalReturned ? 'text-ink-secondary' : 'text-ink-muted'}>
          {item.totalReturned}
        </span>
      ),
      reorder: (
        <span className="text-ink-muted">
          {item.reorderLevel === null ? '—' : item.reorderLevel}
        </span>
      ),
      valuation: (
        <span className="font-medium text-decoricks-dark">{formatPaisa(item.valuation)}</span>
      ),
    }
  })

  return (
    <PageTransition>
      <PageHeader
        title="Inventory"
        description="Stock by location, valued at weighted average cost. Every figure is derived from the movement ledger."
        actions={
          <>
            <ExportLink href="/api/stock/export" />
            {canWriteAnyStock && (
              <>
                <Button variant="outline" onClick={() => setCountOpen(true)}>
                  Physical count
                </Button>
                <Button variant="outline" onClick={() => setDamageOpen(true)}>
                  Damage / write-off
                </Button>
                <Button onClick={() => setTransferOpen(true)}>Transfer stock</Button>
              </>
            )}
          </>
        }
      />

      <SubNav items={INVENTORY_SUBNAV} />

      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast} type="success" onClose={() => setToast(null)} />
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} variant="rect" className="h-24" />
            ))}
          </div>
          <Skeleton variant="rect" className="h-64" />
        </div>
      ) : error ? (
        <Card className="p-4">
          <ErrorState
            title="Could not load inventory"
            description={error}
            action={{ label: 'Retry', onClick: () => void load() }}
          />
        </Card>
      ) : !data ? null : (
        <>
          {/* Headline figures */}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card className="p-4">
              <p className="text-xs text-ink-muted">Inventory valuation</p>
              <p className="mt-1 text-lg font-semibold text-decoricks-dark">
                {formatPaisa(data.totals.totalValuation)}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-ink-muted">Products tracked</p>
              <p className="mt-1 text-lg font-semibold text-decoricks-dark">
                {data.totals.productCount}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-ink-muted">Low stock</p>
              <p
                className={`mt-1 text-lg font-semibold ${
                  data.totals.lowStockCount > 0 ? 'text-status-warning' : 'text-decoricks-dark'
                }`}
              >
                {data.totals.lowStockCount}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-ink-muted">Damaged / returned units</p>
              <p className="mt-1 text-lg font-semibold text-decoricks-dark">
                {data.totals.totalDamaged} / {data.totals.totalReturned}
              </p>
            </Card>
          </div>

          {/* Stock by location */}
          <div className="mb-4 grid gap-3 md:grid-cols-2">
            {data.totals.byLocation.map((loc) => (
              <Card key={loc.location} className="p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-decoricks-dark">
                    {LOCATION_LABELS[loc.location] ?? loc.location}
                  </p>
                  {!canWriteLocation(loc.location) && (
                    <Badge variant="default" size="sm">
                      Read-only for you
                    </Badge>
                  )}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-ink-muted">Available</dt>
                    <dd className="font-semibold text-decoricks-dark">{loc.available}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-muted">Damaged</dt>
                    <dd
                      className={
                        loc.damaged ? 'font-semibold text-status-warning' : 'text-ink-muted'
                      }
                    >
                      {loc.damaged}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-muted">Returned</dt>
                    <dd className="text-ink-secondary">{loc.returned}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-muted">Valuation</dt>
                    <dd className="font-semibold text-decoricks-dark">
                      {formatPaisa(loc.valuation)}
                    </dd>
                  </div>
                </dl>
              </Card>
            ))}
          </div>

          {/* Stock table */}
          <Card className="mb-4">
            <div className="flex flex-col gap-3 border-b border-line-subtle p-4 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-md font-semibold text-decoricks-dark">Stock by product</h2>
              <Select
                aria-label="Stock filter"
                value={stockFilter}
                onChange={(e) => setStockFilter(e.target.value as 'all' | 'low')}
                options={[
                  { value: 'all', label: 'All products' },
                  { value: 'low', label: 'Low stock only' },
                ]}
                className="w-full sm:w-48"
              />
            </div>

            {rows.length === 0 ? (
              <EmptyState
                title={stockFilter === 'low' ? 'Nothing is low on stock' : 'No stock yet'}
                description={
                  stockFilter === 'low'
                    ? 'Every product with a reorder level is above it.'
                    : 'Record a purchase to put the first units on the shelf.'
                }
                action={
                  stockFilter === 'low'
                    ? { label: 'Show all products', onClick: () => setStockFilter('all') }
                    : undefined
                }
              />
            ) : (
              <>
                <div className="hidden md:block">
                  <Table
                    caption="Stock by product and location"
                    columns={columns}
                    data={tableRows}
                    rowKey="_id"
                  />
                </div>
                <ul className="divide-y divide-line-subtle md:hidden">
                  {rows.map((item) => (
                    <li key={item._id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-decoricks-dark">
                            {item.name}
                          </p>
                          <p className="text-xs text-ink-muted">{item.sku}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold text-decoricks-dark">
                            {formatPaisa(item.valuation)}
                          </p>
                          <p className="text-xs text-ink-muted">
                            {item.totalAvailable} units available
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        {item.byLocation.map((loc) => (
                          <span
                            key={loc.location}
                            className="rounded-md bg-surface-sunken px-2 py-1 text-ink-secondary"
                          >
                            {LOCATION_LABELS[loc.location] ?? loc.location}: {loc.available}{' '}
                            available
                            {loc.damaged > 0 && ` · ${loc.damaged} damaged`}
                            {loc.returned > 0 && ` · ${loc.returned} returned`}
                          </span>
                        ))}
                        {item.lowStock && (
                          <Badge variant="warning" size="sm">
                            Low stock
                          </Badge>
                        )}
                        {!item.isActive && (
                          <Badge variant="default" size="sm">
                            Archived
                          </Badge>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          {/* SPEC §5.7 calculation panel */}
          <InventoryCalcPanel />
        </>
      )}

      <div className="mt-6" />

      <TransferModal
        isOpen={transferOpen}
        onClose={() => setTransferOpen(false)}
        products={pickerProducts}
        pools={pools}
        canWriteLocation={canWriteLocation}
        onDone={handleDone}
      />
      <CountModal
        isOpen={countOpen}
        onClose={() => setCountOpen(false)}
        products={pickerProducts}
        pools={pools}
        canWriteLocation={canWriteLocation}
        onDone={handleDone}
      />
      <DamageModal
        isOpen={damageOpen}
        onClose={() => setDamageOpen(false)}
        products={pickerProducts}
        pools={pools}
        canWriteLocation={canWriteLocation}
        onDone={handleDone}
      />
    </PageTransition>
  )
}
