/**
 * Phase 8 — chart series helpers (METRICS.md §K).
 *
 * Pure, DB-free coverage of the only new arithmetic the chart layer adds: bucket
 * the SAME ledger slice the headline P&L uses by a Karachi civil day/week/month.
 * These tests pin the invariants that make a chart trustworthy — every entry
 * lands in exactly one bucket (so the series sums back to the period total), a
 * quiet day is a real 0 rather than a gap, reserved categories stay out of the
 * operating line, and month windows are keyed by the Karachi civil month (never a
 * UTC ISO prefix, which is a day off at a Karachi midnight).
 */
import { describe, it, expect } from 'vitest'
import {
  karachiMidnight,
  karachiDayRange,
  type DateRange,
  type LedgerEntryLike,
} from '@/lib/finance'
import { sumOperatingExpenses, sumRevenue } from '@/lib/metrics/selectors'
import { buildSalesExpenseSeries, monthsInRange, pickGranularity } from '@/lib/metrics/trend'

const PAISA = (pkr: number) => Math.round(pkr * 100)
/** A mid-day UTC instant that sits on the given Karachi civil day. */
const day = (month: number, d: number): Date =>
  new Date(karachiMidnight(2026, month, d).getTime() + 12 * 3600_000)

const entry = (
  type: LedgerEntryLike['type'],
  amount: number,
  when: Date,
  category?: string
): LedgerEntryLike => ({
  type,
  amount,
  accountId: 'cash',
  date: when.toISOString(),
  ...(category ? { category } : {}),
})

describe('buildSalesExpenseSeries — bucketing reconciles with the period total', () => {
  // A 3-day September window: activity on day 1 and day 3, none on day 2.
  const range: DateRange = {
    start: karachiDayRange(day(9, 1)).start,
    end: karachiDayRange(day(9, 3)).end,
  }
  const entries: LedgerEntryLike[] = [
    entry('income', PAISA(3200), day(9, 1), 'order_sale'),
    entry('expense', PAISA(2000), day(9, 1), 'meta_ads'),
    entry('expense', PAISA(500), day(9, 1), 'product_purchasing'), // reserved → not opEx
    entry('income', PAISA(1000), day(9, 3), 'order_sale'),
    entry('expense', PAISA(400), day(9, 3), 'refunds_return_costs'), // reserved → not opEx
  ]

  const series = buildSalesExpenseSeries(entries, range, 'day')

  it('produces one bucket per Karachi day, including the quiet day', () => {
    expect(series).toHaveLength(3)
    expect(series[1]).toMatchObject({ revenue: 0, operatingExpenses: 0 })
  })

  it('buckets sum back to the exact period revenue and operating expenses', () => {
    const totalRevenue = series.reduce((s, b) => s + b.revenue, 0)
    const totalOpEx = series.reduce((s, b) => s + b.operatingExpenses, 0)
    expect(totalRevenue).toBe(sumRevenue(entries))
    expect(totalOpEx).toBe(sumOperatingExpenses(entries))
    expect(totalRevenue).toBe(PAISA(4200))
    // 2,000 ads only — purchasing and refunds are reserved, never in opEx.
    expect(totalOpEx).toBe(PAISA(2000))
  })

  it('labels and keys come from the Karachi civil calendar', () => {
    expect(series.map((b) => b.key)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(series[0].label).toBe('Sep 1')
  })
})

describe('pickGranularity — window length chooses the bucket size', () => {
  it('daily within two weeks, weekly within about four months, monthly beyond', () => {
    const mk = (days: number): DateRange => ({
      start: karachiDayRange(day(1, 1)).start,
      end: new Date(karachiDayRange(day(1, 1)).start.getTime() + (days - 1) * 86_400_000),
    })
    expect(pickGranularity(mk(7))).toBe('day')
    expect(pickGranularity(mk(15))).toBe('week')
    expect(pickGranularity(mk(200))).toBe('month')
  })
})

describe('monthsInRange — civil month windows, clamped to the selection', () => {
  const range: DateRange = {
    start: day(8, 20),
    end: day(10, 5),
  }
  const windows = monthsInRange(range)

  it('spans the touched Karachi months with civil-correct labels', () => {
    expect(windows.map((w) => w.month)).toEqual(['2026-08', '2026-09', '2026-10'])
    expect(windows.map((w) => w.label)).toEqual(['Aug 2026', 'Sep 2026', 'Oct 2026'])
  })

  it('clamps the first and last windows to the selection edges', () => {
    expect(windows[0].range.start.getTime()).toBe(range.start.getTime())
    expect(windows[windows.length - 1].range.end.getTime()).toBe(range.end.getTime())
    // A mid window is the full calendar month.
    expect(windows[1].month).toBe('2026-09')
  })
})
