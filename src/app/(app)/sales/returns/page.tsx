'use client'

/**
 * Returns screen (SPEC §5.5, §5.6).
 *
 * A return is three things at once on the server: stock movements into the
 * pool the outcome chooses (restock → available, damaged → damaged pool,
 * write-off → gone), a `refunds_return_costs` ledger expense for the refund,
 * and the same category for return courier costs. This screen reads that
 * record; returns are created from the order detail screen, because a return
 * without its order would not know what can still come back.
 *
 * Damaging or writing off returned goods is a Founder decision — the API
 * refuses it for Partners, and the outcome badges here show what actually
 * happened to each unit.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { PageTransition } from '@/components/PageTransition'
import { PageHeader } from '@/components/layout/Page'
import { SubNav } from '@/components/layout/SubNav'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Table } from '@/components/ui/Table'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { apiJson } from '@/lib/api-client'
import { formatPaisa } from '@/lib/money'
import { formatKarachiDate } from '@/lib/date'
import {
  RETURN_OUTCOME_BADGE,
  RETURN_OUTCOME_LABELS,
  SALES_SUBNAV,
  type ReturnView,
  type ReturnsView,
} from '@/modules/sales/sales-ui'
import { appendRangeParams } from '@/modules/inventory/inventory-ui'

const LIMIT = 25

const returnUnits = (ret: ReturnView): number =>
  ret.items.reduce((sum, item) => sum + item.quantity, 0)

export default function SalesReturnsPage() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)

  const [data, setData] = useState<ReturnsView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const requestSeq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (currentFrom: string, currentTo: string, currentPage: number) => {
    const seq = ++requestSeq.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const params = new URLSearchParams()
    appendRangeParams(params, { from: currentFrom, to: currentTo })
    params.set('page', String(currentPage))
    params.set('limit', String(LIMIT))

    try {
      const result = await apiJson<ReturnsView>(`/api/returns?${params.toString()}`, {
        signal: controller.signal,
      })
      if (seq === requestSeq.current) {
        setData(result)
        setError(null)
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : 'Failed to load returns')
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    const timer = setTimeout(() => void load(from, to, page), 0)
    return () => clearTimeout(timer)
  }, [from, to, page, load])

  const columns = [
    { key: 'number', label: 'Return #' },
    { key: 'date', label: 'Date' },
    { key: 'order', label: 'Order' },
    { key: 'items', label: 'Items' },
    { key: 'outcome', label: 'Outcome' },
    { key: 'refund', label: 'Refund' },
    { key: 'courier', label: 'Return courier' },
    { key: 'entries', label: 'Ledger' },
  ]

  const rows = (data?.items ?? []).map((ret) => ({
    _id: ret._id,
    number: <span className="font-mono text-xs text-ink-secondary">{ret.returnNumber}</span>,
    date: formatKarachiDate(new Date(ret.createdAt), 'date'),
    order: (
      <Link href={`/sales/${ret.orderId}`} className="text-sm text-decoricks-brown hover:underline">
        {ret.orderNumber ?? 'Open order'}
      </Link>
    ),
    items: (
      <span>
        {returnUnits(ret)} unit{returnUnits(ret) === 1 ? '' : 's'}
        <span className="block text-xs text-ink-muted">
          {ret.items.map((item) => item.reason).filter(Boolean)[0] ?? ''}
        </span>
      </span>
    ),
    outcome: (
      <Badge variant={RETURN_OUTCOME_BADGE[ret.outcome] ?? 'default'} size="sm">
        {RETURN_OUTCOME_LABELS[ret.outcome] ?? ret.outcome}
      </Badge>
    ),
    refund: <span className="font-medium text-decoricks-dark">{formatPaisa(ret.refundAmount)}</span>,
    courier: ret.courierCost ? formatPaisa(ret.courierCost) : <span className="text-ink-muted">—</span>,
    entries: (
      <span className="text-xs text-ink-muted">
        {ret.refundTransactionId ? 'Refund posted' : 'No refund entry'}
        {ret.movementIds && ret.movementIds.length > 0 && ` · ${ret.movementIds.length} movement${ret.movementIds.length === 1 ? '' : 's'}`}
      </span>
    ),
  }))

  return (
    <PageTransition>
      <PageHeader
        title="Returns"
        description="Returned parcels: stock back through the movement ledger, refunds through the ledger — never edited away."
      />

      <SubNav items={SALES_SUBNAV} />

      {/* Filters */}
      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input label="From (Karachi date)" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} />
          <Input label="To (Karachi date)" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} />
          <div className="flex items-end">
            <Button
              variant="outline"
              onClick={() => {
                setFrom('')
                setTo('')
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
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} variant="rect" className="mb-2 h-12" />
            ))}
          </div>
        ) : error ? (
          <ErrorState
            title="Could not load returns"
            description={error}
            action={{ label: 'Retry', onClick: () => void load(from, to, page) }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={from || to ? 'No returns in this range' : 'No returns yet'}
            description={
              from || to
                ? 'Widen the date range to see earlier returns.'
                : 'Returns are recorded from an order that was delivered — open the order and choose "Record return".'
            }
            action={{
              label: 'Go to orders',
              onClick: () => {
                window.location.href = '/sales'
              },
            }}
          />
        ) : (
          <>
            <div className="hidden md:block">
              <Table
                caption="Returns"
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
              {(data?.items ?? []).map((ret) => (
                <li key={ret._id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-decoricks-dark">
                        {ret.orderNumber ?? ret.returnNumber}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {ret.returnNumber} · {formatKarachiDate(new Date(ret.createdAt), 'date')}
                      </p>
                    </div>
                    <Badge variant={RETURN_OUTCOME_BADGE[ret.outcome] ?? 'default'} size="sm">
                      {RETURN_OUTCOME_LABELS[ret.outcome] ?? ret.outcome}
                    </Badge>
                  </div>
                  <div className="mt-2 flex items-end justify-between gap-2">
                    <p className="text-xs text-ink-secondary">{returnUnits(ret)} unit{returnUnits(ret) === 1 ? '' : 's'} returned</p>
                    <p className="text-sm font-semibold text-decoricks-dark">
                      {formatPaisa(ret.refundAmount)} refund
                    </p>
                  </div>
                  <div className="mt-2">
                    <Link
                      href={`/sales/${ret.orderId}`}
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
                {data?.pagination.total ?? 0} returns
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
              {data?.pagination.total ?? 0} returns recorded
            </p>
          </>
        )}
      </Card>
    </PageTransition>
  )
}
