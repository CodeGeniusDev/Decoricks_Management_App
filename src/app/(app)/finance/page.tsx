'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageTransition } from '@/components/PageTransition';
import { PageHeader, Metric, MetricGrid } from '@/components/layout/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Toast } from '@/components/ui/Toast';
import { apiJson, ApiError } from '@/lib/api-client';
import { useAuth } from '@/components/auth/AuthProvider';
import { can } from '@/lib/permissions-client';
import { ENTRY_TYPE_LABELS } from '@/lib/finance';
import { formatKarachiDate } from '@/lib/date';
import { formatPaisa } from '@/lib/money';
import { ReverseModal } from '@/modules/finance/ReverseModal';
import {
  TYPE_BADGE_VARIANT,
  toKarachiInputDate,
  type OverviewView,
} from '@/modules/finance/finance-ui';

const entryAccountLabel = (entry: OverviewView['recentTransactions'][number]): string =>
  entry.type === 'transfer'
    ? `${entry.fromAccountName ?? '?'} → ${entry.toAccountName ?? '?'}`
    : (entry.accountName ?? '—');

/**
 * Finance overview — the front door of the Phase 3 ledger.
 *
 * Cash position, Karachi day/week/month figures, lifetime operating results
 * kept apart from cash flow (SPEC §5: transfers and equity movements are not
 * profit), account balances, the withdrawal lock control and the newest
 * entries. Everything is one `/api/finance/overview` read.
 */
