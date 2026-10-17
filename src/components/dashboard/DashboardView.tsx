'use client'

import React from 'react'
import dynamic from 'next/dynamic'

import { PageTransition } from '@/components/PageTransition'
import { PageHeader } from '@/components/layout/Page'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { useConnectionState } from '@/lib/sync/useRealtime'
import { formatKarachiDate } from '@/lib/date'

import { useDashboard } from '@/lib/dashboard/useDashboard'
import { PeriodSelector } from './PeriodSelector'
import {
  ProfitWidget,
  ExpensesWidget,
  CashWidget,
  InventoryWidget,
  OrdersWidget,
  BudgetWidget,
  TasksWidget,
  AveragesWidget,
  DashboardSkeleton,
} from './widgets'

/**
 * The central dashboard (Phase 8, METRICS.md §I). It replaces the legacy
 * `/api/dashboard/summary` + `/api/finance/summary` composition with ONE
 * reconciled `/api/dashboard` snapshot, so every widget and chart reads the same
 * numbers and nothing double-fetches or races.
 *
 * Charts are split into a separate module loaded with `ssr: false` because
 * Recharts measures its container in the DOM; SSR would both mismatch on
 * hydrate and render at zero width.
 */
const DashboardCharts = dynamic(() => import('./charts'), {
  ssr: false,
  loading: () => (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} variant="rect" className="h-[300px]" />
      ))}
    </div>
  ),
})

const ConnectionChip = () => {
  const { state } = useConnectionState()
  const label = state === 'live' ? 'Live' : state === 'offline' ? 'Offline' : 'Reconnecting'
  const dot =
    state === 'live'
      ? 'bg-status-success'
      : state === 'offline'
        ? 'bg-status-danger'
        : 'bg-status-warning'
  return (
    <span
      title={`Realtime sync ${state}`}
      className="inline-flex items-center gap-1.5 rounded-full border border-line-subtle px-2.5 py-1 text-2xs font-medium text-ink-muted"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  )
}

export default function DashboardView() {
  const dash = useDashboard()
  const { data, loading, error, refresh } = dash

  // Whole-board first-load / error states. A background refresh never lands here
  // (the hook keeps the last good snapshot), so the page can never blank itself
  // mid-session — only the very first paint shows a skeleton.
  const firstPaint = loading && !data

  return (
    <PageTransition>
      <PageHeader
        title="Dashboard"
        description={
          data
            ? `Period ${formatKarachiDate(new Date(data.range.start), 'date')} – ${formatKarachiDate(new Date(data.range.end), 'date')} · updated ${formatKarachiDate(new Date(data.generatedAt), 'time')}`
            : 'Sales, cash, inventory, orders, budget and team activity at a glance.'
        }
        actions={
          <div className="flex items-center gap-2">
            <ConnectionChip />
            <PeriodSelector
              period={dash.period}
              customFrom={dash.customFrom}
              customTo={dash.customTo}
              onPeriod={dash.setPeriod}
              onCustomRange={dash.setCustomRange}
              onRefresh={refresh}
              refreshing={loading && !!data}
            />
          </div>
        }
      />

      {firstPaint && <DashboardSkeleton />}

      {!firstPaint && error && !data && (
        <ErrorState
          title="Couldn’t load the dashboard"
          description={error}
          action={{ label: 'Try again', onClick: refresh }}
        />
      )}

      {data && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {data.blocks.profit && <ProfitWidget block={data.blocks.profit} range={data.range} />}
            {data.blocks.expenses && (
              <ExpensesWidget block={data.blocks.expenses} range={data.range} />
            )}
            {data.blocks.cash && (
              <CashWidget
                block={data.blocks.cash}
                range={data.range}
                generatedAt={data.generatedAt}
              />
            )}
            {data.blocks.inventory && <InventoryWidget block={data.blocks.inventory} />}
            {data.blocks.orders && <OrdersWidget block={data.blocks.orders} range={data.range} />}
            {data.blocks.averages && <AveragesWidget block={data.blocks.averages} />}
            {data.blocks.budget && data.blocks.budget.length > 0 && (
              <BudgetWidget blocks={data.blocks.budget} />
            )}
            {data.blocks.tasks && <TasksWidget block={data.blocks.tasks} />}
          </div>

          <DashboardCharts blocks={data.blocks} />
        </div>
      )}
    </PageTransition>
  )
}
