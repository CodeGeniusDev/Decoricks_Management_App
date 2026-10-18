'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { PageTransition } from '@/components/PageTransition';
import { PageHeader } from '@/components/layout/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Table } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { ExportLink } from '@/components/ui/ExportLink';
import { Toast } from '@/components/ui/Toast';
import { apiJson } from '@/lib/api-client';
import { useAuth } from '@/components/auth/AuthProvider';
import { can } from '@/lib/permissions-client';
import { ENTRY_TYPE_LABELS } from '@/lib/finance';
import type { LedgerEntryType } from '@/lib/finance';
import { formatKarachiDate } from '@/lib/date';
import { formatPaisa } from '@/lib/money';
import { EntryFormModal } from '@/modules/finance/EntryFormModal';
import { ReverseModal } from '@/modules/finance/ReverseModal';
import {
  TYPE_BADGE_VARIANT,
  type AccountView,
  type CategoryView,
  type EntryView,
  type OverviewView,
  type PartnerView,
  type TransactionsView,
} from '@/modules/finance/finance-ui';

const LIMIT = 25;

const EMPTY_FILTERS = {
  type: 'all',
  accountId: '',
  category: '',
  partnerId: '',
  search: '',
  startDate: '',
  endDate: '',
};

type Filters = typeof EMPTY_FILTERS;

const buildQuery = (filters: Filters, page: number): string => {
  const params = new URLSearchParams();
  if (filters.type && filters.type !== 'all') params.set('type', filters.type);
  if (filters.accountId) params.set('accountId', filters.accountId);
  if (filters.category) params.set('category', filters.category);
  if (filters.partnerId) params.set('partnerId', filters.partnerId);
  if (filters.search.trim()) params.set('search', filters.search.trim());
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  params.set('page', String(page));
  params.set('limit', String(LIMIT));
  return params.toString();
};

/** Filters minus pagination — used verbatim for the CSV export link. */
const buildFilterQuery = (filters: Filters): string => {
  const params = new URLSearchParams();
  if (filters.type && filters.type !== 'all') params.set('type', filters.type);
  if (filters.accountId) params.set('accountId', filters.accountId);
  if (filters.category) params.set('category', filters.category);
  if (filters.partnerId) params.set('partnerId', filters.partnerId);
  if (filters.search.trim()) params.set('search', filters.search.trim());
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  return params.toString();
};

const entryAccountLabel = (entry: EntryView): string =>
  entry.type === 'transfer'
    ? `${entry.fromAccountName ?? '?'} → ${entry.toAccountName ?? '?'}`
    : (entry.accountName ?? '—');

/**
 * Colour by economic direction, not the raw string. `amountDisplay` already
 * carries a minus for reversals (serializeEntry negates the stored paisa), so a
 * reversed income renders as a negative, muted figure rather than "green".
 */
const amountTone = (entry: EntryView): string => {
  if (entry.isReversal) return 'font-medium text-ink-muted';
  if (entry.type === 'expense' || entry.type === 'partner_withdrawal') {
    return 'font-medium text-status-danger';
  }
  return 'font-medium text-decoricks-dark';
};

const statusBadge = (entry: EntryView) =>
  entry.isReversal ? (
    <Badge variant="warning" size="sm">
      Reversal
    </Badge>
  ) : entry.status === 'reversed' ? (
    <Badge variant="default" size="sm">
      Reversed
    </Badge>
  ) : (
    <Badge variant="success" size="sm">
      Posted
    </Badge>
  );

