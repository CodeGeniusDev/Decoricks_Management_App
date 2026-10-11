/**
 * Phase 4 unit tests — the worked numeric examples from docs/SPEC.md §5
 * executed against the pure Phase 4 engines (P&L, cash flow, budget actuals,
 * profit distribution), plus the rounding and Karachi-boundary invariants the
 * brief demands: paisa must always add up exactly, with no lost paisa.
 *
 * SPEC writes its examples in PKR with decimals; the system stores integer
 * paisa (1 PKR = 100 paisa). Every assertion below is the SPEC number × 100.
 */
import { describe, it, expect } from 'vitest';
import {
  karachiMidnight,
  karachiMonthRange,
  karachiWeekRange,
  karachiDateInputRange,
  isWithin,
  type LedgerEntryLike,
} from '../finance';
import { computeProfitLoss, resolveCogs } from '../profit-loss';
import { computeCashFlow } from '../cash-flow';
import { computeDistribution, largestRemainderSplit, allocateExactly } from '../distribution-math';
import {
  computeBudgetActuals,
  derivePeriodKind,
  validatePeriodKind,
  budgetPeriodRange,
} from '../budget-actuals';
import { SPEC_DEFAULT_BUDGET_THRESHOLDS } from '../business-policy';
import type { ProfitSharePartner } from '../models/Ledger';

const PAISA = (pkr: number) => Math.round(pkr * 100);

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
});

/* -------------------------------------------------------------------------- */
/* SPEC §5.1–§5.5 — the full P&L chain from ledger entries                      */
/* -------------------------------------------------------------------------- */

