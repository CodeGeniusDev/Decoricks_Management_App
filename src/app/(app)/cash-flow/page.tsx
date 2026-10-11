'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PageTransition } from '@/components/PageTransition';
import { PageHeader, Metric, MetricGrid } from '@/components/layout/Page';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { CalcPanel } from '@/components/ui/CalcPanel';
import {
  PeriodFilter,
  periodFilterQuery,
  periodFilterReady,
  EMPTY_PERIOD_FILTER,
  type PeriodFilterValue,
} from '@/components/reports/PeriodFilter';
import { apiJson } from '@/lib/api-client';
import { formatPaisa } from '@/lib/money';
import { formatKarachiDate } from '@/lib/date';
import { toKarachiInputDate } from '@/modules/finance/finance-ui';

/**
 * Cash Flow — deliberately separate from accounting profit (Phase 4 brief
 * item 4).
 *
 * Cash in, cash out and balances per account over inclusive Karachi ranges,
 * including partner capital and withdrawals (equity events that never touch
 * the P&L). Transfers move cash between accounts but are excluded from
 * business-level flows, so the totals are provably transfer-neutral — the
 * calculation panel says exactly that and links to the records.
 */

interface CashFlowAccountLine {
  accountId: string;
  name: string;
  kind: string;
  balanceStart: number;
  cashIn: number;
  cashOut: number;
  balanceEnd: number;
}

interface CashFlowView {
  cashIn: number;
  cashOut: number;
  netCashFlow: number;
  revenueIn: number;
  operatingOut: number;
  capitalIn: number;
  withdrawalsOut: number;
  transferCount: number;
  accounts: CashFlowAccountLine[];
  totalBalanceStart: number;
  totalBalanceEnd: number;
  count: number;
}

interface CashFlowResponse {
  period: string;
  range: { start: string; end: string };
  cashFlow: CashFlowView;
  formulas: {
    netCashFlow: string;
    cashIn: string;
    cashOut: string;
    balanceEnd: string;
  };
}

const KIND_LABEL: Record<string, string> = {
  cash: 'Cash',
  bank: 'Bank',
  wallet: 'Wallet / mobile account',
};

