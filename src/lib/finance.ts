/**
 * Pure finance maths for the Phase 3 ledger.
 *
 * This module is isomorphic: it has no MongoDB and no Next.js imports, so the
 * routes, the client and the unit tests all share exactly one implementation of
 * the arithmetic. Every monetary value is an integer number of paisa
 * (1 PKR = 100 paisa); nothing here ever uses floating point for money.
 *
 * The ledger is append-only. A posted entry is never edited or deleted; instead
 * a linked *reversal* entry is posted with the opposite effect. Because a
 * reversal negates every effect, an original and its reversal cancel out in
 * every total — which is why the summary functions sum signed amounts and never
 * special-case `status`.
 */

export type LedgerEntryType =
  | 'income'
  | 'expense'
  | 'transfer'
  | 'partner_capital'
  | 'partner_withdrawal'
  | 'reinvestment'

export type LedgerEntryStatus = 'posted' | 'reversed'

export type AccountKind = 'cash' | 'bank' | 'wallet'

/** Structural subset of a stored transaction that the pure maths needs. */
export interface LedgerEntryLike {
  _id?: string
  type: LedgerEntryType
  amount: number
  date: Date | string
  accountId?: string
  fromAccountId?: string
  toAccountId?: string
  category?: string
  partnerId?: string
  partnerName?: string
  isReversal?: boolean
  status?: LedgerEntryStatus
}

export const LEDGER_ENTRY_TYPES: LedgerEntryType[] = [
  'income',
  'expense',
  'transfer',
  'partner_capital',
  'partner_withdrawal',
  'reinvestment',
]

export const ENTRY_TYPE_LABELS: Record<LedgerEntryType, string> = {
  income: 'Income',
  expense: 'Expense',
  transfer: 'Transfer',
  partner_capital: 'Partner capital',
  partner_withdrawal: 'Partner withdrawal',
  reinvestment: 'Reinvestment',
}

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  cash: 'Cash',
  bank: 'Bank',
  wallet: 'Wallet',
}

export const ACCOUNT_KINDS: AccountKind[] = ['cash', 'bank', 'wallet']

/** Types whose account is a single `accountId`. */
export const SINGLE_ACCOUNT_TYPES: ReadonlySet<LedgerEntryType> = new Set([
  'income',
  'expense',
  'partner_capital',
  'partner_withdrawal',
  'reinvestment',
])

export interface TransactionEffect {
  /** accountId -> signed paisa delta. */
  accountDeltas: Record<string, number>
  cashIn: number
  cashOut: number
  revenue: number
  expense: number
  equity: number
}

const toInt = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0

/**
 * Effect of a single entry.
 *
 * `reinvestment` (SPEC §5.8) is a *non-cash* allocation: it records that part
 * of profit is retained in the business. It never moves money between accounts
 * and never counts as an inflow or outflow. `transfer` moves money between two
 * accounts and is neutral to the business as a whole.
 *
 * Reversals negate every effect, including both legs of a transfer.
 */
export function transactionEffect(entry: LedgerEntryLike): TransactionEffect {
  const sign = entry.isReversal ? -1 : 1
  const amount = sign * toInt(entry.amount)

  const effect: TransactionEffect = {
    accountDeltas: {},
    cashIn: 0,
    cashOut: 0,
    revenue: 0,
    expense: 0,
    equity: 0,
  }

  const addDelta = (accountId: string | undefined, delta: number) => {
    if (!accountId) return
    effect.accountDeltas[accountId] = (effect.accountDeltas[accountId] ?? 0) + delta
  }

  switch (entry.type) {
    case 'income':
      addDelta(entry.accountId, amount)
      effect.cashIn = amount
      effect.revenue = amount
      break
    case 'expense':
      addDelta(entry.accountId, -amount)
      effect.cashOut = amount
      effect.expense = amount
      break
    case 'transfer':
      addDelta(entry.fromAccountId, -amount)
      addDelta(entry.toAccountId, amount)
      break
    case 'partner_capital':
      addDelta(entry.accountId, amount)
      effect.cashIn = amount
      effect.equity = amount
      break
    case 'partner_withdrawal':
      addDelta(entry.accountId, -amount)
      effect.cashOut = amount
      effect.equity = -amount
      break
    case 'reinvestment':
      effect.equity = amount
      break
  }

  return effect
}

