'use client';

import type { LedgerAverages, LedgerEntryType, LedgerSummary } from '@/lib/finance';
import { isValidPkr, paisaToPkr, pkrToPaisa } from '@/lib/money';
import { karachiCivil } from '@/lib/finance';

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

/** Today as `YYYY-MM-DD` on the Karachi civil calendar. */
export const karachiToday = (): string => {
  const { year, month, day } = karachiCivil(new Date());
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/** ISO instant -> `YYYY-MM-DD` on the Karachi civil calendar (for date inputs). */
export const toKarachiInputDate = (iso: string): string => {
  const { year, month, day } = karachiCivil(new Date(iso));
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/**
 * A fresh idempotency key per form session. `crypto.randomUUID` exists in every
 * browser we target; the fallback keeps the form usable if it ever doesn't.
 */
export const newIdempotencyKey = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
};

/**
 * Parse a PKR amount typed by a human into integer paisa. Rejects anything
 * with more than two decimals so a float never sneaks into the ledger.
 */
export const parsePkrAmount = (
  raw: string
): { ok: true; paisa: number } | { ok: false; error: string } => {
  const trimmed = raw.trim().replace(/,/g, '');
  if (!trimmed) return { ok: false, error: 'Amount is required' };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { ok: false, error: 'Enter a positive amount with at most 2 decimals' };
  }
  const pkr = Number(trimmed);
  if (!Number.isFinite(pkr) || !isValidPkr(pkr)) {
    return { ok: false, error: 'Enter a valid amount' };
  }
  return { ok: true, paisa: pkrToPaisa(pkr) };
};

/** Paisa rendered into a text input the user can edit (no locale noise). */
export const paisaToInputValue = (paisa: number): string => paisaToPkr(paisa).toFixed(2);

/** Flatten the server's `details` array into `field -> message` for inputs. */
export const fieldIssues = (details: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (Array.isArray(details)) {
    for (const item of details) {
      if (item && typeof item === 'object' && 'path' in item && 'message' in item) {
        const entry = item as { path: string; message: string };
        if (typeof entry.path === 'string' && typeof entry.message === 'string') {
          out[entry.path] = entry.message;
        }
      }
    }
  }
  return out;
};

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
