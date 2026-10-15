/**
 * Phase 8 unit tests — the pure metric logic the dashboard layer adds on top of
 * the (already SPEC-tested) engines: the advertising split (METRICS §A.7), the
 * Karachi period selector (`resolveReportRange`, §0.2), the averages contract
 * including zero-activity days and single-rounding with no lost paisa (§G), and
 * the business-policy advertising default.
 *
 * The engines themselves (P&L, cash flow, budget actuals, distribution) are
 * pinned against the SPEC §5 worked examples in `phase4-spec.test.ts`; these
 * tests cover only what Phase 8 newly composes around them.
 */
import { describe, it, expect } from 'vitest'
import {
  karachiDayRange,
  karachiWeekRange,
  karachiMonthRange,
  karachiMidnight,
  karachiDateInputRange,
  karachiDayCount,
  computeAverages,
  type DateRange,
  type LedgerEntryLike,
} from '@/lib/finance'
import { computeProfitLoss } from '@/lib/profit-loss'
import { resolveReportRange } from '@/lib/cash-flow'
import { advertisingSpend, expenseByCategory, sumOperatingExpenses } from '@/lib/metrics/selectors'
import { resolveBusinessPolicy, SPEC_DEFAULT_ADVERTISING_CATEGORIES } from '@/lib/business-policy'

const PAISA = (pkr: number) => Math.round(pkr * 100)

const entry = (
  type: LedgerEntryLike['type'],
  amount: number,
  extras: Partial<LedgerEntryLike> = {}
): LedgerEntryLike => ({
  type,
  amount,
  accountId: 'cash',
  date: '2026-09-15T12:00:00.000Z',
  ...extras,
})

/* -------------------------------------------------------------------------- */
/* METRICS §A.6 / §A.7 — expense slicing and the advertising subset            */
/* -------------------------------------------------------------------------- */

