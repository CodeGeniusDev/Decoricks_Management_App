'use client'

import { useState, useEffect, useCallback } from 'react'
import { PageTransition } from '@/components/PageTransition'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Table } from '@/components/ui/Table'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Toast } from '@/components/ui/Toast'
import { formatPaisa } from '@/lib/money'
import { useAuth } from '@/components/auth/AuthProvider'
import { can } from '@/lib/permissions-client'

/**
 * Anchor styled to match the outline Button. A file endpoint returns a body
 * with `Content-Disposition: attachment`, so it must be a real browser
 * download (`<a>`), not a client-side `next/link` navigation.
 */
const exportAnchorClass =
  'inline-flex h-11 min-h-[44px] items-center justify-center rounded-md border border-line bg-surface-raised px-3 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown md:h-9'

/** The export aggregates every module; a download is only offered when the
 *  caller can view all of them. This is display-only — the route re-checks. */
const EXPORT_MODULES = ['finance', 'inventory', 'sales', 'tasks'] as const

interface WeeklySummaryData {
  period: 'week' | 'month'
  rangeStart: string
  rangeEnd: string
  recentOrders: Array<{
    date: string
    orderNumber: string
    customerName: string
    total: number
    totalDisplay: string
    orderStatus: string
  }>
  recentExpenses: Array<{
    date: string
    category: string
    amount: number
    amountDisplay: string
    description: string
  }>
  salesSummary: {
    orders: number
    revenue: number
    revenueDisplay: string
    codDelivered: number
    codReturned: number
    codRefused: number
    deliveryRate: number
  }
  expensesSummary: {
    total: number
    totalDisplay: string
    byCategory: Array<{ category: string; amount: number; amountDisplay: string }>
  }
  profitSummary: {
    gross: number
    grossDisplay: string
    net: number
    netDisplay: string
    cogs: number
    cogsDisplay: string
  }
  stockSummary: {
    totalValue: number
    totalValueDisplay: string
    lowStockItems: Array<{ id: string; name: string; quantity: number }>
  }
  tasksCompleted: {
    count: number
    byAssignee: Array<{ name: string; count: number }>
  }
  /** Phase 6: per-member counts of cards past their due date and not in a
   *  done column. Informational — penalties stay a manual Founder action. */
  overdueByMember: Array<{ name: string; count: number }>
}

const SALES_COLUMNS = [
  { key: 'date', label: 'Date' },
  { key: 'order', label: 'Order #' },
  { key: 'customer', label: 'Customer' },
  { key: 'total', label: 'Total' },
  { key: 'status', label: 'Status' },
]

const EXPENSE_COLUMNS = [
  { key: 'date', label: 'Date' },
  { key: 'category', label: 'Category' },
  { key: 'amount', label: 'Amount' },
  { key: 'description', label: 'Description' },
]

