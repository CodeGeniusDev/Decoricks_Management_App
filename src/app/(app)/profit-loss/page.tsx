'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PageTransition } from '@/components/PageTransition';
import { PageHeader, Metric, MetricGrid } from '@/components/layout/Page';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { CalcPanel } from '@/components/ui/CalcPanel';
import { TrendBars } from '@/components/charts/TrendBars';
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
import { toKarachiInputDate, type CategoryView } from '@/modules/finance/finance-ui';
import { categoryLabel } from '@/modules/budget/budget-ui';

/**
 * Profit & Loss — the SPEC §5 chain, live from the ledger (Phase 4 brief
 * item 3).
 *
 * Revenue → refunds → net sales → COGS → gross profit → operating expenses →
 * net profit, over inclusive Asia/Karachi ranges. Every block carries a
 * "Show calculation" panel with the exact formula the API used, its input
 * figures and a deep link to the ledger records that produced them. COGS is
 * labelled PROVISIONAL while it is derived from ledger purchasing; the Phase 5
 * inventory module replaces the input, not this screen.
 */

interface PlLine {
  category: string;
  amount: number;
  count: number;
}

interface PlProfitLoss {
  revenue: number;
  revenueCount: number;
  refunds: number;
  netSales: number;
  cogs: number;
  cogsProvisional: boolean;
  cogsSource: string;
  grossProfit: number;
  operatingExpenses: number;
  netProfit: number;
  operatingLines: PlLine[];
  revenueLines: PlLine[];
  count: number;
}

interface PlMonthlyPoint {
  month: string;
  label: string;
  netSales: number;
  grossProfit: number;
  operatingExpenses: number;
  netProfit: number;
  count: number;
}

interface PlView {
  period: string;
  range: { start: string; end: string };
  profitLoss: PlProfitLoss;
  monthly: PlMonthlyPoint[];
  formulas: { netSales: string; grossProfit: string; netProfit: string; cogs: string };
}

