'use client';

import type { LedgerAverages, LedgerEntryType, LedgerSummary } from '@/lib/finance';

/**
 * Client-side types and helpers for the Phase 3 finance screens.
 *
 * The API serializes dates to ISO strings and never ships ObjectIds, so these
 * interfaces mirror the JSON exactly. Arithmetic stays in integer paisa all the
 * way to the last display helper — nothing here converts through a float.
 */

export interface EntryView {
  _id: string;
  type: LedgerEntryType;
  amount: number;
  amountDisplay: string;
  date: string;
  accountId?: string;
  accountName?: string;
  fromAccountId?: string;
  fromAccountName?: string;
  toAccountId?: string;
  toAccountName?: string;
  category?: string;
  categoryLabel?: string;
  partnerId?: string;
  partnerName?: string;
  paymentMethod?: string;
  note?: string;
  isReversal: boolean;
  reversesId?: string;
  status: 'posted' | 'reversed';
  createdAt?: string;
}

export interface AccountView {
  _id: string;
  name: string;
  kind: 'cash' | 'bank' | 'wallet';
  kindLabel: string;
  openingBalance: number;
  openingBalanceDisplay: string;
  balance: number;
  balanceDisplay: string;
  isActive: boolean;
  note?: string;
}

export interface CategoryView {
  _id: string;
  name: string;
  label: string;
  type: 'expense' | 'income';
  isActive: boolean;
}

export interface PartnerView {
  _id: string;
  name: string;
  role: string;
}

/** LedgerSummary once JSON-stringified: Date fields become ISO strings. */
export interface SummaryView extends LedgerSummary {}

/** The overview adds pre-formatted `*Display` strings server-side. */
export type DisplaySummary = LedgerSummary & {
  revenueDisplay: string;
  expenseDisplay: string;
  netProfitDisplay: string;
  cashInDisplay: string;
  cashOutDisplay: string;
  netCashFlowDisplay: string;
  capitalDisplay: string;
  withdrawalsDisplay: string;
  reinvestmentDisplay: string;
};

export interface PeriodView {
  start: string;
  end: string;
  summary: DisplaySummary;
}

export interface OverviewView {
  accounts: AccountView[];
  totalCash: number;
  totalCashDisplay: string;
  overall: DisplaySummary;
  periods: { day: PeriodView; week: PeriodView; month: PeriodView };
  recentTransactions: EntryView[];
  withdrawalLockedUntil: string | null;
  withdrawalsLocked: boolean;
}

export interface TransactionsView {
  items: EntryView[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  summary: SummaryView;
  averages: LedgerAverages;
  periods: {
    day: { start: string; end: string; summary: SummaryView };
    week: { start: string; end: string; summary: SummaryView };
    month: { start: string; end: string; summary: SummaryView };
  };
  range: { start: string; end: string };
}

export interface SettingsView {
  withdrawalLockedUntil: string | null;
  withdrawalLockedUntilDisplay: string | null;
  withdrawalsLocked: boolean;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * The generic form helpers moved to `@/lib/form-helpers` when Phase 5 gave the
 * inventory and sales screens the same money/date/idempotency needs. They are
 * re-exported here so every existing Finance import keeps working — one
 * implementation, so a paisa parser cannot drift between modules.
 */
export {
  karachiToday,
  toKarachiInputDate,
  newIdempotencyKey,
  parsePkrAmount,
  paisaToInputValue,
  fieldIssues,
} from '@/lib/form-helpers';

export const TYPE_BADGE_VARIANT: Record<
  LedgerEntryType,
  'default' | 'success' | 'error' | 'warning'
> = {
  income: 'success',
  expense: 'error',
  transfer: 'default',
  partner_capital: 'success',
  partner_withdrawal: 'warning',
  reinvestment: 'default',
};

/** Payment methods offered in the entry form; the API accepts any short string. */
export const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'jazzcash', label: 'JazzCash' },
  { value: 'easypaisa', label: 'EasyPaisa' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'card', label: 'Card' },
  { value: 'other', label: 'Other' },
];
