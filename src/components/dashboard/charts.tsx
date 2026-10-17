'use client'

import React from 'react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LabelList,
} from 'recharts'

import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatPaisa } from '@/lib/money'
import type { DashboardMetrics } from '@/lib/metrics/dashboard-metrics'

import { MetricHelp } from './parts'

/**
 * Dashboard charts (METRICS.md §K). Client-only, imported via
 * `dynamic(..., { ssr: false })` so Recharts never runs during SSR (no hydration
 * mismatch). Every series is the server's `trend`/block data — already bucketed
 * from the same ledger slice the headline figures use — so a bar always sums
 * back to the number above it. There is no second money formula here.
 *
 * Design constraints honoured: brand colours only, no gradients, no 3D, labelled
 * axes, value labels + legends (never colour alone), a fixed pixel height so the
 * container never causes layout shift, and `isAnimationActive={false}` so charts
 * neither flicker on mount nor animate under a background refresh.
 */

// Brand palette (globals.css custom properties resolved to hex — the only colours
// in the system). Revenue/sales = brand brown, expense/out = the danger status,
// profit = the success status, informational series = the info status.
const C = {
  brown: '#806351',
  brownDark: '#634d3d',
  success: '#3f6b4f',
  danger: '#9b3b32',
  info: '#4a5f7a',
  grid: '#e2e5e3',
  ink: '#6b7370',
  dark: '#2b2b2b',
}

/** Compact money tick for an axis (values are integer paisa). */
const axisMoney = (paisa: number): string => {
  const pkr = paisa / 100
  const abs = Math.abs(pkr)
  if (abs >= 1_000_000) return `${(pkr / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(pkr / 1_000).toFixed(1)}k`
  return `${Math.round(pkr)}`
}

const AXIS = {
  stroke: C.ink,
  fontSize: 11,
  tickLine: false,
  axisLine: { stroke: C.grid },
} as const

interface FrameProps {
  title: string
  help: { definition: string; engine: string }
  summary: React.ReactNode
  children: React.ReactNode
  empty?: boolean
}

const ChartFrame = ({ title, help, summary, children, empty }: FrameProps) => (
  <Card className="flex flex-col p-4 md:p-5">
    <div className="mb-1 flex items-center gap-1.5">
      <h3 className="text-sm font-semibold text-decoricks-dark">{title}</h3>
      <MetricHelp definition={help.definition} engine={help.engine} />
    </div>
    {empty ? (
      <div className="flex h-[240px] items-center justify-center">
        <EmptyState
          title="No data in this period"
          description="Activity will chart here once recorded."
        />
      </div>
    ) : (
      // Fixed height → the container measures once and never reflows the page.
      <div className="h-[240px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
    )}
    <p className="mt-2 text-2xs leading-relaxed text-ink-muted">{summary}</p>
  </Card>
)

type Blocks = DashboardMetrics['blocks']

/* ---------------------------------- 1. Sales vs Expenses --------------------------------- */

