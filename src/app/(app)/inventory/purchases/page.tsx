'use client'

/**
 * Purchases screen (SPEC §5.4).
 *
 * Recording a purchase adds stock at a cost, restates the weighted average
 * cost and posts the linked `product_purchasing` ledger expense — in one
 * server-side transaction. Cancelling does the same in reverse: a linked
 * reversal movement and a reversal expense, never an edit. Transfers between
 * locations are NOT purchases; they live in the movements ledger.
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
import { Modal } from '@/components/ui/Modal'
import { Table } from '@/components/ui/Table'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Toast } from '@/components/ui/Toast'
import { ApiError, apiJson, apiPost } from '@/lib/api-client'
import { newIdempotencyKey } from '@/lib/form-helpers'
import { formatPaisa } from '@/lib/money'
import { formatKarachiDate } from '@/lib/date'
import { useAuth } from '@/components/auth/AuthProvider'
import { canWriteStockLocation } from '@/lib/permissions-client'
import { type AccountView } from '@/modules/finance/finance-ui'
import {
  INVENTORY_SUBNAV,
  appendRangeParams,
  type ProductView,
  type PurchaseView,
  type PurchasesView,
} from '@/modules/inventory/inventory-ui'
import { PurchaseFormModal, type SupplierOption } from '@/modules/inventory/PurchaseFormModal'

const LIMIT = 25

const LOCATION_LABELS: Record<string, string> = {
  sheikhupura: 'Sheikhupura',
  lahore: 'Lahore',
}

const EMPTY_FILTERS = { productId: '', supplierId: '', location: '', from: '', to: '' }
type Filters = typeof EMPTY_FILTERS

export default function PurchasesPage() {
  const { user } = useAuth()
  const canWriteSheikhupura = user ? canWriteStockLocation({ role: user.role }, 'sheikhupura') : false
  const canWriteLahore = user ? canWriteStockLocation({ role: user.role }, 'lahore') : false
  const canWriteAny = canWriteSheikhupura || canWriteLahore
  const canWriteLocation = useCallback(
    (location: string) => canWriteStockLocation({ role: user?.role ?? '' }, location),
    [user?.role]
  )

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<PurchasesView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [products, setProducts] = useState<ProductView[]>([])
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [accounts, setAccounts] = useState<AccountView[]>([])

  const [formOpen, setFormOpen] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<PurchaseView | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [cancelSaving, setCancelSaving] = useState(false)
  const cancelSavingRef = useRef(false)
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

    const params = new URLSearchParams()
    if (currentFilters.productId) params.set('productId', currentFilters.productId)
    if (currentFilters.supplierId) params.set('supplierId', currentFilters.supplierId)
    if (currentFilters.location) params.set('location', currentFilters.location)
    appendRangeParams(params, { from: currentFilters.from, to: currentFilters.to })
    params.set('page', String(currentPage))
    params.set('limit', String(LIMIT))

    try {
      const result = await apiJson<PurchasesView>(`/api/purchases?${params.toString()}`, {
        signal: controller.signal,
      })
      if (seq === requestSeq.current) {
        setData(result)
        setError(null)
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : 'Failed to load purchases')
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

  // Reference data for the form and filters; failures are not fatal here.
  useEffect(() => {
    let cancelled = false
    const loadReference = async () => {
      try {
        const [productData, supplierData, accountData] = await Promise.all([
          apiJson<ProductView[]>('/api/products'),
          apiJson<{ _id: string; name: string; isActive: boolean }[]>('/api/suppliers'),
          apiJson<{ accounts: AccountView[] }>('/api/finance/accounts'),
        ])
        if (cancelled) return
        setProducts(productData.filter((p) => p.isActive))
        setSuppliers(supplierData.filter((s) => s.isActive).map((s) => ({ _id: s._id, name: s.name })))
        setAccounts(accountData.accounts)
      } catch {
        // The list itself still loads; the form surfaces server errors.
      }
    }
    void loadReference()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSaved = (purchase: PurchaseView, wacBefore: number, wacAfter: number, replayed: boolean) => {
    setToast({
      type: 'success',
      message: replayed
        ? 'This purchase was already recorded — nothing was added twice.'
        : `${purchase.productName}: +${purchase.quantity} units at ${formatPaisa(purchase.unitCost)}. ` +
          `Average cost moved from ${formatPaisa(wacBefore)} to ${formatPaisa(wacAfter)}.`,
    })
    setPage(1)
    setReloadTick((t) => t + 1)
  }

  const submitCancel = async () => {
    if (!cancelTarget || cancelSavingRef.current) return
    if (!cancelReason.trim()) {
      setCancelError('A reason is required — cancellations must be auditable.')
      return
    }
    cancelSavingRef.current = true
    setCancelSaving(true)
    setCancelError(null)
    try {
      await apiPost(`/api/purchases/${cancelTarget._id}/cancel`, {
        reason: cancelReason.trim(),
        idempotencyKey: `purchase-cancel-${cancelTarget._id}-${newIdempotencyKey()}`,
      })
      setToast({
        type: 'success',
        message: `${cancelTarget.purchaseNumber} cancelled. Stock reversed and the expense was credited back via a linked reversal entry.`,
      })
      setCancelTarget(null)
      setCancelReason('')
      setReloadTick((t) => t + 1)
    } catch (err) {
      setCancelError(
        err instanceof ApiError
          ? err.message
          : 'Could not cancel the purchase. Nothing was changed — try again.'
      )
    } finally {
      cancelSavingRef.current = false
      setCancelSaving(false)
    }
  }

  const columns = [
    { key: 'number', label: 'Purchase #' },
    { key: 'date', label: 'Date' },
    { key: 'product', label: 'Product' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'location', label: 'Into' },
    { key: 'quantity', label: 'Qty' },
    { key: 'unitCost', label: 'Unit cost' },
    { key: 'total', label: 'Total' },
    ...(canWriteAny ? [{ key: 'actions', label: 'Actions' }] : []),
  ]

  const cancellable = (purchase: PurchaseView): boolean =>
    canWriteLocation(purchase.location) && Boolean(purchase.movementId)

  const rows = (data?.items ?? []).map((purchase) => ({
    _id: purchase._id,
    number: <span className="font-mono text-xs text-ink-secondary">{purchase.purchaseNumber}</span>,
    date: formatKarachiDate(new Date(purchase.date), 'date'),
    product: (
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-decoricks-dark">{purchase.productName}</p>
        {purchase.notes && <p className="truncate text-xs text-ink-muted">{purchase.notes}</p>}
      </div>
    ),
    supplier: purchase.supplierName ?? <span className="text-ink-muted">—</span>,
    location: LOCATION_LABELS[purchase.location] ?? purchase.location,
    quantity: `+${purchase.quantity}`,
    unitCost: formatPaisa(purchase.unitCost),
    total: <span className="font-medium text-decoricks-dark">{formatPaisa(purchase.totalCost)}</span>,
    actions: cancellable(purchase) ? (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setCancelTarget(purchase)
          setCancelReason('')
          setCancelError(null)
        }}
      >
        Cancel
      </Button>
    ) : null,
  }))

  return (
    <PageTransition>
      <PageHeader
        title="Purchases"
        description="Goods received: stock in at cost, weighted average cost restated, ledger expense posted — one action."
        actions={canWriteAny ? <Button onClick={() => setFormOpen(true)}>Record purchase</Button> : undefined}
      />

      <SubNav items={INVENTORY_SUBNAV} />

      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
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
            label="Supplier"
            value={filters.supplierId}
            onChange={(e) => setFilter({ supplierId: e.target.value })}
            options={[
              { value: '', label: 'All suppliers' },
              ...suppliers.map((s) => ({ value: s._id, label: s.name })),
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

      {data && (
        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-ink-muted">Spend on this page (filtered)</p>
            <p className="text-lg font-semibold text-decoricks-dark">
              {formatPaisa(data.totals.filteredSpendPaisa)}
            </p>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            Every purchase here also appears in the ledger under product purchasing.
          </p>
        </Card>
      )}

      <Card>
        {loading ? (
          <div className="p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} variant="rect" className="mb-2 h-12" />
            ))}
          </div>
        ) : error ? (
          <ErrorState
            title="Could not load purchases"
            description={error}
            action={{ label: 'Retry', onClick: () => void load({ ...filters }, page) }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={
              filters.productId || filters.supplierId || filters.location || filters.from || filters.to
                ? 'No purchases match'
                : 'No purchases recorded yet'
            }
            description={
              filters.productId || filters.supplierId || filters.location || filters.from || filters.to
                ? 'Try widening the filters.'
                : 'Recording a purchase is what puts stock on the shelf.'
            }
            action={
              canWriteAny ? { label: 'Record purchase', onClick: () => setFormOpen(true) } : undefined
            }
          />
        ) : (
          <>
            <div className="hidden md:block">
              <Table
                caption="Purchases"
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
              {(data?.items ?? []).map((purchase) => (
                <li key={purchase._id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-decoricks-dark">
                        {purchase.productName}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {purchase.purchaseNumber} · {formatKarachiDate(new Date(purchase.date), 'date')}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-decoricks-dark">
                        {formatPaisa(purchase.totalCost)}
                      </p>
                      <p className="text-xs text-status-success">+{purchase.quantity} units</p>
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-ink-secondary">
                    {LOCATION_LABELS[purchase.location] ?? purchase.location} ·{' '}
                    {purchase.supplierName ?? 'No supplier'} · {formatPaisa(purchase.unitCost)} / unit
                  </p>
                  {cancellable(purchase) && (
                    <div className="mt-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setCancelTarget(purchase)
                          setCancelReason('')
                          setCancelError(null)
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-3 px-4 py-3 md:hidden">
              <p className="text-xs text-ink-muted">
                Page {data?.pagination.page ?? 1} of {data?.pagination.totalPages ?? 1} ·{' '}
                {data?.pagination.total ?? 0} purchases
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
              {data?.pagination.total ?? 0} matching purchases ·{' '}
              <Link href="/inventory/movements" className="text-decoricks-brown hover:underline">
                see the movement behind each one
              </Link>
            </p>
          </>
        )}
      </Card>

      <PurchaseFormModal
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        products={products}
        suppliers={suppliers}
        accounts={accounts}
        canWriteLocation={canWriteLocation}
        onSaved={handleSaved}
      />

      <Modal
        isOpen={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        title={cancelTarget ? `Cancel ${cancelTarget.purchaseNumber}?` : 'Cancel purchase'}
        description="This posts a reversal movement and a linked reversal expense. Nothing is deleted."
        size="sm"
        dismissible={!cancelSaving}
        footer={
          <>
            <Button variant="outline" onClick={() => setCancelTarget(null)} disabled={cancelSaving}>
              Keep purchase
            </Button>
            <Button onClick={() => void submitCancel()} disabled={cancelSaving}>
              {cancelSaving ? 'Cancelling…' : 'Cancel purchase'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-ink-secondary">
            {cancelTarget
              ? `${cancelTarget.productName}: ${cancelTarget.quantity} units at ${formatPaisa(
                  cancelTarget.unitCost
                )} into ${LOCATION_LABELS[cancelTarget.location] ?? cancelTarget.location}.`
              : ''}
          </p>
          {cancelTarget && !cancellable(cancelTarget) && (
            <Badge variant="warning" size="sm">
              You cannot write stock at this location
            </Badge>
          )}
          <Input
            label="Reason"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="e.g. goods returned to supplier"
            error={cancelError ?? undefined}
            disabled={cancelSaving}
          />
        </div>
      </Modal>
    </PageTransition>
  )
}
