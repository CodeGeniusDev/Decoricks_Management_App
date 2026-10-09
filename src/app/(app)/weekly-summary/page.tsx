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
    lowStockItems: Array<{ name: string; quantity: number }>
    recentTransfers: number
  }
  tasksCompleted: {
    count: number
    byAssignee: Array<{ name: string; count: number }>
  }
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
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-decoricks-dark">Weekly Summary</h1>
        <div className="flex gap-2">
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
                  <span className="font-medium text-green-600">{data.salesSummary.codDelivered}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-decoricks-dark/60">COD Returned</span>
                  <span className="font-medium text-red-500">{data.salesSummary.codReturned}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-decoricks-dark/60">COD Refused</span>
                  <span className="font-medium text-yellow-600">{data.salesSummary.codRefused}</span>
                </div>
              </div>
            </Card>

            {/* Expenses Summary */}
            <Card className="p-6">
              <h3 className="text-lg font-semibold text-decoricks-dark mb-4">Expenses Summary</h3>
              {data.expensesSummary.byCategory.length === 0 ? (
                <p className="text-sm text-decoricks-dark/60">No expenses recorded in this period.</p>
              ) : (
              <Table
                columns={[
                  { key: 'category', label: 'Category' },
                  { key: 'amount', label: 'Amount' },
                ]}
                data={data.expensesSummary.byCategory.map((item) => ({
                  category: <span className="capitalize">{item.category.replace(/_/g, ' ')}</span>,
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
                <div className="flex justify-between">
                  <span className="text-sm text-decoricks-dark/60">Recent Transfers</span>
                  <span className="font-medium">{data.stockSummary.recentTransfers}</span>
                </div>
                {data.stockSummary.lowStockItems.length > 0 && (
                  <div className="mt-3">
                    <p className="text-sm font-medium text-decoricks-dark mb-2">Low Stock Items</p>
                    <div className="space-y-1">
                      {data.stockSummary.lowStockItems.map((item, i) => (
                        <div key={i} className="flex justify-between text-sm">
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
            <h3 className="text-lg font-semibold text-decoricks-dark mb-4">Tasks Completed: {data.tasksCompleted.count}</h3>
            {data.tasksCompleted.byAssignee.length === 0 ? (
              <p className="text-sm text-decoricks-dark/60">No tasks were completed in this period.</p>
            ) : (
            <Table
              columns={[
                { key: 'assignee', label: 'Assignee' },
                { key: 'count', label: 'Tasks Completed' },
              ]}
              data={data.tasksCompleted.byAssignee.map((item) => ({
                assignee: item.name,
                count: (
                  <Badge variant="success">{item.count} tasks</Badge>
                ),
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