export default function WeeklySummaryPage() {
  const { user } = useAuth()
  const canExport = user
    ? EXPORT_MODULES.every((module) => can({ role: user.role }, module, 'view'))
    : false
  const [data, setData] = useState<WeeklySummaryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [period, setPeriod] = useState<'week' | 'month'>('week')
  const [toastMessage, setToastMessage] = useState<{
    type: 'success' | 'error' | 'info' | 'warning'
    message: string
  } | null>(null)

  const fetchSummary = useCallback(async () => {
    try {
      setLoading(true)
      setLoadError(null)

      const res = await fetch(`/api/reports/period?period=${period}`)
      const body = await res.json()
      if (!res.ok || !body.success) {
        throw new Error(body?.error?.message || 'Failed to load summary')
      }
      setData(body.data)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load summary')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => {
    fetchSummary()
  }, [fetchSummary, period])

  const periodLabel = period === 'week' ? 'This Week' : 'This Month'
  const dateRange = data
    ? `${new Date(data.rangeStart).toLocaleDateString('en-PK')} - ${new Date(data.rangeEnd).toLocaleDateString('en-PK')}`
    : ''

  if (loading) {
    return (
      <PageTransition>
        <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Weekly Summary</h1>
        <div className="space-y-6">
          <div className="flex gap-4 mb-4">
            <Skeleton variant="rect" className="h-10 w-20" />
            <Skeleton variant="rect" className="h-10 w-24" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} variant="rect" className="h-32" />
            ))}
          </div>
        </div>
      </PageTransition>
    )
  }

  return (
    <PageTransition>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-decoricks-dark">Weekly Summary</h1>
        <div className="flex gap-2 flex-wrap items-center">
          <Button
            variant={period === 'week' ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setPeriod('week')}
          >
            This Week
          </Button>
          <Button
            variant={period === 'month' ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setPeriod('month')}
          >
            This Month
          </Button>
          {canExport && (
            <>
              <a
                href={`/api/reports/export?period=${period}&format=csv`}
                className={exportAnchorClass}
                data-testid="export-csv"
              >
                Export CSV
              </a>
              <a
                href={`/api/reports/export?period=${period}&format=pdf`}
                className={exportAnchorClass}
                data-testid="export-pdf"
              >
                Export PDF
              </a>
            </>
          )}
        </div>
      </div>

      {/* Toast */}
      {toastMessage && (
        <div className="fixed top-20 right-4 z-50">
          <Toast
            message={toastMessage.message}
            type={toastMessage.type}
            onClose={() => setToastMessage(null)}
          />
        </div>
      )}

      {data && (
        <>
          {/* Header */}
          <Card className="mb-6">
            <div className="p-6">
              <h2 className="text-lg font-semibold text-decoricks-dark">{periodLabel}</h2>
              <p className="text-sm text-decoricks-dark/60 mb-4">{dateRange}</p>
            </div>
          </Card>

          {/* Summary Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
            <Card className="p-6 text-center">
              <p className="text-sm text-decoricks-dark/60 mb-2">Orders</p>
              <p className="text-2xl font-bold text-decoricks-brown">{data.salesSummary.orders}</p>
            </Card>
            <Card className="p-6 text-center">
              <p className="text-sm text-decoricks-dark/60 mb-2">COD Delivery Rate</p>
              <p className="text-2xl font-bold text-green-600">{data.salesSummary.deliveryRate}%</p>
            </Card>
            <Card className="p-6 text-center">
              <p className="text-sm text-decoricks-dark/60 mb-2">Expenses</p>
              <p className="text-2xl font-bold text-red-500">{data.expensesSummary.totalDisplay}</p>
            </Card>
            <Card className="p-6 text-center">
              <p className="text-sm text-decoricks-dark/60 mb-2">Net Profit</p>
              <p className="text-2xl font-bold text-green-600">{data.profitSummary.netDisplay}</p>
            </Card>
          </div>

          {/* Detailed Sections */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* Sales Summary */}
            <Card className="p-6">
              <h3 className="text-lg font-semibold text-decoricks-dark mb-4">Sales Summary</h3>
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-sm text-decoricks-dark/60">Revenue</span>
                  <span className="font-medium">{data.salesSummary.revenueDisplay}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-decoricks-dark/60">COD Delivered</span>
                  <span className="font-medium text-green-600">
                    {data.salesSummary.codDelivered}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-decoricks-dark/60">COD Returned</span>
                  <span className="font-medium text-red-500">{data.salesSummary.codReturned}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-decoricks-dark/60">COD Refused</span>
                  <span className="font-medium text-yellow-600">
                    {data.salesSummary.codRefused}
                  </span>
                </div>
              </div>
            </Card>

            {/* Expenses Summary */}
            <Card className="p-6">
              <h3 className="text-lg font-semibold text-decoricks-dark mb-4">Expenses Summary</h3>
              {data.expensesSummary.byCategory.length === 0 ? (
                <p className="text-sm text-decoricks-dark/60">
                  No expenses recorded in this period.
                </p>
              ) : (
                <Table
                  columns={[
                    { key: 'category', label: 'Category' },
                    { key: 'amount', label: 'Amount' },
                  ]}
                  data={data.expensesSummary.byCategory.map((item) => ({
                    category: (
                      <span className="capitalize">{item.category.replace(/_/g, ' ')}</span>
                    ),
                    amount: <span className="font-medium">{item.amountDisplay}</span>,
                  }))}
                />
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* Profit Summary */}
            <Card className="p-6">
              <h3 className="text-lg font-semibold text-decoricks-dark mb-4">Profit Summary</h3>
              <Table
                columns={[
                  { key: 'label', label: 'Metric' },
                  { key: 'amount', label: 'Amount' },
                ]}
                data={[
                  {
                    label: 'Gross Profit',
                    amount: (
                      <span className="font-medium text-green-600">
                        {data.profitSummary.grossDisplay}
                      </span>
                    ),
                  },
                  {
                    label: 'COGS',
                    amount: (
                      <span className="font-medium text-decoricks-dark/70">
                        {data.profitSummary.cogsDisplay}
                      </span>
                    ),
                  },
                  {
                    label: 'Net Profit',
                    amount: (
                      <span className="font-bold text-green-600">
                        {data.profitSummary.netDisplay}
                      </span>
                    ),
                  },
                ]}
              />
            </Card>

            {/* Stock Summary */}
            <Card className="p-6">
              <h3 className="text-lg font-semibold text-decoricks-dark mb-4">Stock Summary</h3>
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-sm text-decoricks-dark/60">Total Inventory Value</span>
                  <span className="font-medium">{data.stockSummary.totalValueDisplay}</span>
                </div>
                {data.stockSummary.lowStockItems.length > 0 && (
                  <div className="mt-3">
                    <p className="text-sm font-medium text-decoricks-dark mb-2">Low Stock Items</p>
                    <div className="space-y-1">
                      {data.stockSummary.lowStockItems.map((item) => (
                        <div key={item.id} className="flex justify-between text-sm">
                          <span>{item.name}</span>
                          <Badge variant="error">{item.quantity} left</Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </div>

          {/* Tasks Completed */}
          <Card className="p-6 mb-6">
            <h3 className="text-lg font-semibold text-decoricks-dark mb-4">
              Tasks Completed: {data.tasksCompleted.count}
            </h3>
            {data.tasksCompleted.byAssignee.length === 0 ? (
              <p className="text-sm text-decoricks-dark/60">
                No tasks were completed in this period.
              </p>
            ) : (
              <Table
                columns={[
                  { key: 'assignee', label: 'Assignee' },
                  { key: 'count', label: 'Tasks Completed' },
                ]}
                data={data.tasksCompleted.byAssignee.map((item) => ({
                  assignee: item.name,
                  count: <Badge variant="success">{item.count} tasks</Badge>,
                }))}
              />
            )}

            <h4 className="mt-6 mb-2 text-base font-semibold text-decoricks-dark">Overdue now</h4>
            <p className="mb-2 text-xs text-decoricks-dark/60">
              Cards past their due date that are not in a done column. Informational; penalties
              remain a manual Founder action.
            </p>
            {(data.overdueByMember ?? []).length === 0 ? (
              <p className="text-sm text-decoricks-dark/60">Nothing is overdue right now.</p>
            ) : (
              <Table
                columns={[
                  { key: 'member', label: 'Member' },
                  { key: 'overdue', label: 'Overdue tasks' },
                ]}
                data={(data.overdueByMember ?? []).map((item) => ({
                  member: item.name,
                  overdue: <Badge variant="error">{item.count} overdue</Badge>,
                }))}
              />
            )}
          </Card>
        </>
      )}

      {loadError && (
        <Card variant="default" className="p-6 mb-6 border-red-200">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-decoricks-dark">Could not load the summary</h2>
              <p className="text-sm text-decoricks-dark/60">{loadError}</p>
            </div>
            <Button variant="outline" onClick={fetchSummary} type="button">
              Try again
            </Button>
          </div>
        </Card>
      )}

      {!data && !loading && !loadError && (
        <EmptyState
          title="No summary data"
          description="Nothing was recorded in this period. Orders, expenses and completed tasks will show up here."
        />
      )}

      {data && data.salesSummary.orders === 0 && data.expensesSummary.total === 0 && (
        <Card variant="default" className="p-6 mb-6">
          <p className="text-sm text-decoricks-dark/70">
            No orders or expenses were recorded between{' '}
            {new Date(data.rangeStart).toLocaleDateString('en-PK')} and{' '}
            {new Date(data.rangeEnd).toLocaleDateString('en-PK')}. The figures below are real zeros
            for that period, not sample data.
          </p>
        </Card>
      )}
    </PageTransition>
  )
}