export interface LedgerSummary {
  revenue: number
  expense: number
  netProfit: number
  cashIn: number
  cashOut: number
  netCashFlow: number
  capital: number
  withdrawals: number
  reinvestment: number
  equity: number
  count: number
  byType: Record<LedgerEntryType, { count: number; amount: number }>
}

const emptyByType = (): LedgerSummary['byType'] =>
  Object.fromEntries(LEDGER_ENTRY_TYPES.map((type) => [type, { count: 0, amount: 0 }])) as LedgerSummary['byType']

/**
 * Aggregate a set of entries.
 *
 * `netProfit` is the operating (cash-basis) figure `revenue - expense`. SPEC §5
 * defines a gross-profit formula that additionally subtracts COGS derived from
 * inventory; that belongs to the inventory/sales modules. This figure is
 * deliberately named operating profit so the two are never confused.
 */
export function summarize(entries: LedgerEntryLike[]): LedgerSummary {
  const byType = emptyByType()

  let revenue = 0
  let expense = 0
  let cashIn = 0
  let cashOut = 0
  let capital = 0
  let withdrawals = 0
  let reinvestment = 0
  let equity = 0

  for (const entry of entries) {
    const effect = transactionEffect(entry)

    revenue += effect.revenue
    expense += effect.expense
    cashIn += effect.cashIn
    cashOut += effect.cashOut
    equity += effect.equity

    if (entry.type === 'partner_capital') capital += effect.equity
    if (entry.type === 'partner_withdrawal') withdrawals += -effect.equity
    if (entry.type === 'reinvestment') reinvestment += effect.equity

    const bucket = byType[entry.type]
    if (bucket) {
      bucket.count += 1
      bucket.amount += effect.cashIn - effect.cashOut
    }
  }

  return {
    revenue,
    expense,
    netProfit: revenue - expense,
    cashIn,
    cashOut,
    netCashFlow: cashIn - cashOut,
    capital,
    withdrawals,
    reinvestment,
    equity,
    count: entries.length,
    byType,
  }
}

export interface AccountLike {
  _id: string
  openingBalance: number
  isActive?: boolean
}

/**
 * Opening balance plus every signed effect, per account.
 *
 * A reversed transfer contributes `-amount` to the destination and `+amount`
 * to the source, so balances return to exactly their pre-transfer values.
 */
export function computeAccountBalances(
  accounts: AccountLike[],
  entries: LedgerEntryLike[]
): Record<string, number> {
  const balances: Record<string, number> = {}
  for (const account of accounts) balances[account._id] = toInt(account.openingBalance)

  for (const entry of entries) {
    const effect = transactionEffect(entry)
    for (const [accountId, delta] of Object.entries(effect.accountDeltas)) {
      if (balances[accountId] === undefined) balances[accountId] = 0
      balances[accountId] += delta
    }
  }

  return balances
}

/* -------------------------------------------------------------------------- */
/* Asia/Karachi calendar boundaries                                            */
/* -------------------------------------------------------------------------- */

/**
 * Pakistan has used a fixed UTC+5 offset since 2009 with no DST, so the offset
 * can be applied as a constant. If Pakistan ever reintroduces DST this must
 * become an `Intl`-resolved offset; the unit tests pin the current behaviour.
 */
export const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export interface DateRange {
  start: Date
  end: Date
}

export interface KarachiCivil {
  year: number
  /** 1-12. */
  month: number
  /** 1-31. */
  day: number
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number
}

/** The Karachi civil calendar date that a UTC instant falls on. */
export function karachiCivil(date: Date): KarachiCivil {
  const shifted = new Date(date.getTime() + KARACHI_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    dayOfWeek: shifted.getUTCDay(),
  }
}

/** The UTC instant of a Karachi civil midnight. */
export function karachiMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - KARACHI_OFFSET_MS)
}

const endOfDay = (start: Date): Date => new Date(start.getTime() + DAY_MS - 1)