export default function FinanceTransactionsPage() {
  const { user } = useAuth();
  const canCreate = user ? can({ role: user.role }, 'finance', 'create') : false;
  const canApprove = user ? can({ role: user.role }, 'finance', 'approve') : false;

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  const [data, setData] = useState<TransactionsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [partners, setPartners] = useState<PartnerView[]>([]);
  const [withdrawalsLocked, setWithdrawalsLocked] = useState(false);
  const [lockedUntilDisplay, setLockedUntilDisplay] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  // "Edit & resubmit" handoff from the Sync screen (§7): payload staged in
  // sessionStorage by the queue, consumed exactly once on mount.
  const [resubmitDraft, setResubmitDraft] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('decoricks:offline:resubmit');
      if (!raw) return;
      sessionStorage.removeItem('decoricks:offline:resubmit');
      const staged = JSON.parse(raw) as { operation?: string; payload?: Record<string, unknown> };
      if (staged.operation === 'create_finance' && staged.payload) {
        setResubmitDraft(staged.payload);
        setFormOpen(true);
      }
    } catch {
      // A corrupt handoff is simply no handoff.
    }
  }, []);
  const [reverseTarget, setReverseTarget] = useState<EntryView | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Guards against out-of-order responses: every fetch takes a sequence number
  // and only the newest one may write state. This is what stops stale data from
  // flashing back in when two filters land close together.
  const requestSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const setFilter = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  };

  const fetchTransactions = useCallback(async (currentFilters: Filters, currentPage: number) => {
    const seq = ++requestSeq.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await apiJson<TransactionsView>(
        `/api/finance/transactions?${buildQuery(currentFilters, currentPage)}`,
        { signal: controller.signal }
      );
      if (seq === requestSeq.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : 'Failed to load transactions');
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  // Debounced search, immediate for the other controls. `reloadTick` re-fires
  // this effect after a write without touching the filter state.
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => fetchTransactions(filters, page), filters.search ? 350 : 0);
    return () => clearTimeout(timer);
  }, [filters, page, reloadTick, fetchTransactions]);

  // Reference data for the selectors and lock state; loaded once per mount.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [accountData, categoryData, partnerData, overviewData] = await Promise.all([
          apiJson<{ accounts: AccountView[] }>('/api/finance/accounts'),
          apiJson<CategoryView[]>('/api/finance/categories'),
          apiJson<PartnerView[]>('/api/finance/partners'),
          apiJson<OverviewView>('/api/finance/overview'),
        ]);
        if (cancelled) return;
        setAccounts(accountData.accounts);
        setCategories(categoryData);
        setPartners(partnerData);
        setWithdrawalsLocked(overviewData.withdrawalsLocked);
        setLockedUntilDisplay(
          overviewData.withdrawalLockedUntil
            ? formatKarachiDate(new Date(overviewData.withdrawalLockedUntil), 'date')
            : null
        );
      } catch {
        // Reference data is not fatal; the entry form will surface server errors.
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Deep links: ?new=1 opens the entry form (from the overview), and the
  // Phase 4 calculation panels pre-fill the filters (?type=&category=&
  // startDate=&endDate=…) so every "verify against the ledger" link lands on
  // exactly the records behind its figure. Read straight off the location (not
  // useSearchParams) so the page needs no Suspense boundary; the URL is then
  // cleaned so a reload doesn't re-apply a stale ?new=1.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const openForm = params.get('new') === '1' && canCreate;
    const patch: Partial<Filters> = {};
    for (const key of ['type', 'accountId', 'category', 'partnerId', 'search', 'startDate', 'endDate'] as const) {
      const value = params.get(key);
      if (value) patch[key] = value;
    }
    if (!openForm && Object.keys(patch).length === 0) return;
    if (openForm) setFormOpen(true);
    if (Object.keys(patch).length > 0) {
      setFilters((current) => ({ ...current, ...patch }));
      setPage(1);
    }
    window.history.replaceState(null, '', '/finance/transactions');
  }, [canCreate]);

  const typeOptions = useMemo(
    () => [
      { value: 'all', label: 'All types' },
      ...(Object.keys(ENTRY_TYPE_LABELS) as LedgerEntryType[]).map((t) => ({
        value: t,
        label: ENTRY_TYPE_LABELS[t],
      })),
    ],
    []
  );

  const handleCreated = (entry: EntryView) => {
    setToast({
      type: 'success',
      message: `${ENTRY_TYPE_LABELS[entry.type]} of ${entry.amountDisplay} recorded`,
    });
    setPage(1);
    setReloadTick((t) => t + 1);
  };

  const handleReversed = () => {
    setToast({
      type: 'success',
      message: 'Reversal posted. The original stays visible, marked Reversed.',
    });
    setReloadTick((t) => t + 1);
  };

  const exportHref = `/api/finance/export?${buildFilterQuery(filters)}`;

  const columns = [
    { key: 'date', label: 'Date' },
    { key: 'type', label: 'Type' },
    { key: 'amount', label: 'Amount' },
    { key: 'account', label: 'Account' },
    { key: 'category', label: 'Category' },
    { key: 'partner', label: 'Partner' },
    { key: 'note', label: 'Note' },
    { key: 'status', label: 'Status' },
    ...(canApprove ? [{ key: 'actions', label: 'Actions' }] : []),
  ];

  const rows = (data?.items ?? []).map((entry) => ({
    _id: entry._id,
    date: formatKarachiDate(new Date(entry.date), 'date'),
    type: (
      <Badge variant={TYPE_BADGE_VARIANT[entry.type]} size="sm">
        {ENTRY_TYPE_LABELS[entry.type]}
      </Badge>
    ),
    amount: <span className={amountTone(entry)}>{entry.amountDisplay}</span>,
    account: entryAccountLabel(entry),
    category: entry.categoryLabel ?? '—',
    partner: entry.partnerName ?? '—',
    note: <span className="block max-w-[220px] truncate text-ink-muted">{entry.note ?? ''}</span>,
    status: statusBadge(entry),
    actions:
      canApprove && !entry.isReversal && entry.status === 'posted' ? (
        <Button variant="ghost" size="sm" onClick={() => setReverseTarget(entry)}>
          Reverse
        </Button>
      ) : null,
  }));

  return (
    <PageTransition>
      <PageHeader
        title="Transactions"
        description="The full ledger — every entry is permanent; mistakes are corrected with linked reversals."
        actions={
          <>
            <ExportLink href={exportHref} />
            {canCreate && <Button onClick={() => setFormOpen(true)}>New transaction</Button>}
          </>
        }
      />

      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      {/* Filters */}
      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            label="Search"
            placeholder="Note, category, partner…"
            value={filters.search}
            onChange={(e) => setFilter({ search: e.target.value })}
          />
          <Select
            label="Type"
            value={filters.type}
            onChange={(e) => setFilter({ type: e.target.value })}
            options={typeOptions}
          />
          <Select
            label="Account"
            value={filters.accountId}
            onChange={(e) => setFilter({ accountId: e.target.value })}
            options={[
              { value: '', label: 'All accounts' },
              ...accounts.map((a) => ({ value: a._id, label: a.name })),
            ]}
          />
          <Select
            label="Category"
            value={filters.category}
            onChange={(e) => setFilter({ category: e.target.value })}
            options={[
              { value: '', label: 'All categories' },
              ...categories.map((c) => ({ value: c.name, label: c.label })),
            ]}
          />
          <Select
            label="Partner"
            value={filters.partnerId}
            onChange={(e) => setFilter({ partnerId: e.target.value })}
            options={[
              { value: '', label: 'All partners' },
              ...partners.map((p) => ({ value: p._id, label: p.name })),
            ]}
          />
          <Input
            label="From (Karachi date)"
            type="date"
            value={filters.startDate}
            onChange={(e) => setFilter({ startDate: e.target.value })}
          />
          <Input
            label="To (Karachi date)"
            type="date"
            value={filters.endDate}
            onChange={(e) => setFilter({ endDate: e.target.value })}
          />
          <div className="flex items-end">
            <Button
              variant="outline"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setPage(1);
              }}
            >
              Clear filters
            </Button>
          </div>
        </div>
      </Card>

      {/* Totals for the current filter */}
      {data && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Card className="p-4">
            <p className="text-xs text-ink-muted">Income (filtered)</p>
            <p className="mt-1 text-lg font-semibold text-status-success">
              {formatPaisa(data.summary.revenue)}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-ink-muted">Expenses (filtered)</p>
            <p className="mt-1 text-lg font-semibold text-status-danger">
              {formatPaisa(data.summary.expense)}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-ink-muted">Net cash flow</p>
            <p className="mt-1 text-lg font-semibold text-decoricks-dark">
              {formatPaisa(data.summary.netCashFlow)}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-ink-muted">Avg / day (net)</p>
            <p className="mt-1 text-lg font-semibold text-decoricks-dark">
              {formatPaisa(data.averages.perDay)}
            </p>
          </Card>
        </div>
      )}

      {/* List */}
      <Card>
        {loading ? (
          <div className="p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} variant="rect" className="mb-2 h-12" />
            ))}
          </div>
        ) : error ? (
          <ErrorState
            title="Could not load transactions"
            description={error}
            action={{
              label: 'Retry',
              onClick: () => {
                setLoading(true);
                void fetchTransactions({ ...filters }, page);
              },
            }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No transactions found"
            description={
              filters.search ||
              filters.type !== 'all' ||
              filters.accountId ||
              filters.category ||
              filters.partnerId ||
              filters.startDate ||
              filters.endDate
                ? 'Nothing matches the current filters.'
                : 'Post your first income or expense to get the ledger going.'
            }
            action={
              canCreate ? { label: 'New transaction', onClick: () => setFormOpen(true) } : undefined
            }
          />
        ) : (
          <>
            {/* Desktop: table. Mobile: cards. */}
            <div className="hidden md:block">
              <Table
                caption="Ledger transactions"
                columns={columns}
                data={rows}
                rowKey="_id"
                pagination={{
                  currentPage: data?.pagination.page ?? 1,
                  totalPages: data?.pagination.totalPages ?? 1,
                  onPageChange: setPage,
                }}
              />
            </div>
            <ul className="divide-y divide-line-subtle md:hidden">
              {(data?.items ?? []).map((entry) => (
                <li key={entry._id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Badge variant={TYPE_BADGE_VARIANT[entry.type]} size="sm">
                        {ENTRY_TYPE_LABELS[entry.type]}
                      </Badge>
                      <p className="mt-1 truncate text-sm font-medium text-decoricks-dark">
                        {entry.categoryLabel ??
                          entry.note ??
                          entry.partnerName ??
                          ENTRY_TYPE_LABELS[entry.type]}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {formatKarachiDate(new Date(entry.date), 'date')} ·{' '}
                        {entryAccountLabel(entry)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p
                        className={`text-sm font-semibold ${
                          entry.isReversal ? 'text-ink-muted' : 'text-decoricks-dark'
                        }`}
                      >
                        {entry.amountDisplay}
                      </p>
                      <div className="mt-1">{statusBadge(entry)}</div>
                    </div>
                  </div>
                  {entry.note && (
                    <p className="mt-1 truncate text-xs text-ink-muted">{entry.note}</p>
                  )}
                  {canApprove && !entry.isReversal && entry.status === 'posted' && (
                    <div className="mt-2">
                      <Button variant="ghost" size="sm" onClick={() => setReverseTarget(entry)}>
                        Reverse
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-3 px-4 py-3 md:hidden">
              <p className="text-xs text-ink-muted">
                Page {data?.pagination.page ?? 1} of {data?.pagination.totalPages ?? 1} ·{' '}
                {data?.pagination.total ?? 0} entries
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(data?.pagination.page ?? 1) <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(data?.pagination.page ?? 1) >= (data?.pagination.totalPages ?? 1)}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
            <p className="hidden px-4 pb-3 pt-1 text-xs text-ink-muted md:block">
              {data?.pagination.total ?? 0} matching entries
            </p>
          </>
        )}
      </Card>

      <div className="mt-4 flex gap-2 text-sm">
        <Link href="/finance" className="text-decoricks-brown hover:underline">
          ← Finance overview
        </Link>
        <span className="text-ink-muted">·</span>
        <Link href="/finance/accounts" className="text-decoricks-brown hover:underline">
          Accounts
        </Link>
        <span className="text-ink-muted">·</span>
        <Link href="/finance/categories" className="text-decoricks-brown hover:underline">
          Categories
        </Link>
      </div>

      <EntryFormModal
        isOpen={formOpen}
        onClose={() => {
          setFormOpen(false);
          setResubmitDraft(null);
        }}
        initialDraft={resubmitDraft}
        accounts={accounts}
        categories={categories}
        partners={partners}
        canApprove={canApprove}
        withdrawalsLocked={withdrawalsLocked}
        lockedUntilDisplay={lockedUntilDisplay}
        onCreated={handleCreated}
        onQueued={() =>
          setToast({
            type: 'success',
            message: 'Saved offline — view and manage it in your Sync queue.',
          })
        }
      />

      <ReverseModal
        entry={reverseTarget}
        onClose={() => setReverseTarget(null)}
        onReversed={handleReversed}
      />
    </PageTransition>
  );
}
