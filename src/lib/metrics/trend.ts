import {
  isWithin,
  karachiCivil,
  karachiDayRange,
  karachiMonthRange,
  karachiWeekRange,
  type DateRange,
} from '@/lib/finance'
import type { LedgerEntryLike } from '@/lib/finance'
import { sumOperatingExpenses, sumRevenue } from '@/lib/metrics/selectors'

/**
 * Phase 8 chart series (METRICS.md §K).
 *
 * These are pure bucketing helpers over the SAME ledger slice the headline
 * metrics use. A bucket's revenue is `sumRevenue` (§A.1) and its expense is
 * `sumOperatingExpenses` (§A.6) — both are the exact `transactionEffect` walks
 * the P&L reports, so a chart bar always sums back to the figure above it. No
 * financial formula lives here; the only arithmetic is grouping by a Karachi
 * civil bucket and delegating each group to the shared selectors.
 */

export type TrendGranularity = 'day' | 'week' | 'month'

export interface TrendPoint {
  /** Stable, Karachi-civil key (never a UTC ISO prefix, which is off-by-5h). */
  key: string
  label: string
  revenue: number
  operatingExpenses: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad2 = (n: number): string => String(n).padStart(2, '0')
const DAY_MS = 86_400_000

/**
 * Bucket granularity scales with the window so a chart stays readable and the
 * number of bars never explodes on a long custom range: daily inside two weeks,
 * weekly inside about four months, monthly beyond that.
 */
export function pickGranularity(range: DateRange): TrendGranularity {
  const days = karachiDayCountRange(range) + 1
  if (days <= 14) return 'day'
  if (days <= 120) return 'week'
  return 'month'
}

interface Bucket {
  key: string
  label: string
  range: DateRange
}

/**
 * Walk the range in one-day steps and emit one bucket per distinct day/week/month
 * touched, clamped to the selection so a partial edge bucket only counts the
 * in-range days. Keys and labels come from `karachiCivil`, so a Karachi midnight
 * (which is the previous day at 19:00 UTC) is labelled with its true Karachi day.
 */
function bucketsInRange(range: DateRange, granularity: TrendGranularity): Bucket[] {
  const out: Bucket[] = []
  const seen = new Set<string>()
  const lastDay = karachiDayCountRange(range)

  for (let i = 0; i <= lastDay; i += 1) {
    const cursor = new Date(range.start.getTime() + i * DAY_MS)
    const natural =
      granularity === 'day'
        ? karachiDayRange(cursor)
        : granularity === 'week'
          ? karachiWeekRange(cursor)
          : karachiMonthRange(cursor)

    const start = natural.start < range.start ? range.start : natural.start
    const end = natural.end > range.end ? range.end : natural.end

    // Keys and labels come from the bucket's own Karachi civil start (the Monday
    // for a week, the 1st for a month), never a UTC ISO prefix — a Karachi
    // midnight is the previous UTC day at 19:00, so the civil helper is the only
    // correct source.
    const rep = karachiCivil(natural.start)
    const key =
      granularity === 'month'
        ? `${rep.year}-${pad2(rep.month)}`
        : `${rep.year}-${pad2(rep.month)}-${pad2(rep.day)}`
    const label =
      granularity === 'month'
        ? `${MONTHS[rep.month - 1]} ${rep.year}`
        : `${MONTHS[rep.month - 1]} ${rep.day}`

    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, label, range: { start, end } })
  }
  return out
}

/** Inclusive Karachi-day span, matching `karachiDayCount` without importing it twice. */
function karachiDayCountRange(range: DateRange): number {
  const a = karachiDayRange(range.start).start.getTime()
  const b = karachiDayRange(range.end).start.getTime()
  return Math.round((b - a) / DAY_MS)
}

/**
 * Per-bucket revenue + operating expense. Every entry in `entries` is placed in
 * exactly one bucket by its own date, so the series sums back to the period total.
 */
export function buildSalesExpenseSeries(
  entries: LedgerEntryLike[],
  range: DateRange,
  granularity: TrendGranularity
): TrendPoint[] {
  return bucketsInRange(range, granularity).map((bucket) => {
    const inBucket = entries.filter((e) => isWithin(new Date(e.date), bucket.range))
    return {
      key: bucket.key,
      label: bucket.label,
      revenue: sumRevenue(inBucket),
      operatingExpenses: sumOperatingExpenses(inBucket),
    }
  })
}

export interface MonthWindow {
  month: string
  label: string
  range: DateRange
}

/**
 * The distinct Karachi months a range touches, each clamped to the selection so
 * `monthlyProfitSeries` recomputes COGS and P&L over exactly the in-range days.
 */
export function monthsInRange(range: DateRange): MonthWindow[] {
  const seen = new Set<string>()
  const out: MonthWindow[] = []
  const lastDay = karachiDayCountRange(range)
  for (let i = 0; i <= lastDay; i += 1) {
    const cursor = new Date(range.start.getTime() + i * DAY_MS)
    const natural = karachiMonthRange(cursor)
    const rep = karachiCivil(natural.start)
    const month = `${rep.year}-${pad2(rep.month)}`
    if (seen.has(month)) continue
    seen.add(month)
    const start = natural.start < range.start ? range.start : natural.start
    const end = natural.end > range.end ? range.end : natural.end
    out.push({ month, label: `${MONTHS[rep.month - 1]} ${rep.year}`, range: { start, end } })
  }
  return out
}