export default function FinanceOverviewPage() {
  const router = useRouter();
  const { user } = useAuth();
  const canCreate = user ? can({ role: user.role }, 'finance', 'create') : false;
  const canApprove = user ? can({ role: user.role }, 'finance', 'approve') : false;

  const [data, setData] = useState<OverviewView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [reverseTarget, setReverseTarget] = useState<
    OverviewView['recentTransactions'][number] | null
  >(null);

  // Withdrawal lock editor (Founder only). The draft mirrors the stored value
  // once loaded, so the date input never shows a stale or blank state and an
  // empty draft genuinely means "clear the lock".
  const [lockDraft, setLockDraft] = useState('');
  const [lockSaving, setLockSaving] = useState(false);
  const lockSubmittingRef = React.useRef(false);

  useEffect(() => {
    setLockDraft(data?.withdrawalLockedUntil ? toKarachiInputDate(data.withdrawalLockedUntil) : '');
  }, [data?.withdrawalLockedUntil]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiJson<OverviewView>('/api/finance/overview'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load finance overview');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveLock = async () => {
    if (lockSubmittingRef.current) return;
    lockSubmittingRef.current = true;
    setLockSaving(true);
    try {
      await apiJson('/api/finance/settings', {
        method: 'PATCH',
        body: JSON.stringify({ withdrawalLockedUntil: lockDraft || null }),
      });
      setToast({
        type: 'success',
        message: lockDraft ? `Withdrawals locked until ${lockDraft}` : 'Withdrawal lock cleared',
      });
      await load();
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof ApiError ? err.message : 'Could not update the withdrawal lock',
      });
    } finally {
      lockSubmittingRef.current = false;
      setLockSaving(false);
    }
  };

  const clearLock = async () => {
    if (lockSubmittingRef.current) return;
    lockSubmittingRef.current = true;
    setLockSaving(true);
    try {
      await apiJson('/api/finance/settings', {
        method: 'PATCH',
        body: JSON.stringify({ withdrawalLockedUntil: null }),
      });
      setToast({ type: 'success', message: 'Withdrawal lock cleared' });
      await load();
    } catch {
      setToast({ type: 'error', message: 'Could not clear the lock' });
    } finally {
      lockSubmittingRef.current = false;
      setLockSaving(false);
    }
  };

  if (loading) {
    return (
      <PageTransition>
        <PageHeader title="Finance" description="Ledger overview, balances and cash flow." />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} variant="rect" className="h-24" />
          ))}
        </div>
        <Skeleton variant="rect" className="mt-4 h-40" />
        <Skeleton variant="rect" className="mt-4 h-64" />
      </PageTransition>
    );
  }

  if (error || !data) {
    return (
      <PageTransition>
        <PageHeader title="Finance" />
        <Card>
          <ErrorState
            title="Could not load finance"
            description={error ?? 'Unexpected empty response.'}
            action={{ label: 'Retry', onClick: () => void load() }}
          />
        </Card>
      </PageTransition>
    );
  }

  const { overall, periods } = data;

  return (
    <PageTransition>
      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      <PageHeader
        title="Finance"
        description="Cash position, balances and the append-only ledger. Posted entries are corrected only by linked reversals."
        actions={
          <>
            <Button variant="outline" onClick={() => router.push('/finance/accounts')}>
              Accounts
            </Button>
            <Button variant="outline" onClick={() => router.push('/finance/categories')}>
              Categories
            </Button>
            {canCreate && (
              <Button onClick={() => router.push('/finance/transactions?new=1')}>
                New transaction
              </Button>
            )}
          </>
        }
      />

      {/* Cash position */}
      <MetricGrid>
        <Metric
          label="Total cash"
          value={data.totalCashDisplay}
          hint="Across all active accounts"
        />
        <Metric
          label="Today (Karachi)"
          value={periods.day.summary.netCashFlowDisplay}
          tone={periods.day.summary.netCashFlow >= 0 ? 'positive' : 'negative'}
          hint={`In ${periods.day.summary.cashInDisplay} · Out ${periods.day.summary.cashOutDisplay}`}
        />
        <Metric
          label="This week"
          value={periods.week.summary.netCashFlowDisplay}
          tone={periods.week.summary.netCashFlow >= 0 ? 'positive' : 'negative'}
          hint={`Mon–Sun, Karachi boundaries`}
        />
        <Metric
          label="This month"
          value={periods.month.summary.netCashFlowDisplay}
          tone={periods.month.summary.netCashFlow >= 0 ? 'positive' : 'negative'}
          hint={`In ${periods.month.summary.cashInDisplay} · Out ${periods.month.summary.cashOutDisplay}`}
        />
      </MetricGrid>

      {/* Operating results vs cash flow — deliberately two blocks (SPEC §5). */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-decoricks-dark">
            Lifetime operating results
          </h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-ink-muted">Revenue</dt>
              <dd className="font-semibold tabular-nums text-status-success">
                {overall.revenueDisplay}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Expenses</dt>
              <dd className="font-semibold tabular-nums text-status-danger">
                {overall.expenseDisplay}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Operating profit</dt>
              <dd className="font-semibold tabular-nums text-decoricks-dark">
                {overall.netProfitDisplay}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Net cash flow</dt>
              <dd className="font-semibold tabular-nums text-decoricks-dark">
                {overall.netCashFlowDisplay}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-ink-muted">
            Cash flow ≠ profit: capital in, withdrawals and transfers move cash without touching
            operating results.
          </p>
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-decoricks-dark">Partners & equity</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-ink-muted">Capital contributed</dt>
              <dd className="font-semibold tabular-nums text-decoricks-dark">
                {overall.capitalDisplay}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Withdrawals</dt>
              <dd className="font-semibold tabular-nums text-decoricks-dark">
                {overall.withdrawalsDisplay}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Reinvested profit</dt>
              <dd className="font-semibold tabular-nums text-decoricks-dark">
                {overall.reinvestmentDisplay}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Net equity</dt>
              <dd className="font-semibold tabular-nums text-decoricks-dark">
                {formatPaisa(overall.equity)}
              </dd>
            </div>
          </dl>
          {data.withdrawalsLocked ? (
            <p className="mt-3 rounded-md bg-status-warning-bg px-3 py-2 text-xs text-status-warning">
              Partner withdrawals are locked until{' '}
              {data.withdrawalLockedUntil
                ? formatKarachiDate(new Date(data.withdrawalLockedUntil), 'date')
                : 'an unset date'}
              .
            </p>
          ) : (
            <p className="mt-3 text-xs text-ink-muted">Partner withdrawals are open.</p>
          )}
        </Card>
      </div>

      {/* Account balances */}
      <Card className="mt-4 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-decoricks-dark">Account balances</h2>
          <Link
            href="/finance/accounts"
            className="text-xs font-medium text-decoricks-brown hover:underline"
          >
            Manage accounts →
          </Link>
        </div>
        {data.accounts.length === 0 ? (
          <EmptyState
            title="No accounts yet"
            description="Add a cash, bank or wallet account to start recording transactions."
            action={{ label: 'Add account', onClick: () => router.push('/finance/accounts') }}
          />
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.accounts.map((account) => (
              <li
                key={account._id}
                className="rounded-lg border border-line-subtle bg-surface-sunken px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-decoricks-dark">
                    {account.name}
                  </span>
                  {!account.isActive && <Badge size="sm">Inactive</Badge>}
                </div>
                <p className="mt-0.5 text-lg font-semibold tabular-nums text-decoricks-dark">
                  {account.balanceDisplay}
                </p>
                <p className="text-xs text-ink-muted">
                  {account.kindLabel} · opening {account.openingBalanceDisplay}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Withdrawal lock control (Founder only) */}
      {canApprove && (
        <Card className="mt-4 p-4">
          <h2 className="text-sm font-semibold text-decoricks-dark">Withdrawal lock</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Partner withdrawals are rejected before this Karachi date. SPEC Appendix A starts the
            business locked until 2027-02-04.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="sm:w-48">
              <Input
                label="Locked until (blank = open)"
                type="date"
                value={lockDraft}
                onChange={(e) => setLockDraft(e.target.value)}
                disabled={lockSaving}
              />
            </div>
            <Button onClick={() => void saveLock()} loading={lockSaving} disabled={lockSaving}>
              Save lock
            </Button>
            <Button
              variant="outline"
              disabled={lockSaving || !data.withdrawalLockedUntil}
              onClick={() => void clearLock()}
            >
              Clear lock
            </Button>
          </div>
        </Card>
      )}

      {/* Recent transactions */}
      <Card className="mt-4 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-decoricks-dark">Recent transactions</h2>
          <Link
            href="/finance/transactions"
            className="text-xs font-medium text-decoricks-brown hover:underline"
          >
            Full ledger →
          </Link>
        </div>
        {data.recentTransactions.length === 0 ? (
          <EmptyState
            title="Nothing in the ledger yet"
            description="Record income, expenses and transfers from the transactions screen."
            action={
              canCreate
                ? {
                    label: 'New transaction',
                    onClick: () => router.push('/finance/transactions?new=1'),
                  }
                : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-line-subtle">
            {data.recentTransactions.map((entry) => (
              <li key={entry._id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant={TYPE_BADGE_VARIANT[entry.type]} size="sm">
                    {ENTRY_TYPE_LABELS[entry.type]}
                  </Badge>
                  <span className="hidden truncate text-sm text-ink-secondary sm:block">
                    {entryAccountLabel(entry)}
                    {entry.categoryLabel ? ` · ${entry.categoryLabel}` : ''}
                    {entry.partnerName ? ` · ${entry.partnerName}` : ''}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <div className="text-right">
                    <p
                      className={`text-sm font-semibold tabular-nums ${
                        entry.isReversal
                          ? 'text-ink-muted'
                          : entry.type === 'expense' || entry.type === 'partner_withdrawal'
                            ? 'text-status-danger'
                            : 'text-decoricks-dark'
                      }`}
                    >
                      {entry.amountDisplay}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {formatKarachiDate(new Date(entry.date), 'date')}
                    </p>
                  </div>
                  {canApprove && !entry.isReversal && entry.status === 'posted' && (
                    <Button variant="ghost" size="sm" onClick={() => setReverseTarget(entry)}>
                      Reverse
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ReverseModal
        entry={reverseTarget}
        onClose={() => setReverseTarget(null)}
        onReversed={() => {
          setToast({ type: 'success', message: 'Reversal posted.' });
          void load();
        }}
      />
    </PageTransition>
  );
}
