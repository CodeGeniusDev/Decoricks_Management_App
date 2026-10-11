'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageTransition } from '@/components/PageTransition';
import { PageHeader } from '@/components/layout/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Table } from '@/components/ui/Table';
import { Toast } from '@/components/ui/Toast';
import { apiJson, ApiError } from '@/lib/api-client';
import { useAuth } from '@/components/auth/AuthProvider';
import { can } from '@/lib/permissions-client';
import { formatPaisa } from '@/lib/money';
import { newIdempotencyKey } from '@/modules/finance/finance-ui';
import {
  STATUS_BADGE,
  STATUS_LABEL,
  monthLabelKarachi,
  type DistributionView,
} from '@/modules/finance/distribution-ui';

/**
 * Profit Distribution — list and calculation entry point (Phase 4 brief
 * item 6).
 *
 * A distribution only exists because the Founder pressed "Calculate" for a
 * month: nothing here is automated. The record starts as a `calculated`
 * proposal; approval (which locks it) happens on the detail screen. Pressing
 * calculate twice for the same month replays the first record — the API keeps
 * one document per Karachi month.
 */

export default function DistributionsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const canApprove = user ? can({ role: user.role }, 'finance', 'approve') : false;

  const [items, setItems] = useState<DistributionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [month, setMonth] = useState('');
  const [calculating, setCalculating] = useState(false);
  const calculatingRef = useRef(false);
  const idempotencyKeyRef = useRef(newIdempotencyKey());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await apiJson<DistributionView[]>('/api/finance/distributions'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load distributions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const calculate = async () => {
    if (calculatingRef.current || !month) return;
    calculatingRef.current = true;
    setCalculating(true);
    try {
      const created = await apiJson<DistributionView>('/api/finance/distributions', {
        method: 'POST',
        body: JSON.stringify({ month, idempotencyKey: idempotencyKeyRef.current }),
      });
      // Fresh key for the next run; this one has done its job.
      idempotencyKeyRef.current = newIdempotencyKey();
      router.push(`/distributions/${created._id}`);
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof ApiError ? err.message : 'Could not calculate the distribution',
      });
    } finally {
      calculatingRef.current = false;
      setCalculating(false);
    }
  };

  const columns = [
    { key: 'month', label: 'Month' },
    { key: 'number', label: 'Reference' },
    { key: 'status', label: 'Status' },
    { key: 'netProfit', label: 'Net profit' },
    { key: 'charity', label: 'Charity' },
    { key: 'reinvested', label: 'Reinvested' },
    { key: 'withdrawable', label: 'Withdrawable' },
  ];

  const rows = items.map((item) => ({
    _id: item._id,
    month: <span className="font-medium text-decoricks-dark">{monthLabelKarachi(item.month)}</span>,
    number: <span className="text-xs text-ink-muted">{item.distributionNumber ?? '—'}</span>,
    status: <Badge variant={STATUS_BADGE[item.status]}>{STATUS_LABEL[item.status]}</Badge>,
    netProfit: (
      <span className={`tabular-nums ${item.netProfit < 0 ? 'text-status-danger' : ''}`}>
        {formatPaisa(item.netProfit)}
      </span>
    ),
    charity: <span className="tabular-nums">{formatPaisa(item.charityShare.amount)}</span>,
    reinvested: <span className="tabular-nums">{formatPaisa(item.reinvestmentAmount)}</span>,
    withdrawable: (
      <span className="tabular-nums">
        {formatPaisa(item.partnerShares.reduce((sum, share) => sum + share.availableToWithdraw, 0))}
      </span>
    ),
  }));

  return (
    <PageTransition>
      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      <PageHeader
        title="Profit Distribution"
        description="Monthly partner and charity shares, calculated from the ledger and the configured policy. Nothing here is automated — every record is a Founder decision."
      />

      {canApprove && (
        <Card className="mb-4 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="sm:w-44">
              <Input
                label="Month (Karachi)"
                type="month"
                value={month}
                disabled={calculating}
                onChange={(e) => setMonth(e.target.value)}
              />
            </div>
            <Button onClick={() => void calculate()} loading={calculating} disabled={calculating || !month}>
              Calculate distribution
            </Button>
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            Runs the P&amp;L for the month and splits net profit per the profit-sharing settings —
            charity first, then partner shares, then each partner&apos;s reinvestment. The result is
            a proposal: review it, adjust if needed, then approve to lock it.
          </p>
        </Card>
      )}

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} variant="rect" className="h-20" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <ErrorState
            title="Could not load distributions"
            description={error}
            action={{ label: 'Retry', onClick: () => void load() }}
          />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            title="No distributions yet"
            description={
              canApprove
                ? 'Pick a month above and run the calculation. It stays a proposal until you approve it.'
                : 'The Founder has not run a monthly distribution yet.'
            }
          />
        </Card>
      ) : (
        <>
          <div className="hidden md:block">
            <Card className="overflow-hidden p-0">
              <Table
                columns={columns}
                data={rows}
                rowKey="_id"
                caption="Monthly profit distributions"
                onRowClick={(row) => router.push(`/distributions/${String(row._id)}`)}
              />
            </Card>
          </div>
          <ul className="space-y-3 md:hidden">
            {items.map((item) => (
              <li key={item._id}>
                <button
                  type="button"
                  onClick={() => router.push(`/distributions/${item._id}`)}
                  className="w-full min-h-11 rounded-lg border border-line-subtle bg-surface-raised px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-decoricks-brown"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-decoricks-dark">{monthLabelKarachi(item.month)}</p>
                      <p className="text-xs text-ink-muted">{item.distributionNumber ?? '—'}</p>
                    </div>
                    <Badge variant={STATUS_BADGE[item.status]} size="sm">
                      {STATUS_LABEL[item.status]}
                    </Badge>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <dt className="text-ink-muted">Net profit</dt>
                      <dd className={`font-semibold tabular-nums ${item.netProfit < 0 ? 'text-status-danger' : 'text-decoricks-dark'}`}>
                        {formatPaisa(item.netProfit)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-muted">Charity</dt>
                      <dd className="font-semibold tabular-nums text-decoricks-dark">
                        {formatPaisa(item.charityShare.amount)}
                      </dd>
                    </div>
                  </dl>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </PageTransition>
  );
}