export function karachiDayRange(date: Date): DateRange {
  const { year, month, day } = karachiCivil(date)
  const start = karachiMidnight(year, month, day)
  return { start, end: endOfDay(start) }
}

export function karachiWeekRange(date: Date): DateRange {
  const { year, month, day, dayOfWeek } = karachiCivil(date)
  const daysSinceMonday = (dayOfWeek + 6) % 7
  const mondayCivilUtc = Date.UTC(year, month - 1, day) - daysSinceMonday * DAY_MS
  const start = new Date(mondayCivilUtc - KARACHI_OFFSET_MS)
  return { start, end: new Date(start.getTime() + 7 * DAY_MS - 1) }
}

export function karachiMonthRange(date: Date): DateRange {
  const { year, month } = karachiCivil(date)
  const start = karachiMidnight(year, month, 1)
  const nextMonthStart = karachiMidnight(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1)
  return { start, end: new Date(nextMonthStart.getTime() - 1) }
}

/** Parse a `YYYY-MM-DD` value as a Karachi day range. */
export function karachiDateInputRange(value: string): DateRange | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const start = karachiMidnight(year, month, day)
  return { start, end: endOfDay(start) }
}

export const isWithin = (date: Date, range: DateRange): boolean =>
  date.getTime() >= range.start.getTime() && date.getTime() <= range.end.getTime()

/** Inclusive count of Karachi calendar days touched by a range. */
export function karachiDayCount(range: DateRange): number {
  const startMidnight = karachiDayRange(range.start).start.getTime()
  const endMidnight = karachiDayRange(range.end).start.getTime()
  return Math.round((endMidnight - startMidnight) / DAY_MS) + 1
}

export interface PeriodTotal {
  start: Date
  end: Date
  summary: LedgerSummary
}

export interface PeriodTotals {
  day: PeriodTotal
  week: PeriodTotal
  month: PeriodTotal
}

const summarizeRange = (entries: LedgerEntryLike[], range: DateRange): PeriodTotal => ({
  start: range.start,
  end: range.end,
  summary: summarize(
    entries.filter((entry) => isWithin(new Date(entry.date), range))
  ),
})

/** Day / week / month totals for the Karachi period containing `now`. */
export function periodTotals(entries: LedgerEntryLike[], now: Date = new Date()): PeriodTotals {
  return {
    day: summarizeRange(entries, karachiDayRange(now)),
    week: summarizeRange(entries, karachiWeekRange(now)),
    month: summarizeRange(entries, karachiMonthRange(now)),
  }
}

export interface LedgerAverages {
  /** Average net cash flow per Karachi day across the range (paisa). */
  perDay: number
  /** Average net cash flow per 7-day week. */
  perWeek: number
  /** Average net cash flow per 30-day month. */
  perMonth: number
  /** Mean signed value of a single entry. */
  perEntry: number
}

/**
 * Averages over an explicit range. `perWeek`/`perMonth` are scaled from the
 * daily average using the documented 7- and 30-day conventions, which keeps the
 * arithmetic integer-exact once rounded.
 */
export function computeAverages(entries: LedgerEntryLike[], range: DateRange): LedgerAverages {
  const summary = summarize(entries.filter((entry) => isWithin(new Date(entry.date), range)))
  const days = Math.max(1, karachiDayCount(range))
  const perDay = Math.round(summary.netCashFlow / days)
  return {
    perDay,
    perWeek: Math.round((summary.netCashFlow / days) * 7),
    perMonth: Math.round((summary.netCashFlow / days) * 30),
    perEntry: summary.count > 0 ? Math.round((summary.revenue + summary.expense) / summary.count) : 0,
  }
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

const escapeCsv = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export interface CsvColumn<T> {
  key: string
  label: string
  value: (row: T) => unknown
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((column) => escapeCsv(column.label)).join(',')
  const body = rows.map((row) =>
    columns.map((column) => escapeCsv(column.value(row))).join(',')
  )
  return [header, ...body].join('\r\n')
}

/** True when the value is one of the known ledger entry types. */
export const isLedgerEntryType = (value: string): value is LedgerEntryType =>
  (LEDGER_ENTRY_TYPES as string[]).includes(value)
