'use client'

/**
 * Order detail — the whole lifecycle in one place (SPEC §5.5).
 *
 * Every button here maps to exactly one PATCH/PUT/DELETE on `/api/orders/[id]`
 * or a POST to `/api/returns`, and the server re-checks the state machine,
 * the stock authorization and the idempotency keys independently. Hiding a
 * button is courtesy; the API is the authority.
 *
 * The money trail is visible: courier expense posted at dispatch, the single
 * income entry when COD cash is confirmed, refund entries after a return.
 * Nothing here lets a typed figure bypass the server — line prices and costs
 * are resolved server-side at create/edit time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { PageTransition } from '@/components/PageTransition'
import { PageHeader } from '@/components/layout/Page'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Table } from '@/components/ui/Table'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Toast } from '@/components/ui/Toast'
import { ApiError, apiDelete, apiJson } from '@/lib/api-client'
import { newIdempotencyKey } from '@/lib/form-helpers'
import { formatPaisa } from '@/lib/money'
import { formatKarachiDate } from '@/lib/date'
import { useAuth } from '@/components/auth/AuthProvider'
import { can, canFullEditOrder, canWriteStockLocation, isFounder } from '@/lib/permissions-client'
import { type AccountView } from '@/modules/finance/finance-ui'
import {
  COD_OUTCOME_LABELS,
  ORDER_STATUS_BADGE,
  ORDER_STATUS_LABELS,
  ORDER_TRANSITIONS,
  PAYMENT_STATUS_LABELS,
  canConfirmCash,
  canRecordRefusal,
  isDeletable,
  isEditable,
  isReturnable,
  type OrderView,
  type ReturnView,
  type ReturnsView,
} from '@/modules/sales/sales-ui'
import type { ProductView, StockPools, StockSummaryView } from '@/modules/inventory/inventory-ui'
import { OrderFormModal } from '@/modules/sales/OrderFormModal'
import { ReturnFormModal } from '@/modules/sales/ReturnFormModal'

const LOCATION_LABELS: Record<string, string> = {
  sheikhupura: 'Sheikhupura',
  lahore: 'Lahore',
}

type ActionKey = 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refused' | 'cash'

export default function OrderDetailPage() {
  const { user } = useAuth()
  const params = useParams<{ id: string }>()
  const orderId = params?.id ?? ''

  const canEdit = user ? can({ role: user.role }, 'sales', 'edit') : false
  const canFullEdit = user ? canFullEditOrder({ role: user.role }) : false
  const canDelete = user ? can({ role: user.role }, 'sales', 'delete') : false
  const isFounderUser = isFounder(user?.role)

  const [order, setOrder] = useState<OrderView | null>(null)
  const [returns, setReturns] = useState<ReturnView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  const [products, setProducts] = useState<ProductView[]>([])
  const [pools, setPools] = useState<Record<string, StockPools>>({})
  const [accounts, setAccounts] = useState<AccountView[]>([])

  const [editOpen, setEditOpen] = useState(false)
  const [returnOpen, setReturnOpen] = useState(false)
  const [confirmAction, setConfirmAction] = useState<ActionKey | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const [actionBusy, setActionBusy] = useState(false)
  const actionBusyRef = useRef(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // One key per pending action attempt, reused when the SAME action is
  // retried after a failure, so a retry cannot double-post.
  const actionKeys = useRef<Partial<Record<ActionKey, string>>>({})

  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const canWriteLocation = useCallback(
    (location: string) => canWriteStockLocation({ role: user?.role ?? '' }, location),
    [user?.role]
  )

  const load = useCallback(async () => {
    if (!orderId) return
    setLoading(true)
    setError(null)
    setNotFound(false)
    try {
      const [orderData, returnsData] = await Promise.all([
        apiJson<OrderView>(`/api/orders/${orderId}`),
        apiJson<ReturnsView>(`/api/returns?orderId=${orderId}`),
      ])
      setOrder(orderData)
      setReturns(returnsData.items)
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
        setNotFound(true)
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load the order')
      }
    } finally {
      setLoading(false)
    }
  }, [orderId])

  useEffect(() => {
    void load()
  }, [load])

  // Reference data for the edit form and the return modal.
  useEffect(() => {
    let cancelled = false
    const loadReference = async () => {
      try {
        const [productData, summaryData, accountData] = await Promise.all([
          apiJson<ProductView[]>('/api/products'),
          apiJson<StockSummaryView>('/api/stock/summary'),
          apiJson<{ accounts: AccountView[] }>('/api/finance/accounts'),
        ])
        if (cancelled) return
        setProducts(productData)
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
        setAccounts(accountData.accounts)
      } catch {
        // Reference data failures surface on the form submit itself.
      }
    }
    void loadReference()
    return () => {
      cancelled = true
    }
  }, [])

  /** One PATCH per lifecycle button, with a retry-stable idempotency key. */
  const patchOrder = async (action: ActionKey, body: Record<string, unknown>) => {
    if (actionBusyRef.current || !order) return
    actionBusyRef.current = true
    setActionBusy(true)
    setActionError(null)
    if (!actionKeys.current[action]) {
      actionKeys.current[action] = `${order._id}:${action}:${newIdempotencyKey()}`
    }
    try {
      const updated = await apiJson<OrderView>(`/api/orders/${order._id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...body, idempotencyKey: actionKeys.current[action] }),
      })
      setOrder(updated)
      delete actionKeys.current[action]
      setConfirmAction(null)
      setToast({ type: 'success', message: successMessage(action, updated) })
      return true
    } catch (err) {
      setActionError(
        err instanceof ApiError
          ? err.message
          : 'Could not reach the server. Press the button again to retry — a retry cannot double-post.'
      )
      return false
    } finally {
      actionBusyRef.current = false
      setActionBusy(false)
    }
  }

  const successMessage = (action: ActionKey, updated: OrderView): string => {
    switch (action) {
      case 'processing':
        return `${updated.orderNumber} is now processing.`
      case 'shipped':
        return updated.courierExpenseTransactionId
          ? `${updated.orderNumber} dispatched. Courier charge posted as a ledger expense.`
          : `${updated.orderNumber} dispatched.`
      case 'delivered':
        return `${updated.orderNumber} marked delivered. Confirm cash when the COD money arrives.`
      case 'cancelled':
        return `${updated.orderNumber} cancelled. Reserved stock was restored exactly once.`
      case 'refused':
        return 'Refusal recorded. Reserved stock was restored; no income was ever posted.'
      case 'cash':
        return `COD cash of ${formatPaisa(updated.total)} received — income posted to the ledger.`
    }
  }

  const handleOrderSaved = (saved: OrderView, created: boolean) => {
    setOrder(saved)
    setEditOpen(false)
    setToast({
      type: 'success',
      message: created
        ? 'Order created.'
        : `${saved.orderNumber} updated. Stock was un-reserved and re-reserved in one step.`,
    })
  }

  const handleReturnSaved = async (created: ReturnView, updatedOrder: OrderView | null) => {
    setReturnOpen(false)
    setToast({
      type: 'success',
      message: `${created.returnNumber} recorded — movements posted and refund entries linked.`,
    })
    if (updatedOrder) setOrder(updatedOrder)
    // Reload so the returns list and stock-linked ids are exactly the server's.
    void load()
  }

  const deleteOrder = async () => {
    if (!order || actionBusyRef.current) return
    actionBusyRef.current = true
    setActionBusy(true)
    try {
      await apiDelete(`/api/orders/${order._id}`)
      window.location.href = '/sales'
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not delete the order.')
      setDeleteOpen(false)
      actionBusyRef.current = false
      setActionBusy(false)
    }
  }

  const transitions = useMemo(
    () => (order ? (ORDER_TRANSITIONS[order.orderStatus] ?? []) : []),
    [order]
  )

  if (loading) {
    return (
      <PageTransition>
        <Skeleton variant="rect" className="mb-4 h-8 w-64" />
        <Skeleton variant="rect" className="mb-4 h-32" />
        <Skeleton variant="rect" className="h-64" />
      </PageTransition>
    )
  }

  if (notFound || !order) {
    return (
      <PageTransition>
        <PageHeader title="Order" description="Sales" actions={<Link href="/sales" className="text-sm text-decoricks-brown hover:underline">← Back to orders</Link>} />
        <Card>
          <EmptyState
            title={notFound ? 'Order not found' : 'Could not open this order'}
            description={
              notFound
                ? 'It may have been deleted, or the link is stale.'
                : (error ?? 'Try again from the orders list.')
            }
            action={{ label: 'Back to orders', onClick: () => { window.location.href = '/sales' } }}
          />
        </Card>
      </PageTransition>
    )
  }

  const statusBadge = (
    <Badge variant={ORDER_STATUS_BADGE[order.orderStatus] ?? 'default'} size="sm">
      {ORDER_STATUS_LABELS[order.orderStatus] ?? order.orderStatus}
    </Badge>
  )

  const itemColumns = [
    { key: 'product', label: 'Product' },
    { key: 'quantity', label: 'Qty' },
    { key: 'unitPrice', label: 'Unit price' },
    { key: 'total', label: 'Line total' },
  ]

  const itemRows = order.items.map((item, index) => ({
    _id: `${item.productId}-${index}`,
    product: (
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-decoricks-dark">{item.productName}</p>
        {typeof item.unitCost === 'number' && (
          <p className="text-xs text-ink-muted">cost snapshot {formatPaisa(item.unitCost)}</p>
        )}
      </div>
    ),
    quantity: item.quantity,
    unitPrice: formatPaisa(item.unitPrice),
    total: <span className="font-medium text-decoricks-dark">{formatPaisa(item.total)}</span>,
  }))

  return (
    <PageTransition>
      <PageHeader
        title={order.orderNumber}
        description={`${order.customerName} · ${formatKarachiDate(new Date(order.createdAt), 'date')}`}
        actions={
          <>
            {statusBadge}
            <Link
              href="/sales"
              className="inline-flex h-11 min-h-[44px] items-center rounded-md px-3 text-sm font-medium text-decoricks-brown hover:underline md:h-10"
            >
              ← All orders
            </Link>
          </>
        }
      />

      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      {/* Lifecycle actions first — the reason this screen exists. */}
      {canEdit && (
        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {transitions.includes('processing') && (
              <Button variant="outline" disabled={actionBusy} onClick={() => void patchOrder('processing', { orderStatus: 'processing' })}>
                Start processing
              </Button>
            )}
            {transitions.includes('shipped') && (
              <Button
                variant="outline"
                disabled={actionBusy}
                onClick={() => {
                  setActionError(null)
                  setConfirmAction('shipped')
                }}
              >
                Dispatch
              </Button>
            )}
            {transitions.includes('delivered') && (
              <Button variant="outline" disabled={actionBusy} onClick={() => void patchOrder('delivered', { orderStatus: 'delivered' })}>
                Mark delivered
              </Button>
            )}
            {canConfirmCash(order) && (
              <Button disabled={actionBusy} onClick={() => void patchOrder('cash', { cashReceived: true })}>
                Confirm COD cash received
              </Button>
            )}
            {canRecordRefusal(order) && (
              <Button
                variant="outline"
                disabled={actionBusy}
                onClick={() => {
                  setActionError(null)
                  setConfirmAction('refused')
                }}
              >
                Record refusal
              </Button>
            )}
            {transitions.includes('cancelled') && (
              <Button
                variant="outline"
                disabled={actionBusy}
                onClick={() => {
                  setActionError(null)
                  setConfirmAction('cancelled')
                }}
              >
                Cancel order
              </Button>
            )}
            {isReturnable(order) && can({ role: user?.role ?? '', }, 'sales', 'create') && (
              <Button variant="outline" disabled={actionBusy} onClick={() => setReturnOpen(true)}>
                Record return
              </Button>
            )}
            {isEditable(order) && canFullEdit && (
              <Button variant="ghost" disabled={actionBusy} onClick={() => setEditOpen(true)}>
                Edit contents
              </Button>
            )}
            {isDeletable(order) && canDelete && (
              <Button variant="ghost" disabled={actionBusy} onClick={() => setDeleteOpen(true)}>
                Delete cancelled order
              </Button>
            )}
          </div>
          {actionError && (
            <p className="mt-2 text-sm text-status-danger" role="alert">
              {actionError}
            </p>
          )}
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Left column: customer + items */}
        <div className="space-y-4 lg:col-span-2">
          <Card className="p-4">
            <h2 className="text-md font-semibold text-decoricks-dark">Customer</h2>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-ink-muted">Name</dt>
                <dd className="text-decoricks-dark">{order.customerName}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">Phone</dt>
                <dd className="text-decoricks-dark">{order.customerPhone}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">City</dt>
                <dd className="text-decoricks-dark">{order.customerCity}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">Address</dt>
                <dd className="text-decoricks-dark">{order.customerAddress}</dd>
              </div>
            </dl>
          </Card>

          <Card className="p-4">
            <h2 className="text-md font-semibold text-decoricks-dark">Items</h2>
            <p className="mt-1 text-xs text-ink-muted">
              Prices and cost snapshots were resolved by the server when the order was created or
              edited — never typed by the browser.
            </p>
            <div className="mt-3 hidden md:block">
              <Table caption="Order items" columns={itemColumns} data={itemRows} rowKey="_id" />
            </div>
            <ul className="divide-y divide-line-subtle md:hidden">
              {order.items.map((item, index) => (
                <li key={`${item.productId}-${index}`} className="py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-decoricks-dark">{item.productName}</p>
                      <p className="text-xs text-ink-muted">
                        {item.quantity} × {formatPaisa(item.unitPrice)}
                        {typeof item.unitCost === 'number' && ` · cost ${formatPaisa(item.unitCost)}`}
                      </p>
                    </div>
                    <p className="text-sm font-semibold text-decoricks-dark">{formatPaisa(item.total)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          {returns.length > 0 && (
            <Card className="p-4">
              <h2 className="text-md font-semibold text-decoricks-dark">Returns on this order</h2>
              <ul className="mt-2 divide-y divide-line-subtle">
                {returns.map((ret) => (
                  <li key={ret._id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-decoricks-dark">{ret.returnNumber}</p>
                      <p className="text-xs text-ink-muted">
                        {ret.items.reduce((sum, i) => sum + i.quantity, 0)} unit
                        {ret.items.reduce((sum, i) => sum + i.quantity, 0) === 1 ? '' : 's'} ·{' '}
                        {formatKarachiDate(new Date(ret.createdAt), 'date')}
                      </p>
                    </div>
                    <div className="text-right text-sm">
                      <p className="font-semibold text-decoricks-dark">{formatPaisa(ret.refundAmount)} refund</p>
                      <p className="text-xs text-ink-muted">
                        outcome: {ret.items[0]?.outcome ?? ret.outcome}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        {/* Right column: money + fulfillment + ledger trail */}
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="text-md font-semibold text-decoricks-dark">Money</h2>
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-muted">Subtotal</dt>
                <dd className="text-decoricks-dark">{formatPaisa(order.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-muted">Shipping</dt>
                <dd className="text-decoricks-dark">{formatPaisa(order.shippingCost)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-muted">Courier charges</dt>
                <dd className="text-decoricks-dark">{formatPaisa(order.courierCharges ?? 0)}</dd>
              </div>
              <div className="flex justify-between border-t border-line-subtle pt-2">
                <dt className="font-medium text-decoricks-dark">Total (COD)</dt>
                <dd className="text-base font-semibold text-decoricks-dark">{formatPaisa(order.total)}</dd>
              </div>
            </dl>
          </Card>

          <Card className="p-4">
            <h2 className="text-md font-semibold text-decoricks-dark">Fulfilment</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Channel</dt>
                <dd className="text-right text-decoricks-dark">{order.salesChannel}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Ship from</dt>
                <dd className="text-right text-decoricks-dark">
                  {LOCATION_LABELS[order.shipFromLocation ?? ''] ?? order.shipFromLocation ?? '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Courier</dt>
                <dd className="text-right text-decoricks-dark">{order.courierName ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Payment</dt>
                <dd className="text-right text-decoricks-dark">
                  {PAYMENT_STATUS_LABELS[order.paymentStatus] ?? order.paymentStatus}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">COD outcome</dt>
                <dd className="text-right text-decoricks-dark">
                  {COD_OUTCOME_LABELS[order.codOutcome] ?? order.codOutcome}
                </dd>
              </div>
              {order.deliveryDate && (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-muted">Delivered</dt>
                  <dd className="text-right text-decoricks-dark">
                    {formatKarachiDate(new Date(order.deliveryDate), 'date')}
                  </dd>
                </div>
              )}
              {order.notes && (
                <div>
                  <dt className="text-xs text-ink-muted">Notes</dt>
                  <dd className="mt-1 text-decoricks-dark">{order.notes}</dd>
                </div>
              )}
            </dl>
          </Card>

          {/* Ledger trail — which linked entries already exist. */}
          <Card className="p-4">
            <h2 className="text-md font-semibold text-decoricks-dark">Ledger trail</h2>
            <ul className="mt-3 space-y-2 text-sm">
              <li className="flex items-center justify-between gap-2">
                <span className="text-ink-muted">Stock reserved</span>
                <span>
                  {order.stockMovementIds && order.stockMovementIds.length > 0 ? (
                    <Badge variant="success" size="sm">
                      {order.stockMovementIds.length} movement{order.stockMovementIds.length === 1 ? '' : 's'}
                    </Badge>
                  ) : order.orderStatus === 'cancelled' || order.orderStatus === 'returned' ? (
                    <Badge variant="default" size="sm">
                      Restored
                    </Badge>
                  ) : (
                    <Badge variant="default" size="sm">
                      None
                    </Badge>
                  )}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-ink-muted">Courier expense</span>
                <span>
                  {order.courierExpenseTransactionId ? (
                    <Badge variant="success" size="sm">
                      Posted
                    </Badge>
                  ) : (
                    <Badge variant="default" size="sm">
                      Not yet
                    </Badge>
                  )}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-ink-muted">Sales income</span>
                <span>
                  {order.incomeTransactionId ? (
                    <Badge variant="success" size="sm">
                      Posted {order.codCashReceivedAt ? formatKarachiDate(new Date(order.codCashReceivedAt), 'date') : ''}
                    </Badge>
                  ) : (
                    <Badge variant="default" size="sm">
                      Not posted
                    </Badge>
                  )}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-ink-muted">Refund</span>
                <span>
                  {order.refundTransactionId ? (
                    <Badge variant="warning" size="sm">
                      Refunded
                    </Badge>
                  ) : (
                    <Badge variant="default" size="sm">
                      None
                    </Badge>
                  )}
                </span>
              </li>
            </ul>
            <p className="mt-3 text-xs text-ink-muted">
              Income is posted exactly once, only when COD cash is confirmed. Cancelling or
              refusing after payment is blocked — money comes back through a return.
            </p>
          </Card>
        </div>
      </div>

      {/* Dispatch / cancel / refuse need a confirmation because they move money or stock. */}
      <Modal
        isOpen={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        title={
          confirmAction === 'shipped'
            ? 'Dispatch this order?'
            : confirmAction === 'cancelled'
              ? 'Cancel this order?'
              : 'Record a refusal?'
        }
        description={
          confirmAction === 'shipped'
            ? order.courierCharges
              ? `The courier charge of ${formatPaisa(order.courierCharges)} will be posted as a ledger expense.`
              : 'No courier charge is recorded on this order.'
            : confirmAction === 'cancelled'
              ? 'Reserved stock will be restored exactly once. A paid order cannot be cancelled — use a return instead.'
              : 'The customer refused the parcel. Reserved stock will be restored; no income exists to reverse.'
        }
        size="sm"
        dismissible={!actionBusy}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmAction(null)} disabled={actionBusy}>
              Keep as is
            </Button>
            <Button
              disabled={actionBusy}
              onClick={() => {
                if (!confirmAction) return
                if (confirmAction === 'shipped') void patchOrder('shipped', { orderStatus: 'shipped' })
                else if (confirmAction === 'cancelled')
                  void patchOrder('cancelled', { orderStatus: 'cancelled' })
                else if (confirmAction === 'refused') void patchOrder('refused', { codOutcome: 'refused' })
              }}
            >
              {actionBusy
                ? 'Working…'
                : confirmAction === 'shipped'
                  ? 'Dispatch'
                  : confirmAction === 'cancelled'
                    ? 'Cancel order'
                    : 'Record refusal'}
            </Button>
          </>
        }
      >
        {actionError && (
          <p className="text-sm text-status-danger" role="alert">
            {actionError}
          </p>
        )}
      </Modal>

      <Modal
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete this cancelled order?"
        description="Only cancelled orders can be removed from the list. Its movements stay in the ledger."
        size="sm"
        dismissible={!actionBusy}
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={actionBusy}>
              Keep
            </Button>
            <Button disabled={actionBusy} onClick={() => void deleteOrder()}>
              {actionBusy ? 'Working…' : 'Delete order'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-secondary">
          The order row is removed; its restored movements and audit history stay in the ledger.
        </p>
      </Modal>

      <OrderFormModal
        isOpen={editOpen}
        onClose={() => setEditOpen(false)}
        order={order}
        products={products.filter((p) => p.isActive || order.items.some((i) => i.productId === p._id))}
        pools={pools}
        canWriteLocation={canWriteLocation}
        channels={[order.salesChannel]}
        onSaved={handleOrderSaved}
      />

      <ReturnFormModal
        isOpen={returnOpen}
        onClose={() => setReturnOpen(false)}
        order={order}
        existingReturns={returns}
        accounts={accounts}
        isFounder={isFounderUser}
        onSaved={handleReturnSaved}
      />
    </PageTransition>
  )
}
