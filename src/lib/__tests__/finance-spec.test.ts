/**
 * Phase 3 unit tests — the worked numeric examples from docs/SPEC.md §5
 * executed against the pure ledger maths, plus the Asia/Karachi civil-calendar
 * boundaries the views rely on.
 *
 * SPEC writes its examples in PKR with decimals; the system stores integer
 * paisa (1 PKR = 100 paisa). Every assertion below is the SPEC number × 100.
 */
import { describe, it, expect } from 'vitest';
import {
  transactionEffect,
  summarize,
  computeAccountBalances,
  computeAverages,
  periodTotals,
  karachiCivil,
  karachiMidnight,
  karachiDayRange,
  karachiWeekRange,
  karachiMonthRange,
  karachiDateInputRange,
  karachiDayCount,
  isWithin,
  toCsv,
  type LedgerEntryLike,
} from '../finance';
import { formatPaisa } from '../money';

const PAISA = (pkr: number) => Math.round(pkr * 100);

const income = (
  amount: number,
  accountId = 'cash',
  date = '2026-03-10T12:00:00.000Z'
): LedgerEntryLike => ({ type: 'income', amount, accountId, date });
const expense = (
  amount: number,
  accountId = 'cash',
  date = '2026-03-10T12:00:00.000Z'
): LedgerEntryLike => ({ type: 'expense', amount, accountId, date });