const SalesExpensesChart = ({ blocks }: { blocks: Blocks }) => {
  const data = (blocks.trend?.salesVsExpenses ?? []).map((p) => ({
    label: p.label,
    revenue: p.revenue,
    expenses: p.operatingExpenses,
  }))
  const totalRev = data.reduce((s, d) => s + d.revenue, 0)
  const totalExp = data.reduce((s, d) => s + d.expenses, 0)
  const empty = data.length === 0 || (totalRev === 0 && totalExp === 0)
  return (
    <ChartFrame
      title="Sales vs Expenses"
      help={{
        definition:
          'Revenue and operating expenses bucketed by day/week/month to fit the window; each bar sums back to the period totals above.',
        engine: 'trend block · buildSalesExpenseSeries (§K, §A.1/§A.6)',
      }}
      summary={`Across ${data.length} ${blocks.trend?.granularity ?? 'day'} buckets: ${formatPaisa(totalRev)} revenue against ${formatPaisa(totalExp)} operating expenses.`}
      empty={empty}
    >
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" />
        <YAxis {...AXIS} width={48} tickFormatter={axisMoney} />
        <Tooltip
          formatter={(v: number) => formatPaisa(v)}
          contentStyle={{ fontSize: 12, borderRadius: 6, border: `1px solid ${C.grid}` }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar
          name="Revenue"
          dataKey="revenue"
          fill={C.brown}
          isAnimationActive={false}
          radius={[2, 2, 0, 0]}
        />
        <Bar
          name="Expenses"
          dataKey="expenses"
          fill={C.danger}
          isAnimationActive={false}
          radius={[2, 2, 0, 0]}
        />
      </BarChart>
    </ChartFrame>
  )
}

/* ---------------------------------- 2. Profit Trend ------------------------------------ */

const ProfitTrendChart = ({ blocks }: { blocks: Blocks }) => {
  const data = (blocks.trend?.profitTrend ?? []).map((p) => ({
    label: p.label,
    gross: p.grossProfit,
    net: p.netProfit,
  }))
  const last = data[data.length - 1]
  const empty = data.length === 0 || data.every((d) => d.gross === 0 && d.net === 0)
  return (
    <ChartFrame
      title="Profit Trend"
      help={{
        definition:
          'Monthly gross and net profit — the same computeProfitLoss engine that produces the headline profit figure.',
        engine: 'monthlyProfitSeries (§K, §A.5/§A.8)',
      }}
      summary={
        last
          ? `Latest month ${last.label}: ${formatPaisa(last.gross)} gross, ${formatPaisa(last.net)} net profit.`
          : 'No monthly profit data in the selection.'
      }
      empty={empty}
    >
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="label" {...AXIS} />
        <YAxis {...AXIS} width={48} tickFormatter={axisMoney} />
        <Tooltip
          formatter={(v: number) => formatPaisa(v)}
          contentStyle={{ fontSize: 12, borderRadius: 6, border: `1px solid ${C.grid}` }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line
          type="monotone"
          name="Gross profit"
          dataKey="gross"
          stroke={C.info}
          strokeWidth={2}
          dot={{ r: 2 }}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          name="Net profit"
          dataKey="net"
          stroke={C.success}
          strokeWidth={2}
          dot={{ r: 2 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartFrame>
  )
}

/* ---------------------------------- 3. Budget vs Actual ---------------------------------- */

const BudgetActualChart = ({ blocks }: { blocks: Blocks }) => {
  const budget = blocks.budget?.[0]
  const data =
    budget?.actuals.categories.map((c) => ({
      label: c.category,
      budgeted: c.budgeted,
      actual: c.actual,
    })) ?? []
  const empty = data.length === 0
  const over = data.filter((d) => d.actual > d.budgeted)
  return (
    <ChartFrame
      title="Budget vs Actual"
      help={{
        definition: `Active budget “${budget?.name ?? '—'}”: amount allocated against what was actually spent, per category.`,
        engine: 'computeBudgetActuals (§E)',
      }}
      summary={
        budget
          ? `${formatPaisa(budget.actuals.totalActual)} spent of ${formatPaisa(budget.actuals.totalBudgeted)} budgeted (${Math.round(budget.actuals.percentUsed)}%). ${over.length} ${over.length === 1 ? 'category is' : 'categories are'} over budget.`
          : 'No active budget overlaps this period.'
      }
      empty={empty}
    >
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={C.grid} horizontal={false} />
        <XAxis type="number" {...AXIS} tickFormatter={axisMoney} />
        <YAxis type="category" dataKey="label" {...AXIS} width={90} />
        <Tooltip
          formatter={(v: number) => formatPaisa(v)}
          contentStyle={{ fontSize: 12, borderRadius: 6, border: `1px solid ${C.grid}` }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar
          name="Budgeted"
          dataKey="budgeted"
          fill={C.info}
          isAnimationActive={false}
          radius={[0, 2, 2, 0]}
        />
        <Bar
          name="Actual"
          dataKey="actual"
          fill={C.brown}
          isAnimationActive={false}
          radius={[0, 2, 2, 0]}
        />
      </BarChart>
    </ChartFrame>
  )
}

/* ---------------------------------- 4. Expense Breakdown --------------------------------- */

const ExpenseBreakdownChart = ({ blocks }: { blocks: Blocks }) => {
  const data =
    blocks.expenses?.byCategory.slice(0, 8).map((c) => ({
      label: c.category,
      amount: c.amount.paisa,
    })) ?? []
  const empty = data.length === 0
  const top = data[0]
  return (
    <ChartFrame
      title="Expense Breakdown"
      help={{
        definition:
          'Operating expenses split by category, largest first (top 8 shown). Purchasing and refunds are excluded — this matches the expense total.',
        engine: 'expenseByCategory (§A.6)',
      }}
      summary={
        top
          ? `Largest category: ${top.label} at ${formatPaisa(top.amount)}.`
          : 'No expenses to break down in this period.'
      }
      empty={empty}
    >
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={C.grid} horizontal={false} />
        <XAxis type="number" {...AXIS} tickFormatter={axisMoney} />
        <YAxis type="category" dataKey="label" {...AXIS} width={110} />
        <Tooltip
          formatter={(v: number) => formatPaisa(v)}
          contentStyle={{ fontSize: 12, borderRadius: 6, border: `1px solid ${C.grid}` }}
        />
        <Bar
          name="Expenses"
          dataKey="amount"
          fill={C.danger}
          isAnimationActive={false}
          radius={[0, 2, 2, 0]}
        >
          <LabelList
            dataKey="amount"
            position="right"
            formatter={(v: number) => axisMoney(v)}
            fill={C.ink}
            fontSize={10}
          />
        </Bar>
      </BarChart>
    </ChartFrame>
  )
}

/* ---------------------------------- 5. Stock by Location --------------------------------- */

const StockByLocationChart = ({ blocks }: { blocks: Blocks }) => {
  const data =
    blocks.inventory?.byLocation.map((l) => ({ label: l.label, value: l.value.paisa })) ?? []
  const empty = data.length === 0 || data.every((d) => d.value === 0)
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <ChartFrame
      title="Stock Value by Location"
      help={{
        definition:
          'Current weighted-average valuation of sellable stock, split by warehouse. Point-in-time, not period-filtered.',
        engine: 'buildStockSummary (§C.1)',
      }}
      summary={`Total inventory value ${formatPaisa(total)} across ${data.length} ${data.length === 1 ? 'location' : 'locations'}.`}
      empty={empty}
    >
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="label" {...AXIS} />
        <YAxis {...AXIS} width={48} tickFormatter={axisMoney} />
        <Tooltip
          formatter={(v: number) => formatPaisa(v)}
          contentStyle={{ fontSize: 12, borderRadius: 6, border: `1px solid ${C.grid}` }}
        />
        <Bar
          name="Stock value"
          dataKey="value"
          fill={C.brownDark}
          isAnimationActive={false}
          radius={[2, 2, 0, 0]}
        >
          <LabelList
            dataKey="value"
            position="top"
            formatter={(v: number) => axisMoney(v)}
            fill={C.ink}
            fontSize={10}
          />
        </Bar>
      </BarChart>
    </ChartFrame>
  )
}

/* ------------------------------------ Assembly ------------------------------------------- */

/**
 * The chart grid. Each chart renders only when its underlying block exists, so
 * the per-widget authorization enforced server-side carries straight through to
 * the visuals — an unauthorised module never even has a chart frame.
 */
export default function DashboardCharts({ blocks }: { blocks: Blocks }) {
  const showTrend = !!blocks.trend
  const showBudget = !!blocks.budget && blocks.budget.length > 0
  const showExpenses = !!blocks.expenses
  const showInventory = !!blocks.inventory
  if (!showTrend && !showBudget && !showExpenses && !showInventory) return null

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {showTrend && <SalesExpensesChart blocks={blocks} />}
      {showTrend && <ProfitTrendChart blocks={blocks} />}
      {showExpenses && <ExpenseBreakdownChart blocks={blocks} />}
      {showBudget && <BudgetActualChart blocks={blocks} />}
      {showInventory && <StockByLocationChart blocks={blocks} />}
    </div>
  )
}