describe('SPEC §5 P&L — worked example (net profit PKR 4,133.36)', () => {
  // Revenue 5,000 + 3,500 + 7,200 = 15,700 (§5.1)
  // Refunds 2,000 + 500 = 2,500 as refunds_return_costs expenses (§5.2)
  // COGS 4,266.64 provided by the inventory seam (§5.3)
  // OpEx: ads 2,000 + Shopify 500 + shipping 1,500 + packaging 800 = 4,800 (§5.5)
  const entries: LedgerEntryLike[] = [
    entry('income', PAISA(5000), { category: 'order_sale' }),
    entry('income', PAISA(3500), { category: 'order_sale' }),
    entry('income', PAISA(7200), { category: 'order_sale' }),
    entry('expense', PAISA(2000), { category: 'refunds_return_costs' }),
    entry('expense', PAISA(500), { category: 'refunds_return_costs' }),
    entry('expense', PAISA(2000), { category: 'meta_ads' }),
    entry('expense', PAISA(500), { category: 'shopify_subscription' }),
    entry('expense', PAISA(1500), { category: 'shipping_courier' }),
    entry('expense', PAISA(800), { category: 'packaging' }),
  ];

  it('produces every §5 figure exactly, in integer paisa', () => {
    const pl = computeProfitLoss(entries, {
      cogs: { amount: PAISA(4266.64), provisional: false, source: 'inventory weighted average' },
    });
    expect(pl.revenue).toBe(PAISA(15700));
    expect(pl.refunds).toBe(PAISA(2500));
    expect(pl.netSales).toBe(PAISA(13200)); // §5.2
    expect(pl.grossProfit).toBe(PAISA(8933.36)); // §5.4
    expect(pl.operatingExpenses).toBe(PAISA(4800));
    expect(pl.netProfit).toBe(PAISA(4133.36)); // §5.5 anchor
    expect(pl.count).toBe(9);
    for (const value of [pl.revenue, pl.refunds, pl.netSales, pl.grossProfit, pl.operatingExpenses, pl.netProfit]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('keeps refunds and purchasing out of the operating-expense breakdown', () => {
    const pl = computeProfitLoss(entries);
    const categories = pl.operatingLines.map((line) => line.category);
    expect(categories).not.toContain('refunds_return_costs');
    expect(categories).not.toContain('product_purchasing');
    expect(pl.operatingLines).toHaveLength(4); // ads, shopify, shipping, packaging
  });
});

describe('Provisional COGS — purchasing stands in until Phase 5 (§5.3 seam)', () => {
  const withPurchasing: LedgerEntryLike[] = [
    entry('income', PAISA(13200), { category: 'order_sale' }),
    entry('expense', PAISA(4266.64), { category: 'product_purchasing' }),
    entry('expense', PAISA(4800), { category: 'meta_ads' }),
  ];

  it('uses product_purchasing and flags it provisional when no inventory data exists', () => {
    const pl = computeProfitLoss(withPurchasing);
    expect(pl.cogs).toBe(PAISA(4266.64));
    expect(pl.cogsProvisional).toBe(true);
    expect(pl.cogsSource).toContain('product_purchasing');
    // Purchasing is COGS — never also an operating expense (no double count).
    expect(pl.operatingExpenses).toBe(PAISA(4800));
    expect(pl.netProfit).toBe(PAISA(13200) - PAISA(4266.64) - PAISA(4800));
  });

  it('resolveCogs prefers the inventory-provided figure verbatim', () => {
    const provided = { amount: PAISA(1000), provisional: false, source: 'inventory' };
    expect(resolveCogs(withPurchasing, provided)).toEqual(provided);
  });

  it('reversals subtract from COGS instead of creating a second bucket', () => {
    const entries: LedgerEntryLike[] = [
      entry('expense', PAISA(1000), { category: 'product_purchasing' }),
      entry('expense', PAISA(300), { category: 'product_purchasing', isReversal: true }),
    ];
    expect(resolveCogs(entries).amount).toBe(PAISA(700));
  });
});

/* -------------------------------------------------------------------------- */
/* Karachi period boundaries (midnight-anchored reporting)                     */
/* -------------------------------------------------------------------------- */

describe('Asia/Karachi period boundaries', () => {
  it('a Karachi month starts at Karachi midnight = 19:00 UTC the day before', () => {
    const range = karachiMonthRange(new Date('2026-09-15T12:00:00.000Z'));
    expect(range.start.toISOString()).toBe('2026-08-31T19:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-09-30T18:59:59.999Z');
  });

  it('week ranges start on Monday', () => {
    // Saturday 10 Oct 2026 (Karachi) → Monday 5 Oct … Sunday 11 Oct.
    const range = karachiWeekRange(new Date('2026-10-10T12:00:00.000Z'));
    expect(range.start.toISOString()).toBe('2026-10-04T19:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-10-11T18:59:59.999Z');
  });

  it('a YYYY-MM-DD input resolves to that Karachi day, not the UTC one', () => {
    const range = karachiDateInputRange('2026-10-10');
    expect(range).not.toBeNull();
    expect(range!.start.toISOString()).toBe('2026-10-09T19:00:00.000Z');
    expect(range!.end.toISOString()).toBe('2026-10-10T18:59:59.999Z');
    // 20:00 UTC on the 9th is already the 10th in Karachi.
    expect(isWithin(new Date('2026-10-09T20:00:00.000Z'), range!)).toBe(true);
    expect(isWithin(new Date('2026-10-09T18:00:00.000Z'), range!)).toBe(false);
  });

  it('budget periods expand to full inclusive Karachi days', () => {
    const range = budgetPeriodRange(karachiMidnight(2026, 9, 1), karachiMidnight(2026, 9, 30));
    expect(range.start.toISOString()).toBe('2026-08-31T19:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-09-30T18:59:59.999Z');
  });
});

/* -------------------------------------------------------------------------- */
/* Budget vs actual — actuals computed from the ledger, never typed            */
/* -------------------------------------------------------------------------- */

describe('Budget actuals — ledger-derived with reversals, boundaries and thresholds', () => {
  const budget = {
    categories: [
      { category: 'meta_ads', budgeted: PAISA(5000) },
      { category: 'shipping_courier', budgeted: PAISA(2000) },
    ],
    periodStart: karachiMidnight(2026, 9, 1),
    periodEnd: karachiMidnight(2026, 9, 30),
  };

  const entries: LedgerEntryLike[] = [
    entry('expense', PAISA(4010), { category: 'meta_ads' }),
    entry('expense', PAISA(250), { category: 'meta_ads', isReversal: true }),
    // 01:30 Karachi on Sep 1 — inside the period even though UTC says Aug 31.
    entry('expense', PAISA(100), { category: 'meta_ads', date: '2026-08-31T20:30:00.000Z' }),
    // 23:00 Karachi on Aug 31 — outside the period.
    entry('expense', PAISA(500), { category: 'meta_ads', date: '2026-08-31T18:00:00.000Z' }),
    entry('expense', PAISA(1610), { category: 'shipping_courier', date: '2026-09-10T08:00:00.000Z' }),
    // Ignored entirely: transfers and unplanned categories are not actuals.
    entry('transfer', PAISA(1000), { fromAccountId: 'cash', toAccountId: 'bank' }),
    entry('expense', PAISA(500), { category: 'miscellaneous', date: '2026-09-10T08:00:00.000Z' }),
  ];

  it('computes allocated, spent, remaining and percentage per category', () => {
    const actuals = computeBudgetActuals(budget, entries);
    const ads = actuals.categories.find((c) => c.category === 'meta_ads')!;
    const shipping = actuals.categories.find((c) => c.category === 'shipping_courier')!;
    // 4,010 − 250 + 100 = 3,860 (reversal counts as negative, boundary entry in, Aug 31 out)
    expect(ads.actual).toBe(PAISA(3860));
    expect(ads.remaining).toBe(PAISA(1140));
    expect(ads.percentUsed).toBe(77);
    expect(ads.level).toBe('ok');
    // 1,610 / 2,000 = 80.5% → 81 → past the configured 80 warning
    expect(shipping.actual).toBe(PAISA(1610));
    expect(shipping.percentUsed).toBe(81);
    expect(shipping.level).toBe('warning');
    expect(actuals.totalBudgeted).toBe(PAISA(7000));
    expect(actuals.totalActual).toBe(PAISA(5470));
    expect(actuals.totalRemaining).toBe(PAISA(1530));
    expect(actuals.percentUsed).toBe(78);
  });

  it('emits warnings carrying the threshold that fired (notification feed hook)', () => {
    const actuals = computeBudgetActuals(budget, entries);
    expect(actuals.warnings).toEqual([
      { category: 'shipping_courier', level: 'warning', percentUsed: 81, threshold: 80 },
    ]);
  });

  it('honours configurable thresholds instead of hard-coded 80/100', () => {
    const actuals = computeBudgetActuals(budget, entries, { warning: 75, critical: 90 });
    const levels = Object.fromEntries(actuals.categories.map((c) => [c.category, c.level]));
    expect(levels.meta_ads).toBe('warning'); // 77% ≥ 75
    expect(SPEC_DEFAULT_BUDGET_THRESHOLDS).toEqual({ warning: 80, critical: 100 });
  });

  it('marks over-spend critical and keeps negative remainings visible', () => {
    const actuals = computeBudgetActuals(
      { ...budget, categories: [{ category: 'meta_ads', budgeted: PAISA(1000) }] },
      entries
    );
    const ads = actuals.categories[0];
    expect(ads.percentUsed).toBe(386);
    expect(ads.level).toBe('critical');
    expect(ads.remaining).toBe(-PAISA(2860));
  });

  it('lists only budgeted in-period expense entries as source records for the calc panel', () => {
    const actuals = computeBudgetActuals(budget, entries);
    expect(actuals.sourceEntries).toHaveLength(4); // 3 ads (incl. reversal) + 1 shipping
    expect(actuals.sourceEntries.some((e) => e.category === 'miscellaneous')).toBe(false);
    expect(actuals.sourceEntries.some((e) => e.type === 'transfer')).toBe(false);
    const reversal = actuals.sourceEntries.find((e) => e.amount < 0);
    expect(reversal!.amount).toBe(-PAISA(250));
  });
});

describe('Budget period kinds', () => {
  it('derives monthly, weekly and custom from the dates', () => {
    expect(derivePeriodKind(karachiMidnight(2026, 9, 1), karachiMidnight(2026, 9, 30))).toBe('monthly');
    expect(derivePeriodKind(karachiMidnight(2026, 2, 1), karachiMidnight(2026, 2, 28))).toBe('monthly');
    expect(derivePeriodKind(karachiMidnight(2026, 9, 1), karachiMidnight(2026, 9, 7))).toBe('weekly');
    expect(derivePeriodKind(karachiMidnight(2026, 9, 1), karachiMidnight(2026, 9, 8))).toBe('custom');
  });

  it('rejects asserted kinds the dates do not match', () => {
    expect(validatePeriodKind('monthly', karachiMidnight(2026, 9, 1), karachiMidnight(2026, 9, 29))).toContain('full Karachi calendar month');
    expect(validatePeriodKind('weekly', karachiMidnight(2026, 9, 1), karachiMidnight(2026, 9, 9))).toContain('at most 7 days');
    expect(validatePeriodKind('monthly', karachiMidnight(2026, 9, 1), karachiMidnight(2026, 9, 30))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Cash flow — separate from profit, transfers neutral (SPEC §5.6)             */
/* -------------------------------------------------------------------------- */

describe('SPEC §5.6 cash balance — worked example (PKR 65,200)', () => {
  const accounts = [{ _id: 'cash', name: 'Cash', kind: 'cash', openingBalance: PAISA(50000), isActive: true }];
  const inRange: LedgerEntryLike[] = [
    entry('income', PAISA(15000), { category: 'order_sale' }), // COD received
    entry('income', PAISA(5000), { category: 'order_sale' }), // bank transfer receipt
    entry('expense', PAISA(2000), { category: 'meta_ads' }),
    entry('expense', PAISA(500), { category: 'shopify_subscription' }),
    entry('expense', PAISA(1500), { category: 'shipping_courier' }),
    entry('expense', PAISA(800), { category: 'packaging' }),
  ];

  it('opening + in − out lands on the SPEC figure exactly', () => {
    const cf = computeCashFlow(accounts, [], inRange);
    expect(cf.cashIn).toBe(PAISA(20000));
    expect(cf.cashOut).toBe(PAISA(4800));
    expect(cf.netCashFlow).toBe(PAISA(15200));
    expect(cf.totalBalanceStart).toBe(PAISA(50000));
    expect(cf.totalBalanceEnd).toBe(PAISA(65200)); // §5.6 anchor
    expect(cf.accounts[0].balanceEnd).toBe(PAISA(65200));
  });
});

describe('Cash flow vs accounting profit — the separation the brief demands', () => {
  it('transfers move cash between accounts and change no business flow', () => {
    const accounts = [
      { _id: 'cash', name: 'Cash', kind: 'cash', openingBalance: PAISA(50000), isActive: true },
      { _id: 'bank', name: 'Bank', kind: 'bank', openingBalance: 0, isActive: true },
    ];
    const inRange: LedgerEntryLike[] = [
      entry('income', PAISA(10000), { category: 'order_sale' }),
      entry('transfer', PAISA(2000), { fromAccountId: 'cash', toAccountId: 'bank' }),
    ];
    const cf = computeCashFlow(accounts, [], inRange);
    expect(cf.cashIn).toBe(PAISA(10000)); // transfer excluded
    expect(cf.cashOut).toBe(0);
    expect(cf.transferCount).toBe(1);
    // Cash physically moved, but the total position is exactly opening + income.
    expect(cf.accounts.find((a) => a.accountId === 'cash')!.balanceEnd).toBe(PAISA(58000));
    expect(cf.accounts.find((a) => a.accountId === 'bank')!.balanceEnd).toBe(PAISA(2000));
    expect(cf.totalBalanceEnd).toBe(PAISA(60000));
  });

  it('partner capital and withdrawals are cash events with zero P&L effect', () => {
    const entries: LedgerEntryLike[] = [
      entry('partner_capital', PAISA(10000), { partnerName: 'Hasnat' }),
      entry('partner_withdrawal', PAISA(4000), { partnerName: 'Hasnat' }),
    ];
    const pl = computeProfitLoss(entries);
    expect(pl.netProfit).toBe(0); // equity never touches the P&L

    const accounts = [{ _id: 'cash', name: 'Cash', kind: 'cash', openingBalance: 0, isActive: true }];
    const cf = computeCashFlow(accounts, [], entries);
    expect(cf.capitalIn).toBe(PAISA(10000));
    expect(cf.withdrawalsOut).toBe(PAISA(4000));
    expect(cf.netCashFlow).toBe(PAISA(6000));
    expect(cf.totalBalanceEnd).toBe(PAISA(6000));
  });
});

/* -------------------------------------------------------------------------- */
/* Profit distribution — SPEC §5.8 worked example and rounding invariants      */
/* -------------------------------------------------------------------------- */

const SPEC_PARTNERS: ProfitSharePartner[] = [
  { name: 'Abdullah', percentage: 20, reinvestPercentage: 100 },
  { name: 'Hasnat', percentage: 20, reinvestPercentage: 50 },
  { name: 'Ali', percentage: 20, reinvestPercentage: 100 },
  { name: 'Afnan', percentage: 20, reinvestPercentage: 0 },
];

describe('SPEC §5.8 — distribution of net profit PKR 4,133.36', () => {
  const result = computeDistribution({
    netProfit: PAISA(4133.36),
    partners: SPEC_PARTNERS,
    charityPercentage: 20,
  });

  it('splits into five 20% buckets with the leftover paisa deterministic', () => {
    // 413,336 / 5 = 82,667.2 → four partner buckets of 82,667 and charity 82,668.
    expect(result.charityAmount).toBe(82668);
    expect(result.partners.map((p) => p.shareAmount)).toEqual([82667, 82667, 82667, 82667]);
    expect(result.charityAmount + result.partners.reduce((s, p) => s + p.shareAmount, 0)).toBe(PAISA(4133.36));
  });

  it('reinvests per partner with floors and lands on PKR 2,066.67 total', () => {
    expect(result.partners.map((p) => p.reinvestedAmount)).toEqual([82667, 41333, 82667, 0]);
    expect(result.totalReinvested).toBe(PAISA(2066.67)); // §5.8 anchor
    // Sub-floor paisa stay on the partner's side — nothing is lost.
    expect(result.partners[1].availableToWithdraw).toBe(82667 - 41333);
    expect(result.partners[0].availableToWithdraw).toBe(0);
    expect(result.partners[3].availableToWithdraw).toBe(82667);
  });

  it('retained earnings close the books exactly', () => {
    expect(result.retainedEarnings).toBe(0);
    expect(result.charityAmount + result.totalFinalShares + result.retainedEarnings).toBe(result.netProfit);
  });
});

describe('largestRemainderSplit — no lost paisa, ever', () => {
  it('allocates the exact total across uneven weights', () => {
    const parts = largestRemainderSplit(1000003, [
      { key: 'charity', weight: 10 },
      { key: 'a', weight: 40 },
      { key: 'b', weight: 30 },
      { key: 'c', weight: 20 },
    ]);
    expect(parts).toEqual([100000, 400001, 300001, 200001]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(1000003);
  });

  it('leaves the unallocated residual with the caller when weights sum below 100', () => {
    const parts = largestRemainderSplit(10000, [
      { key: 'a', weight: 30 },
      { key: 'b', weight: 20 },
    ]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(5000); // half the whole, exact
  });

  it('returns zeros for degenerate inputs', () => {
    expect(largestRemainderSplit(1000, [{ key: 'x', weight: 0 }])).toEqual([0]);
    expect(largestRemainderSplit(1000, [])).toEqual([]);
  });

  it('allocateExactly always distributes the full total across relative weights', () => {
    // Unlike largestRemainderSplit there is no percentage pool: weights 30:20
    // (summing to 50) still receive all 7 paisa — 4.2 / 2.8 → 4 / 3.
    const parts = allocateExactly(7, [30, 20]);
    expect(parts).toEqual([4, 3]);
    for (const total of [1, 3, 7, 99, 1000003]) {
      for (const weights of [[1], [30, 20], [40, 30, 20], [1, 1, 1, 1, 1]]) {
        const alloc = allocateExactly(total, weights);
        expect(alloc.reduce((s, v) => s + v, 0)).toBe(total);
      }
    }
    expect(allocateExactly(100, [0, 0])).toEqual([0, 0]);
    expect(allocateExactly(100, [])).toEqual([]);
  });

  it('holds the grand-total invariant across awkward profit values', () => {
    for (const netProfit of [1, 7, 99, 101, 1000003, 123456789, 413336]) {
      const r = computeDistribution({ netProfit, partners: SPEC_PARTNERS, charityPercentage: 20 });
      expect(r.charityAmount + r.totalFinalShares + r.retainedEarnings).toBe(netProfit);
      expect(Number.isInteger(r.charityAmount)).toBe(true);
      r.partners.forEach((p) => {
        expect(Number.isInteger(p.shareAmount)).toBe(true);
        expect(Number.isInteger(p.reinvestedAmount)).toBe(true);
        expect(p.availableToWithdraw).toBe(p.finalAmount - p.reinvestedAmount);
      });
    }
  });
});

describe('Profit-share adjustments — redistribution per the settings', () => {
  const base = {
    netProfit: 1000003,
    partners: [
      { userId: 'A', name: 'A', percentage: 40, reinvestPercentage: 0 },
      { userId: 'B', name: 'B', percentage: 30, reinvestPercentage: 0 },
      { userId: 'C', name: 'C', percentage: 20, reinvestPercentage: 0 },
    ] as ProfitSharePartner[],
    charityPercentage: 10,
  };

  it('a deduction is redistributed pro-rata and is exactly zero-sum', () => {
    const plain = computeDistribution(base);
    const adjusted = computeDistribution({
      ...base,
      adjustments: [{ partnerKey: 'A', amount: -7, reason: 'Damaged stock chargeback' }],
    });
    // Σ finals unchanged: the 7 paisa went back to B and C, charity untouched.
    expect(adjusted.totalFinalShares).toBe(plain.totalFinalShares);
    expect(adjusted.charityAmount).toBe(plain.charityAmount);
    expect(adjusted.retainedEarnings).toBe(plain.retainedEarnings);
    expect(adjusted.partners[0].finalAmount).toBe(plain.partners[0].finalAmount - 7);
    const gained =
      adjusted.partners[1].finalAmount - plain.partners[1].finalAmount +
      (adjusted.partners[2].finalAmount - plain.partners[2].finalAmount);
    expect(gained).toBe(7);
    // 7 paisa across relative weights 30:20 → raw 4.2 / 2.8 → floors 4 / 2,
    // the leftover paisa goes to the larger remainder (C): B +4, C +3.
    expect(adjusted.partners[1].finalAmount - plain.partners[1].finalAmount).toBe(4);
    expect(adjusted.partners[2].finalAmount - plain.partners[2].finalAmount).toBe(3);
    expect(adjusted.charityAmount + adjusted.totalFinalShares + adjusted.retainedEarnings).toBe(base.netProfit);
  });

  it('a bonus is funded from retained earnings, never from the other partners', () => {
    const plain = computeDistribution(base);
    const adjusted = computeDistribution({
      ...base,
      adjustments: [{ partnerKey: 'C', amount: 5000, reason: 'Ramadan incentive agreed by partners' }],
    });
    expect(adjusted.partners[0].finalAmount).toBe(plain.partners[0].finalAmount);
    expect(adjusted.partners[1].finalAmount).toBe(plain.partners[1].finalAmount);
    expect(adjusted.partners[2].finalAmount).toBe(plain.partners[2].finalAmount + 5000);
    expect(adjusted.retainedEarnings).toBe(plain.retainedEarnings - 5000);
    expect(adjusted.charityAmount + adjusted.totalFinalShares + adjusted.retainedEarnings).toBe(base.netProfit);
  });

  it('adjustments skip unknown partners and zeros without corrupting the split', () => {
    const adjusted = computeDistribution({
      ...base,
      adjustments: [
        { partnerKey: 'ghost', amount: 100, reason: 'no such partner' },
        { partnerKey: 'A', amount: 0, reason: 'noop' },
      ],
    });
    const plain = computeDistribution(base);
    expect(adjusted.totalFinalShares).toBe(plain.totalFinalShares);
  });
});