export default function CashFlowPage() {
  const [filter, setFilter] = useState<PeriodFilterValue>(EMPTY_PERIOD_FILTER);
  const [data, setData] = useState<CashFlowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!periodFilterReady(filter)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await apiJson<CashFlowResponse>(`/api/finance/cash-flow?${periodFilterQuery(filter)}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cash flow');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const body = () => {
    if (loading) {
      return (
        <>
          <Skeleton variant="rect" className="h-24" />
          <Skeleton variant="rect" className="mt-4 h-64" />
        </>
      );
    }
    if (error) {
      return (
        <Card>
          <ErrorState
            title="Could not load cash flow"
            description={error}
            action={{ label: 'Retry', onClick: () => void load() }}
          />
        </Card>
      );
    }
    if (!data) {
      return (
        <Card>
          <EmptyState
            title="Pick a complete custom range"
            description="A custom period needs both a start and an end date (Karachi calendar)."
          />
        </Card>
      );
    }

    const cf = data.cashFlow;
    const rangeParams = {
      startDate: toKarachiInputDate(data.range.start),
      endDate: toKarachiInputDate(data.range.end),
    };
    const allLedgerHref = `/finance/transactions?${new URLSearchParams(rangeParams).toString()}`;
    const rangeLabel = `${formatKarachiDate(new Date(data.range.start), 'date')} – ${formatKarachiDate(
      new Date(data.range.end),
      'date'
    )} (Karachi)`;

    return (
      <>
        <MetricGrid>
          <Metric label="Cash in" value={formatPaisa(cf.cashIn)} hint={`In ${rangeLabel}`} />
          <Metric label="Cash out" value={formatPaisa(cf.cashOut)} />
          <Metric
            label="Net cash flow"
            value={formatPaisa(cf.netCashFlow)}
            tone={cf.netCashFlow < 0 ? 'negative' : 'positive'}
          />
          <Metric
            label="Closing balance"
            value={formatPaisa(cf.totalBalanceEnd)}
            hint={`Opening ${formatPaisa(cf.totalBalanceStart)}`}
          />
        </MetricGrid>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-decoricks-dark">What moved the cash</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-secondary">Income receipts</dt>
                <dd className="font-semibold tabular-nums text-status-success">{formatPaisa(cf.revenueIn)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-secondary">Partner capital contributed</dt>
                <dd className="font-semibold tabular-nums text-status-success">{formatPaisa(cf.capitalIn)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2 border-t border-line-subtle pt-2">
                <dt className="font-semibold text-decoricks-dark">Cash in</dt>
                <dd className="font-semibold tabular-nums text-decoricks-dark">{formatPaisa(cf.cashIn)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2 pt-1">
                <dt className="text-ink-secondary">Expenses paid</dt>
                <dd className="font-semibold tabular-nums text-status-danger">− {formatPaisa(cf.operatingOut)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-secondary">Partner withdrawals</dt>
                <dd className="font-semibold tabular-nums text-status-danger">− {formatPaisa(cf.withdrawalsOut)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2 border-t border-line-subtle pt-2">
                <dt className="font-semibold text-decoricks-dark">Cash out</dt>
                <dd className="font-semibold tabular-nums text-decoricks-dark">{formatPaisa(cf.cashOut)}</dd>
              </div>
            </dl>
            <p className="mt-3 rounded-md bg-surface-sunken px-3 py-2 text-xs text-ink-secondary">
              {cf.transferCount === 0
                ? 'No account-to-account transfers in this period.'
                : `${cf.transferCount} transfer${cf.transferCount === 1 ? '' : 's'} moved cash between accounts in this period — excluded from the totals above, since a transfer cannot create or destroy cash.`}
            </p>
            <CalcPanel
              className="mt-3"
              label="Net cash flow"
              formula={data.formulas.netCashFlow}
              inputs={[
                { label: 'Cash in', value: formatPaisa(cf.cashIn) },
                { label: 'Cash out', value: formatPaisa(cf.cashOut) },
                { label: 'Net', value: formatPaisa(cf.netCashFlow) },
                { label: 'Entries in range', value: String(cf.count) },
              ]}
              link={{ href: allLedgerHref, label: 'Open all records in this range' }}
              note={`${data.formulas.cashIn}. ${data.formulas.cashOut}.`}
            />
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-decoricks-dark">Balance by account</h2>
              <Link href="/finance/accounts" className="text-xs font-medium text-decoricks-brown hover:underline">
                Manage accounts →
              </Link>
            </div>
            {cf.accounts.length === 0 ? (
              <EmptyState
                title="No active accounts"
                description="Add a cash, bank or wallet account to see balances here."
              />
            ) : (
              <>
                {/* Desktop table */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">Cash movement and balances per account</caption>
                    <thead>
                      <tr className="border-b border-line-strong text-2xs uppercase tracking-wide text-ink-muted">
                        <th scope="col" className="py-2 pr-2 font-semibold">Account</th>
                        <th scope="col" className="py-2 px-2 text-right font-semibold">Opening</th>
                        <th scope="col" className="py-2 px-2 text-right font-semibold">In</th>
                        <th scope="col" className="py-2 px-2 text-right font-semibold">Out</th>
                        <th scope="col" className="py-2 pl-2 text-right font-semibold">Closing</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cf.accounts.map((account) => (
                        <tr key={account.accountId} className="border-b border-line-subtle">
                          <th scope="row" className="py-2 pr-2 text-left font-medium text-decoricks-dark">
                            {account.name}
                            <span className="block text-2xs font-normal text-ink-muted">
                              {KIND_LABEL[account.kind] ?? account.kind}
                            </span>
                          </th>
                          <td className="py-2 px-2 text-right tabular-nums">{formatPaisa(account.balanceStart)}</td>
                          <td className="py-2 px-2 text-right tabular-nums text-status-success">
                            {formatPaisa(account.cashIn)}
                          </td>
                          <td className="py-2 px-2 text-right tabular-nums text-status-danger">
                            {formatPaisa(account.cashOut)}
                          </td>
                          <td className="py-2 pl-2 text-right font-semibold tabular-nums text-decoricks-dark">
                            {formatPaisa(account.balanceEnd)}
                          </td>
                        </tr>
                      ))}
                      <tr className="border-t-2 border-line-strong">
                        <th scope="row" className="py-2 pr-2 text-left font-semibold text-decoricks-dark">
                          Total
                        </th>
                        <td className="py-2 px-2 text-right font-semibold tabular-nums">
                          {formatPaisa(cf.totalBalanceStart)}
                        </td>
                        <td colSpan={2} className="py-2 px-2 text-right text-2xs text-ink-muted">
                          transfers excluded
                        </td>
                        <td className="py-2 pl-2 text-right font-semibold tabular-nums">
                          {formatPaisa(cf.totalBalanceEnd)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {/* Mobile cards */}
                <ul className="divide-y divide-line-subtle md:hidden">
                  {cf.accounts.map((account) => (
                    <li key={account.accountId} className="py-3">
                      <p className="text-sm font-medium text-decoricks-dark">{account.name}</p>
                      <p className="text-2xs text-ink-muted">{KIND_LABEL[account.kind] ?? account.kind}</p>
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        <div className="flex justify-between">
                          <dt className="text-ink-muted">Opening</dt>
                          <dd className="tabular-nums font-medium">{formatPaisa(account.balanceStart)}</dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="text-ink-muted">Closing</dt>
                          <dd className="tabular-nums font-semibold">{formatPaisa(account.balanceEnd)}</dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="text-ink-muted">In</dt>
                          <dd className="tabular-nums text-status-success">{formatPaisa(account.cashIn)}</dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="text-ink-muted">Out</dt>
                          <dd className="tabular-nums text-status-danger">{formatPaisa(account.cashOut)}</dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ul>
                <CalcPanel
                  className="mt-3"
                  label="Closing balance"
                  formula={data.formulas.balanceEnd}
                  inputs={[
                    { label: 'Opening total', value: formatPaisa(cf.totalBalanceStart) },
                    { label: 'Cash in', value: formatPaisa(cf.cashIn) },
                    { label: 'Cash out', value: formatPaisa(cf.cashOut) },
                    { label: 'Closing total', value: formatPaisa(cf.totalBalanceEnd) },
                  ]}
                  link={{ href: allLedgerHref, label: 'Verify against the ledger' }}
                  note="Cash flow is not profit: capital in and withdrawals move cash but never appear in the P&L. See the profit statement for accounting results."
                />
              </>
            )}
          </Card>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <Link
            href="/profit-loss"
            className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-medium text-decoricks-dark hover:bg-surface-sunken"
          >
            Profit &amp; Loss (accounting view)
          </Link>
          <Link
            href="/distributions"
            className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-medium text-decoricks-dark hover:bg-surface-sunken"
          >
            Profit distribution
          </Link>
        </div>
      </>
    );
  };

  return (
    <PageTransition>
      <PageHeader
        title="Cash Flow"
        description="Where cash actually went — balances per account, capital in, withdrawals out. Transfers never count as income or expense."
      />
      <Card className="mb-4 p-4">
        <PeriodFilter value={filter} onChange={setFilter} busy={loading} />
      </Card>
      {body()}
    </PageTransition>
  );
}