export default function ProfitLossPage() {
  const [filter, setFilter] = useState<PeriodFilterValue>(EMPTY_PERIOD_FILTER);
  const [data, setData] = useState<PlView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryView[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiJson<CategoryView[]>('/api/finance/categories');
        if (!cancelled) setCategories(list);
      } catch {
        if (!cancelled) setCategories([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const labels = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const category of categories) map[category.name] = category.label;
    return map;
  }, [categories]);

  const load = useCallback(async () => {
    if (!periodFilterReady(filter)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await apiJson<PlView>(`/api/finance/pl?${periodFilterQuery(filter)}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profit and loss');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const ledgerHref = (params: Record<string, string>) =>
    `/finance/transactions?${new URLSearchParams({
      startDate: toKarachiInputDate(data!.range.start),
      endDate: toKarachiInputDate(data!.range.end),
      ...params,
    }).toString()}`;

  const body = () => {
    if (loading) {
      return (
        <>
          <Skeleton variant="rect" className="h-24" />
          <Skeleton variant="rect" className="mt-4 h-96" />
        </>
      );
    }
    if (error) {
      return (
        <Card>
          <ErrorState
            title="Could not load profit and loss"
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

    const pl = data.profitLoss;
    const rangeLabel = `${formatKarachiDate(new Date(data.range.start), 'date')} – ${formatKarachiDate(
      new Date(data.range.end),
      'date'
    )} (Karachi)`;

    return (
      <>
        <MetricGrid>
          <Metric label="Net sales" value={formatPaisa(pl.netSales)} hint={`Revenue ${formatPaisa(pl.revenue)}`} />
          <Metric
            label="Gross profit"
            value={formatPaisa(pl.grossProfit)}
            tone={pl.grossProfit < 0 ? 'negative' : 'default'}
            hint={pl.cogsProvisional ? 'COGS provisional' : `COGS ${formatPaisa(pl.cogs)}`}
          />
          <Metric
            label="Net profit"
            value={formatPaisa(pl.netProfit)}
            tone={pl.netProfit < 0 ? 'negative' : 'positive'}
            hint={`${pl.count} ledger entries in range`}
          />
          <Metric
            label="Operating expenses"
            value={formatPaisa(pl.operatingExpenses)}
            hint={`${pl.operatingLines.length} categories`}
          />
        </MetricGrid>

        {pl.count === 0 ? (
          <Card className="mt-4">
            <EmptyState
              title="No ledger entries in this period"
              description="Nothing was recorded between these Karachi dates. Adjust the period or record transactions first."
            />
          </Card>
        ) : null}

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
          <Card className="p-4 lg:col-span-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-decoricks-dark">Statement · {rangeLabel}</h2>
              <Link href="/cash-flow" className="text-xs font-medium text-decoricks-brown hover:underline">
                Cash flow view →
              </Link>
            </div>

            <dl className="text-sm">
              <div className="flex items-baseline justify-between gap-2 py-1.5">
                <dt className="text-ink-secondary">
                  Revenue
                  <span className="ml-1 text-2xs text-ink-muted">({pl.revenueCount} entries)</span>
                </dt>
                <dd className="font-semibold tabular-nums text-status-success">{formatPaisa(pl.revenue)}</dd>
              </div>
              {pl.revenueLines.length > 0 && (
                <dd className="mb-2 ml-3 space-y-0.5 text-xs text-ink-muted">
                  {pl.revenueLines.map((line) => (
                    <p key={line.category} className="flex justify-between tabular-nums">
                      <span>{categoryLabel(line.category, labels)}</span>
                      <span>{formatPaisa(line.amount)}</span>
                    </p>
                  ))}
                </dd>
              )}

              <div className="flex items-baseline justify-between gap-2 border-t border-line-subtle py-1.5">
                <dt className="text-ink-secondary">Refunds (deduction)</dt>
                <dd className="font-semibold tabular-nums text-status-danger">− {formatPaisa(pl.refunds)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2 border-t border-line-subtle py-1.5">
                <dt className="font-semibold text-decoricks-dark">Net sales</dt>
                <dd className="font-semibold tabular-nums text-decoricks-dark">{formatPaisa(pl.netSales)}</dd>
              </div>
              <CalcPanel
                className="my-2"
                label="Net sales"
                formula={data.formulas.netSales}
                inputs={[
                  { label: 'Revenue', value: formatPaisa(pl.revenue) },
                  { label: 'Refunds', value: formatPaisa(pl.refunds) },
                  { label: 'Net sales', value: formatPaisa(pl.netSales) },
                ]}
                link={{ href: ledgerHref({ type: 'income' }), label: 'Open revenue records' }}
                note="Refunds come from the refunds_return_costs expense category (SPEC §5.2)."
              />

              <div className="flex items-baseline justify-between gap-2 border-t border-line-subtle py-1.5">
                <dt className="flex items-center gap-2 text-ink-secondary">
                  COGS
                  {pl.cogsProvisional && <Badge size="sm" variant="warning">Provisional</Badge>}
                </dt>
                <dd className="font-semibold tabular-nums text-status-danger">− {formatPaisa(pl.cogs)}</dd>
              </div>
              <CalcPanel
                className="my-2"
                label="COGS"
                formula={data.formulas.cogs}
                inputs={[{ label: 'COGS (paisa)', value: formatPaisa(pl.cogs) }]}
                link={{ href: ledgerHref({ type: 'expense', category: 'product_purchasing' }), label: 'Open purchasing records' }}
                note={
                  pl.cogsProvisional
                    ? 'Provisional until the Phase 5 inventory module provides weighted-average cost of goods sold (SPEC §5.3). Source: ' +
                      pl.cogsSource
                    : 'Source: ' + pl.cogsSource
                }
              />

              <div className="flex items-baseline justify-between gap-2 border-t border-line-subtle py-1.5">
                <dt className="font-semibold text-decoricks-dark">Gross profit</dt>
                <dd className="font-semibold tabular-nums text-decoricks-dark">{formatPaisa(pl.grossProfit)}</dd>
              </div>
              <CalcPanel
                className="my-2"
                label="Gross profit"
                formula={data.formulas.grossProfit}
                inputs={[
                  { label: 'Net sales', value: formatPaisa(pl.netSales) },
                  { label: 'COGS', value: formatPaisa(pl.cogs) },
                  { label: 'Gross profit', value: formatPaisa(pl.grossProfit) },
                ]}
              />

              <div className="flex items-baseline justify-between gap-2 border-t border-line-subtle py-1.5">
                <dt className="text-ink-secondary">Operating expenses</dt>
                <dd className="font-semibold tabular-nums text-status-danger">− {formatPaisa(pl.operatingExpenses)}</dd>
              </div>
              {pl.operatingLines.length > 0 && (
                <dd className="mb-2 ml-3 space-y-0.5 text-xs text-ink-muted">
                  {pl.operatingLines.map((line) => (
                    <p key={line.category} className="flex justify-between tabular-nums">
                      <span>
                        {categoryLabel(line.category, labels)}
                        <span className="ml-1 text-2xs">({line.count})</span>
                      </span>
                      <span>{formatPaisa(line.amount)}</span>
                    </p>
                  ))}
                </dd>
              )}
              <CalcPanel
                className="my-2"
                label="Operating expenses"
                formula="Σ every expense category except refunds (net-sales deduction) and product purchasing (COGS) — SPEC §5.5"
                inputs={[
                  { label: 'Categories', value: String(pl.operatingLines.length) },
                  { label: 'Total', value: formatPaisa(pl.operatingExpenses) },
                ]}
                link={{ href: ledgerHref({ type: 'expense' }), label: 'Open expense records' }}
                note="Reversals subtract from the category they reverse, so nothing is double-counted."
              />

              <div className="flex items-baseline justify-between gap-2 border-t-2 border-line-strong py-2">
                <dt className="text-base font-semibold text-decoricks-dark">Net profit</dt>
                <dd
                  className={`text-base font-semibold tabular-nums ${
                    pl.netProfit < 0 ? 'text-status-danger' : 'text-decoricks-dark'
                  }`}
                >
                  {formatPaisa(pl.netProfit)}
                </dd>
              </div>
              <CalcPanel
                className="my-2"
                label="Net profit"
                formula={data.formulas.netProfit}
                inputs={[
                  { label: 'Gross profit', value: formatPaisa(pl.grossProfit) },
                  { label: 'Operating expenses', value: formatPaisa(pl.operatingExpenses) },
                  { label: 'Net profit', value: formatPaisa(pl.netProfit) },
                ]}
                link={{ href: ledgerHref({}), label: 'Open all records in this range' }}
                note="Accounting profit, not cash. Partner capital, withdrawals and transfers never appear here — they live in Cash Flow."
              />
            </dl>
          </Card>

          <Card className="p-4 lg:col-span-2">
            <h2 className="mb-3 text-sm font-semibold text-decoricks-dark">Monthly profit trend</h2>
            <TrendBars
              caption={`Net profit per Karachi month, ${data.monthly[0]?.label ?? ''} – ${
                data.monthly[data.monthly.length - 1]?.label ?? ''
              }`}
              points={data.monthly.map((point) => ({
                label: point.label.split(' ')[0],
                fullLabel: point.label,
                value: point.netProfit,
              }))}
            />
            <p className="mt-2 text-2xs text-ink-muted">
              Each month is computed independently with Karachi month boundaries; the current month
              is partial until it ends.
            </p>
          </Card>
        </div>
      </>
    );
  };

  return (
    <PageTransition>
      <PageHeader
        title="Profit & Loss"
        description="Revenue, refunds, COGS, expenses and net profit — computed live from the ledger over Karachi periods (SPEC §5)."
        actions={
          <Link
            href="/distributions"
            className="flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-medium text-decoricks-dark hover:bg-surface-sunken"
          >
            Profit distribution
          </Link>
        }
      />
      <Card className="mb-4 p-4">
        <PeriodFilter value={filter} onChange={setFilter} busy={loading} />
      </Card>
      {body()}
    </PageTransition>
  );
}
