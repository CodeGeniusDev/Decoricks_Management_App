'use client'

import React from 'react'
import dynamic from 'next/dynamic'

import { PageTransition } from '@/components/PageTransition'
import { HeaderActions, PageHeader } from '@/components/layout/Page'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { useConnectionView } from '@/lib/sync/useRealtime'
import { formatKarachiDate } from '@/lib/date'
import { updatedLine } from '@/lib/dashboard/updated-line'

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

/*
 * Rendered twice, once per place it belongs at each width — see `PageHeader`'s
 * `eyebrow`. `useConnectionView` is a read-only subscription to the sync
 * coordinator plus one `navigator.onLine` listener (no connection is opened by
 * it, `useDashboard` already owns that), so a second instance costs one listener
 * and nothing else.
 *
 * The words come from `lib/sync/connection-view`, which is the only place in the
 * app allowed to turn health into a label. That is deliberate: this component
 * used to hold its own four-way ternary over the store, the header held its own
 * reading of `navigator.onLine`, and the two disagreed in production — green
 * "Online" in the bar, red "Offline" here, same phone, same second. The
 * transport was writing `offline` on teardown, which an ordinary navigation does
 * on a connected device. Now the store cannot make that claim and this label
 * function cannot repeat it: "Offline" here means the browser says so, and
 * nothing else. Polling is named as polling ("Updating every few seconds")
 * rather than dressed up as a stream, because a fallback that works is not a
 * failure.
 */
const TONE_DOT = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  danger: 'bg-status-danger',
} as const

const ConnectionChip = ({
  className = '',
  waking = false,
}: {
  className?: string
  waking?: boolean
}) => {
  const { label, tone } = useConnectionView(waking)
  return (
    <span
      title={`Realtime sync: ${label}`}
      className={`inline-flex items-center gap-1.5 rounded-full border border-line-subtle px-2.5 py-1 text-2xs font-medium text-ink-muted ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]}`} aria-hidden />
      {label}
    </span>
  )
}

export default function DashboardView() {
  const dash = useDashboard()
  const { data, loading, error, refresh, waking } = dash

  // Whole-board first-load / error states. A background refresh never lands here
  // (the hook keeps the last good snapshot), so the page can never blank itself
  // mid-session — only the very first paint shows a skeleton.
  const firstPaint = loading && !data

  return (
    <PageTransition>
      <PageHeader
        title="Dashboard"
        eyebrow={
          /*
           * On a phone the actions cluster becomes a full-width block of its own,
           * so the Live chip would share that row with the period control and the
           * date inputs — it landed at the far end of a wrapped cluster, which is
           * the "awkwardly positioned" report. Above the title is where a status
           * belongs when there is no room beside it. From `sm` the chip returns to
           * the actions row and the eyebrow disappears: desktop is unchanged.
           */
          <ConnectionChip waking={!!waking} className="mb-2 sm:hidden" />
        }
        description={
          data
            ? `Period ${formatKarachiDate(new Date(data.range.start), 'date')} – ${formatKarachiDate(
                new Date(data.range.end),
                'date'
              )} · ${updatedLine(dash.lastUpdated, dash.stale)}`
            : 'Sales, cash, inventory, orders, budget and team activity at a glance.'
        }
        actions={
          /*
           * One column of full-width controls below `sm`, the original row from `sm`
           * up. The rules and the reason are `HeaderActions`' own doc comment — this
           * row used to be inlined here, which is how Reconciliation ended up without
           * it while rendering the same `PeriodSelector`.
           */
          <HeaderActions>
            <ConnectionChip waking={!!waking} className="hidden sm:inline-flex" />
            <PeriodSelector
              period={dash.period}
              customFrom={dash.customFrom}
              customTo={dash.customTo}
              onPeriod={dash.setPeriod}
              onCustomRange={dash.setCustomRange}
              onRefresh={refresh}
              refreshing={loading && !!data}
              refreshLabel="Refresh dashboard"
            />
          </HeaderActions>
        }
      />

      {/*
       * The cold-start notice. It replaces nothing — the skeleton underneath it
       * keeps painting, because the numbers may still arrive — but it is what the
       * user reads instead of a silent spinner.
       *
       * The free Render instance sleeps after ~15 min idle, and the reported
       * symptom was this screen saying "Couldn't load the dashboard / Failed to
       * fetch" plus the header saying Offline, on a phone with full signal, for a
       * server that was simply booting. Both words were wrong: nothing had failed
       * and nothing was offline. `useDashboard` retries on a schedule that has a
       * ceiling on the DELAY (30s) and none on the number of attempts, so this
       * line is the difference between "waiting" and "broken" being visible — and
       * when it does finally admit an error, the retrying behind it has not
       * stopped.
       *
       * `role="status"` + `aria-live="polite"` because it appears without the user
       * doing anything, and a screen reader must hear the reason the board is still
       * empty rather than just silence. No count-down is promised: `retryInMs` is
       * how long until the NEXT attempt, which is honest, whereas "90 seconds"
       * would be a promise the schedule cannot always keep.
       */}
      {waking && (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 flex items-start gap-2.5 rounded-lg border border-line bg-surface-raised px-3 py-2.5 text-sm text-ink-secondary"
        >
          <span
            className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-status-warning"
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block font-medium text-decoricks-dark">
              Server is waking up, retrying…
            </span>
            <span className="mt-0.5 block text-xs text-ink-muted">
              Attempt {waking.attempt + 1}, next try in {Math.round(waking.retryInMs / 1000)}s. The
              app is online; the server is still starting.
            </span>
          </span>
        </div>
      )}

      {firstPaint && <DashboardSkeleton />}

      {/*
       * `!waking` is not redundant with `error`. They are set from different
       * places — `error` only ever by the hook after the wake window has closed —
       * so no overlap is possible today, but the two conditions are independent
       * state and a future change could make them concurrent. Saying "Couldn't
       * load" while the retry loop is still running is the exact bug being fixed,
       * so it is guarded at the render too.
       */}
      {!firstPaint && error && !data && !waking && (
        <ErrorState
          title="Couldn’t load the dashboard"
          description={`${error} Retrying automatically.`}
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