describe('SPEC §5.1 Revenue — worked example', () => {
  // Order totals: PKR 5,000 + 3,500 + 7,200 = PKR 15,700
  const entries: LedgerEntryLike[] = [
    income(PAISA(5000)),
    income(PAISA(3500)),
    income(PAISA(7200)),
  ];

  it('sums revenue in paisa without floats', () => {
    const s = summarize(entries);
    expect(s.revenue).toBe(PAISA(15700));
    expect(s.cashIn).toBe(PAISA(15700));
    expect(s.netCashFlow).toBe(PAISA(15700));
    expect(s.count).toBe(3);
    expect(s.byType.income).toEqual({ count: 3, amount: PAISA(15700) });
  });

  it('keeps integer-exact amount types', () => {
    for (const v of Object.values(summarize(entries))) {
      if (typeof v === 'number') expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe('SPEC §5.2 Net Sales via linked reversals — worked example', () => {
  // Revenue PKR 15,700; a returned order PKR 2,000 and a refunded order
  // PKR 500 are corrected by reversal entries, never by editing the originals.
  // Net Sales = 15,700 − 2,000 − 500 = PKR 13,200
  const entries: LedgerEntryLike[] = [
    income(PAISA(5000)),
    income(PAISA(3500), 'cash', '2026-03-10T12:00:00.000Z'),
    income(PAISA(7200)),
    {
      type: 'income',
      amount: PAISA(2000),
      accountId: 'cash',
      date: '2026-03-10T12:00:00.000Z',
      isReversal: true,
    },
    {
      type: 'income',
      amount: PAISA(500),
      accountId: 'cash',
      date: '2026-03-11T12:00:00.000Z',
      isReversal: true,
    },
  ];

  it('reversals subtract from revenue while originals stay counted', () => {
    const s = summarize(entries);
    expect(s.revenue).toBe(PAISA(13200));
    expect(s.count).toBe(5); // nothing is removed from the ledger
  });

  it('an original plus its reversal cancel out exactly', () => {
    const original = expense(PAISA(1000));
    const reversal: LedgerEntryLike = { ...original, isReversal: true };
    const s = summarize([original, reversal]);
    expect(s.expense).toBe(0);
    expect(s.cashOut).toBe(0);
    expect(s.netCashFlow).toBe(0);
    expect(transactionEffect(reversal).accountDeltas.cash).toBe(PAISA(1000));
  });
});

describe('SPEC §5.6 Cash balance — worked example', () => {
  // Opening PKR 50,000; inflows COD 15,000 + bank transfer 5,000 = 20,000;
  // outflows expenses 4,800; withdrawals locked = 0.
  // Cash Balance = 50,000 + 20,000 − 4,800 = PKR 65,200
  const accounts = [{ _id: 'cash', openingBalance: PAISA(50000) }];
  const entries: LedgerEntryLike[] = [
    income(PAISA(15000)),
    income(PAISA(5000)),
    expense(PAISA(4800)),
  ];

  it('computes the balance as opening + signed effects', () => {
    const balances = computeAccountBalances(accounts, entries);
    expect(balances.cash).toBe(PAISA(65200));
    expect(formatPaisa(balances.cash)).toBe('PKR 65200.00');
  });

  it('summary separates cash flow from profit', () => {
    const s = summarize(entries);
    expect(s.cashIn).toBe(PAISA(20000));
    expect(s.cashOut).toBe(PAISA(4800));
    expect(s.netCashFlow).toBe(PAISA(15200));
    expect(s.netProfit).toBe(PAISA(15200)); // revenue 20,000 − expense 4,800
  });
});

describe('Transfers are neutral (BUILD #3)', () => {
  const transfer: LedgerEntryLike = {
    type: 'transfer',
    amount: PAISA(5000),
    fromAccountId: 'cash',
    toAccountId: 'bank',
    date: '2026-03-10T12:00:00.000Z',
  };

  it('contributes nothing to income, expense or cash flow', () => {
    const e = transactionEffect(transfer);
    expect(e.cashIn).toBe(0);
    expect(e.cashOut).toBe(0);
    expect(e.revenue).toBe(0);
    expect(e.expense).toBe(0);
    expect(e.equity).toBe(0);
    expect(e.accountDeltas.cash).toBe(-PAISA(5000));
    expect(e.accountDeltas.bank).toBe(PAISA(5000));
    expect(e.accountDeltas.cash + e.accountDeltas.bank).toBe(0);
  });

  it('does not move summary totals', () => {
    const withoutTransfer = summarize([income(PAISA(10000), 'cash')]);
    const withTransfer = summarize([income(PAISA(10000), 'cash'), transfer]);
    expect(withTransfer.revenue).toBe(withoutTransfer.revenue);
    expect(withTransfer.netCashFlow).toBe(withoutTransfer.netCashFlow);
    expect(withTransfer.expense).toBe(0);
  });

  it('moves money between balances', () => {
    const accounts = [
      { _id: 'cash', openingBalance: PAISA(8000) },
      { _id: 'bank', openingBalance: PAISA(2000) },
    ];
    const balances = computeAccountBalances(accounts, [transfer]);
    expect(balances.cash).toBe(PAISA(3000));
    expect(balances.bank).toBe(PAISA(7000));
  });

  it('a reversed transfer restores both accounts exactly', () => {
    const accounts = [
      { _id: 'cash', openingBalance: PAISA(8000) },
      { _id: 'bank', openingBalance: PAISA(2000) },
    ];
    const balances = computeAccountBalances(accounts, [
      transfer,
      { ...transfer, isReversal: true },
    ]);
    expect(balances.cash).toBe(PAISA(8000));
    expect(balances.bank).toBe(PAISA(2000));
  });
});

describe('Partner capital, withdrawals and SPEC §5.8 reinvestment', () => {
  // §5.8: reinvestment allocation 826.67 + 413.33 + 826.67 + 0 = PKR 2,066.67
  const entries: LedgerEntryLike[] = [
    {
      type: 'partner_capital',
      amount: PAISA(10000),
      accountId: 'bank',
      partnerId: 'p1',
      date: '2026-03-10T12:00:00.000Z',
    },
    {
      type: 'partner_withdrawal',
      amount: PAISA(3000),
      accountId: 'bank',
      partnerId: 'p1',
      date: '2026-03-12T12:00:00.000Z',
    },
    {
      type: 'reinvestment',
      amount: PAISA(826.67),
      partnerId: 'p1',
      date: '2026-03-30T12:00:00.000Z',
    },
    {
      type: 'reinvestment',
      amount: PAISA(413.33),
      partnerId: 'p2',
      date: '2026-03-30T12:00:00.000Z',
    },
    {
      type: 'reinvestment',
      amount: PAISA(826.67),
      partnerId: 'p3',
      date: '2026-03-30T12:00:00.000Z',
    },
    { type: 'reinvestment', amount: 0, partnerId: 'p4', date: '2026-03-30T12:00:00.000Z' },
  ];

  it('reinvestment is non-cash and moves no account', () => {
    for (const entry of entries.filter((e) => e.type === 'reinvestment')) {
      const e = transactionEffect(entry);
      expect(Object.keys(e.accountDeltas)).toHaveLength(0);
      expect(e.cashIn).toBe(0);
      expect(e.cashOut).toBe(0);
    }
  });

  it('keeps cash flow separate from equity', () => {
    const s = summarize(entries);
    expect(s.capital).toBe(PAISA(10000));
    expect(s.withdrawals).toBe(PAISA(3000));
    expect(s.reinvestment).toBe(PAISA(2066.67));
    expect(s.equity).toBe(PAISA(10000) - PAISA(3000) + PAISA(2066.67));
    // Cash only moved for the capital-in and withdrawal-out legs.
    expect(s.netCashFlow).toBe(PAISA(7000));
    expect(s.revenue).toBe(0);
    expect(s.expense).toBe(0);
  });
});

describe('computeAverages — daily/weekly/monthly conventions', () => {
  // Two Karachi days of activity inside a 4-day range:
  // income 10,000 − expense 4,000 => net cash flow 6,000 PKR.
  const range = {
    start: karachiMidnight(2026, 3, 1),
    end: karachiDayRange(karachiMidnight(2026, 3, 4)).end,
  };
  const entries: LedgerEntryLike[] = [
    income(PAISA(10000), 'cash', '2026-03-01T12:00:00.000Z'),
    expense(PAISA(4000), 'cash', '2026-03-02T12:00:00.000Z'),
  ];

  it('divides net cash flow by Karachi days touched and scales ×7 / ×30', () => {
    const avg = computeAverages(entries, range);
    expect(karachiDayCount(range)).toBe(4);
    expect(avg.perDay).toBe(PAISA(1500)); // 6,000 / 4
    expect(avg.perWeek).toBe(PAISA(10500)); // 1,500 × 7
    expect(avg.perMonth).toBe(PAISA(45000)); // 1,500 × 30
    expect(avg.perEntry).toBe(PAISA(7000)); // (10,000 + 4,000) / 2
  });

  it('treats an empty range as zero, never NaN', () => {
    const avg = computeAverages([], range);
    expect(avg).toEqual({ perDay: 0, perWeek: 0, perMonth: 0, perEntry: 0 });
  });
});

describe('Asia/Karachi civil calendar (fixed UTC+5)', () => {
  it('karachiMidnight is 5 hours before the civil date at UTC midnight', () => {
    expect(karachiMidnight(2026, 1, 1).toISOString()).toBe('2025-12-31T19:00:00.000Z');
  });

  it('groups the hours either side of Karachi midnight correctly', () => {
    // 18:59:59.999 UTC on 2025-12-31 is still 23:59:59.999 Karachi Dec 31.
    expect(karachiCivil(new Date('2025-12-31T18:59:59.999Z'))).toMatchObject({
      year: 2025,
      month: 12,
      day: 31,
    });
    // 19:00:00 UTC is 00:00 Karachi — the first instant of Jan 1.
    expect(karachiCivil(new Date('2025-12-31T19:00:00.000Z'))).toMatchObject({
      year: 2026,
      month: 1,
      day: 1,
    });
  });

  it('day range is exactly one civil day (ends 23:59:59.999 Karachi)', () => {
    const { start, end } = karachiDayRange(new Date('2026-03-15T10:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-03-14T19:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
    expect(isWithin(end, { start, end })).toBe(true);
    expect(isWithin(new Date(end.getTime() + 1), { start, end })).toBe(false);
  });

  it('week starts Monday (2026-10-05 was a Monday)', () => {
    const saturday = new Date('2026-10-10T06:00:00.000Z'); // 11:00 Karachi Sat
    const { start, end } = karachiWeekRange(saturday);
    expect(start.toISOString()).toBe('2026-10-04T19:00:00.000Z'); // Karachi Monday midnight
    expect(karachiCivil(start)).toMatchObject({ dayOfWeek: 1 });
    expect(end.toISOString()).toBe('2026-10-11T18:59:59.999Z'); // end of Karachi Sunday
  });

  it('month range for February 2026 (28 days) uses Karachi boundaries', () => {
    const { start, end } = karachiMonthRange(new Date('2026-02-14T12:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-01-31T19:00:00.000Z');
    expect(end.toISOString()).toBe('2026-02-28T18:59:59.999Z');
  });

  it('December rolls over to the next year', () => {
    const { start, end } = karachiMonthRange(new Date('2026-12-31T18:59:59.999Z'));
    expect(karachiCivil(new Date('2026-12-31T18:59:59.999Z'))).toMatchObject({
      month: 12,
      day: 31,
    });
    expect(start.toISOString()).toBe('2026-11-30T19:00:00.000Z');
    expect(end.toISOString()).toBe('2026-12-31T18:59:59.999Z');
  });

  it('parses YYYY-MM-DD inputs as Karachi days', () => {
    const range = karachiDateInputRange('2026-01-31');
    expect(range?.start.toISOString()).toBe('2026-01-30T19:00:00.000Z');
    expect(karachiDateInputRange('2026-1-31')).toBeNull();
    expect(karachiDateInputRange('2026-13-01')).toBeNull();
    // Impossible days like Feb 31 are rejected by the API schema (zod ledgerDate),
    // not here; karachiDateInputRange pins Date.UTC's forward-roll behaviour.
    expect(karachiDateInputRange('2026-02-31')!.start.toISOString()).toBe(
      '2026-03-02T19:00:00.000Z'
    );
  });

  it('the SPEC withdrawal lock date 2027-02-04 is Karachi midnight', () => {
    // Appendix A: withdrawalLockedUntil: "2027-02-04"
    expect(karachiMidnight(2027, 2, 4).toISOString()).toBe('2027-02-03T19:00:00.000Z');
  });

  it('periodTotals splits entries on Karachi midnight, not UTC midnight', () => {
    // 18:59:59.999Z on Jan 15 belongs to Karachi Jan 15; 19:00:00Z belongs to Karachi Jan 16.
    const early = income(PAISA(1000), 'cash', '2026-01-15T18:59:59.999Z');
    const late = income(PAISA(2000), 'cash', '2026-01-15T19:00:00.000Z');
    const now = new Date('2026-01-16T08:00:00.000Z'); // 13:00 Karachi Jan 16
    const totals = periodTotals([early, late], now);
    expect(totals.day.summary.revenue).toBe(PAISA(2000));
    expect(totals.week.summary.revenue).toBe(PAISA(3000));
    expect(totals.month.summary.revenue).toBe(PAISA(3000));
  });
});

describe('CSV export (BUILD #7)', () => {
  it('escapes quotes, commas and newlines per RFC 4180 and uses CRLF', () => {
    const rows = [
      { note: 'plain', amount: '10.00' },
      { note: 'has,comma', amount: '20.00' },
      { note: 'has "quotes"', amount: '30.00' },
      { note: 'multi\nline', amount: '40.00' },
    ];
    const csv = toCsv(rows, [
      { key: 'note', label: 'Note', value: (r) => r.note },
      { key: 'amount', label: 'Amount', value: (r) => r.amount },
    ]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('Note,Amount');
    expect(lines[2]).toBe('"has,comma",20.00');
    expect(lines[3]).toBe('"has ""quotes""",30.00');
    expect(lines[4]).toBe('"multi\nline",40.00');
  });

  it('renders null and undefined as empty cells', () => {
    const csv = toCsv(
      [{ a: null, b: undefined }],
      [
        { key: 'a', label: 'A', value: (r) => r.a },
        { key: 'b', label: 'B', value: (r) => r.b },
      ]
    );
    expect(csv).toBe('A,B\r\n,');
  });
});