describe('Advertising spend + operating breakdown (§A.6/§A.7)', () => {
  // SPEC §5.5 example set: ads 2,000 + Shopify 500 + shipping 1,500 + packaging 800
  // plus a refunds line and a purchasing line that must NOT enter operating total.
  const entries: LedgerEntryLike[] = [
    entry('income', PAISA(15700), { category: 'order_sale' }),
    entry('expense', PAISA(2000), { category: 'meta_ads' }),
    entry('expense', PAISA(1000), { category: 'flyers_printing' }),
    entry('expense', PAISA(500), { category: 'shopify_subscription' }),
    entry('expense', PAISA(1500), { category: 'shipping_courier' }),
    entry('expense', PAISA(800), { category: 'packaging' }),
    entry('expense', PAISA(2500), { category: 'refunds_return_costs' }),
    entry('expense', PAISA(4266), { category: 'product_purchasing' }),
  ]
  const advertising = ['meta_ads', 'flyers_printing', 'content_production']

  it('advertising is a strict subset of operating expenses', () => {
    const total = sumOperatingExpenses(entries)
    const ads = advertisingSpend(entries, advertising)
    // meta_ads 2,000 + flyers_printing 1,000 (content_production absent).
    expect(ads).toBe(PAISA(3000))
    // 2,000 + 1,000 + 500 + 1,500 + 800; refunds and purchasing excluded.
    expect(total).toBe(PAISA(5800))
    expect(ads).toBeLessThanOrEqual(total)
  })

  it('a reversal reduces advertising, never creating a second bucket', () => {
    const withReversal = [
      entry('expense', PAISA(2000), { category: 'meta_ads' }),
      entry('expense', PAISA(500), { category: 'meta_ads', isReversal: true }),
    ]
    expect(advertisingSpend(withReversal, advertising)).toBe(PAISA(1500))
  })

  it('no matched categories yields a truthful 0, never a guess', () => {
    expect(advertisingSpend(entries, ['nothing_here'])).toBe(0)
  })

  it('breakdown excludes the reserved categories and sorts largest first', () => {
    const rows = expenseByCategory(entries)
    expect(rows.map((r) => r.category)).toEqual([
      'meta_ads',
      'shipping_courier',
      'flyers_printing',
      'packaging',
      'shopify_subscription',
    ])
    expect(rows.some((r) => r.category === 'product_purchasing')).toBe(false)
    expect(rows.some((r) => r.category === 'refunds_return_costs')).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* METRICS §0.2 — the period selector maps onto Karachi boundaries             */
/* -------------------------------------------------------------------------- */

describe('resolveReportRange — Karachi period selector', () => {
  const toISO = (d: Date) => d.toISOString()

  it('day anchors on the named Karachi civil day', () => {
    const r = resolveReportRange(new URLSearchParams({ period: 'day', date: '2026-09-15' }))!
    expect(r.period).toBe('day')
    // 2026-09-15 Karachi midnight == 2026-09-14T19:00Z.
    expect(toISO(r.range.start)).toBe(toISO(karachiMidnight(2026, 9, 15)))
    expect(r.range).toEqual(karachiDayRange(karachiDateInputRange('2026-09-15')!.start))
  })

  it('week is Monday-based and month spans the full calendar month', () => {
    const anchor = karachiDateInputRange('2026-09-15')!.start
    const week = resolveReportRange(new URLSearchParams({ period: 'week', date: '2026-09-15' }))!
    const month = resolveReportRange(new URLSearchParams({ period: 'month', date: '2026-09-15' }))!
    expect(week.range).toEqual(karachiWeekRange(anchor))
    expect(month.range).toEqual(karachiMonthRange(anchor))
    // Month end is the last day's Karachi 23:59:59.999, not the following midnight.
    expect(month.range.end.getTime()).toBe(karachiMidnight(2026, 10, 1).getTime() - 1)
  })

  it('custom is inclusive of both endpoint Karachi days', () => {
    const r = resolveReportRange(
      new URLSearchParams({ period: 'custom', from: '2026-09-01', to: '2026-09-30' })
    )!
    expect(r.period).toBe('custom')
    expect(toISO(r.range.start)).toBe(toISO(karachiMidnight(2026, 9, 1)))
    expect(r.range.end.getTime()).toBe(karachiMidnight(2026, 9, 30).getTime() + 86_400_000 - 1)
  })

  it('rejects an inverted custom range instead of clipping it', () => {
    expect(
      resolveReportRange(
        new URLSearchParams({ period: 'custom', from: '2026-09-30', to: '2026-09-01' })
      )
    ).toBeNull()
  })

  it('rejects a malformed date and a missing custom endpoint', () => {
    expect(
      resolveReportRange(new URLSearchParams({ period: 'day', date: 'not-a-date' }))
    ).toBeNull()
    expect(
      resolveReportRange(new URLSearchParams({ period: 'custom', from: '2026-09-01' }))
    ).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* METRICS §G — averages, zero-activity days and single rounding               */
/* -------------------------------------------------------------------------- */

describe('computeAverages (§G)', () => {
  const twoDayRange: DateRange = {
    start: karachiMidnight(2026, 9, 1),
    end: new Date(karachiMidnight(2026, 9, 2).getTime() + 86_400_000 - 1),
  }

  it('divides by CALENDAR days, so a quiet day correctly pulls the average down', () => {
    // One income on day 1; day 2 is empty. netCashFlow == 10,000 paisa over 2 days.
    const entries = [entry('income', PAISA(100), { date: toKarachiNoon(2026, 9, 1) })]
    const avg = computeAverages(entries, twoDayRange)
    expect(karachiDayCount(twoDayRange)).toBe(2)
    expect(avg.perDay).toBe(5000) // 10,000 / 2
    expect(avg.perWeek).toBe(Math.round((10000 / 2) * 7))
    expect(avg.perMonth).toBe(Math.round((10000 / 2) * 30))
  })

  it('an empty period is 0, never a divide-by-zero or NaN', () => {
    const avg = computeAverages([], twoDayRange)
    expect(avg.perDay).toBe(0)
    expect(avg.perWeek).toBe(0)
    expect(avg.perMonth).toBe(0)
    expect(Number.isNaN(avg.perDay)).toBe(false)
  })

  it('rounds once and stays integer — no fractional paisa leaks out', () => {
    const entries = [entry('income', 10001, { date: toKarachiNoon(2026, 9, 1) })] // 100.01 PKR
    const avg = computeAverages(entries, twoDayRange)
    for (const v of [avg.perDay, avg.perWeek, avg.perMonth, avg.perEntry]) {
      expect(Number.isInteger(v)).toBe(true)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* METRICS §G — the dashboard's net-profit-per-day average reuses the engine   */
/* -------------------------------------------------------------------------- */

describe('net profit per day (§G)', () => {
  it('is the engine net profit over the range days, rounded once', () => {
    const range: DateRange = {
      start: karachiMidnight(2026, 9, 1),
      end: new Date(karachiMidnight(2026, 9, 2).getTime() + 86_400_000 - 1),
    }
    const entries = [
      entry('income', PAISA(1000), { category: 'order_sale', date: toKarachiNoon(2026, 9, 1) }),
      entry('expense', PAISA(200), { category: 'meta_ads', date: toKarachiNoon(2026, 9, 1) }),
    ]
    const pl = computeProfitLoss(entries) // net 800 PKR (no cogs provided → purchasing 0)
    expect(pl.netProfit).toBe(PAISA(800))
    expect(Math.round(pl.netProfit / Math.max(1, karachiDayCount(range)))).toBe(PAISA(400))
  })
})

/* -------------------------------------------------------------------------- */
/* METRICS §A.7 — advertising categories resolve through business policy        */
/* -------------------------------------------------------------------------- */

describe('resolveBusinessPolicy — advertising categories', () => {
  it('falls back to the SPEC marketing slugs when unconfigured', () => {
    expect(resolveBusinessPolicy(null).advertisingCategories).toEqual(
      SPEC_DEFAULT_ADVERTISING_CATEGORIES
    )
    expect(SPEC_DEFAULT_ADVERTISING_CATEGORIES).toContain('meta_ads')
  })

  it('honours a Founder-configured set', () => {
    const settings = { advertisingCategories: ['sponsorships'] } as never
    expect(resolveBusinessPolicy(settings).advertisingCategories).toEqual(['sponsorships'])
  })
})

/** A UTC instant that is midday on the named Karachi civil day (safely inside it). */
function toKarachiNoon(year: number, month: number, day: number): string {
  return new Date(karachiMidnight(year, month, day).getTime() + 12 * 3600_000).toISOString()
}
