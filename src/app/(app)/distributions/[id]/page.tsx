'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageTransition } from '@/components/PageTransition';
import { PageHeader } from '@/components/layout/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { CalcPanel } from '@/components/ui/CalcPanel';
import { Toast } from '@/components/ui/Toast';
import { Table } from '@/components/ui/Table';
import { apiJson, ApiError } from '@/lib/api-client';
import { useAuth } from '@/components/auth/AuthProvider';
import { can } from '@/lib/permissions-client';
import { formatPaisa } from '@/lib/money';
import { formatKarachiDate } from '@/lib/date';
import { parsePkrAmount, toKarachiInputDate } from '@/modules/finance/finance-ui';
import {
  STATUS_BADGE,
  STATUS_LABEL,
  monthLabelKarachi,
  type DistributionPartnerShareView,
  type DistributionView,
} from '@/modules/finance/distribution-ui';

/**
 * Profit Distribution detail — the full monthly calculation, Founder actions
 * and adjustments (Phase 4 brief item 6).
 *
 * Every figure on this screen comes from the stored snapshot: the P&L the
 * API recomputed from the ledger on the day the Founder pressed "Calculate",
 * the policy percentages it used, and the largest-remainder split that keeps
 * paisa exact. Adjustments are the only writes allowed before approval, each
 * one requires a reason, is audit-logged and re-splits the whole month. After
 * approval the record is locked: the API returns 409 and this screen shows
 * the lock instead of the form.
 */

type ConfirmAction = 'approve' | 'distribute';

const CONFIRM_COPY: Record<ConfirmAction, { title: string; description: string; label: string }> = {
  approve: {
    title: 'Approve and lock this distribution?',
    description:
      'Locking signs off every figure on this page. Adjustments and recalculation are no longer possible — the ledger and audit log keep the history.',
    label: 'Approve & lock',
  },
  distribute: {
    title: 'Mark this distribution as paid out?',
    description:
      'This records that the partners actually received their withdrawable amounts. It changes no figures; the numbers stay exactly as approved.',
    label: 'Mark distributed',
  },
};

export default function DistributionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canApprove = user ? can({ role: user.role }, 'finance', 'approve') : false;

  const [dist, setDist] = useState<DistributionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  // Adjustment form state — reset every time the modal opens.
  const [partnerName, setPartnerName] = useState('');
  const [direction, setDirection] = useState<'bonus' | 'deduction'>('bonus');
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const [adjustErrors, setAdjustErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDist(await apiJson<DistributionView>(`/api/finance/distributions/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load distribution');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const ledgerHref = useMemo(() => {
    if (!dist) return '#';
    const params = new URLSearchParams({
      startDate: toKarachiInputDate(dist.periodStart),
      endDate: toKarachiInputDate(dist.periodEnd),
    });
    return `/finance/transactions?${params.toString()}`;
  }, [dist]);

  /** Σ finalAmount — used for the "adds up exactly" proof row. */
  const sums = useMemo(() => {
    if (!dist) return null;
    const finalTotal = dist.partnerShares.reduce((sum, share) => sum + share.finalAmount, 0);
    const reinvestTotal = dist.partnerShares.reduce((sum, share) => sum + share.reinvestedAmount, 0);
    const withdrawableTotal = dist.partnerShares.reduce((sum, share) => sum + share.availableToWithdraw, 0);
    const charityPlusFinalPlusRetained = dist.charityShare.amount + finalTotal + dist.retainedEarnings;
    return {
      finalTotal,
      reinvestTotal,
      withdrawableTotal,
      charityPlusFinalPlusRetained,
      balanced: charityPlusFinalPlusRetained === dist.netProfit,
      reinvestMatches: reinvestTotal === dist.reinvestmentAmount,
    };
  }, [dist]);

  const runAction = async (action: ConfirmAction) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const updated = await apiJson<DistributionView>(`/api/finance/distributions/${id}/${action}`, {
        method: 'POST',
      });
      // The route returns the full fresh record — adopt it, no refetch, no stale figures.
      setDist(updated);
      setConfirmAction(null);
      setToast({
        type: 'success',
        message:
          action === 'approve'
            ? 'Distribution approved and locked. Recorded in the audit log.'
            : 'Distribution marked as distributed. Recorded in the audit log.',
      });
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof ApiError ? err.message : `Could not ${action} the distribution`,
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const openAdjust = () => {
    if (dist && dist.partnerShares.length > 0) setPartnerName(dist.partnerShares[0].partnerName);
    setDirection('bonus');
    setAmountText('');
    setReason('');
    setAdjustErrors({});
    setAdjustOpen(true);
  };

  const submitAdjustment = async () => {
    if (!dist || busyRef.current) return;

    const errors: Record<string, string> = {};
    const parsed = parsePkrAmount(amountText);
    const amountPaisa = parsed.ok ? parsed.paisa : 0;
    if (amountPaisa <= 0) errors.amount = 'Enter a positive amount, e.g. 5000 or 5000.50';
    if (reason.trim().length < 3) errors.reason = 'A reason is required — it goes into the audit log';
    if (Object.keys(errors).length > 0) {
      setAdjustErrors(errors);
      return;
    }

    busyRef.current = true;
    setBusy(true);
    try {
      const signed = direction === 'bonus' ? amountPaisa : -amountPaisa;
      const updated = await apiJson<DistributionView>(`/api/finance/distributions/${id}/adjustments`, {
        method: 'POST',
        body: JSON.stringify({ partnerName, amount: signed, reason: reason.trim() }),
      });
      setDist(updated);
      setAdjustOpen(false);
      setToast({ type: 'success', message: 'Adjustment applied — the whole month was re-split.' });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not apply the adjustment';
      if (err instanceof ApiError && err.code === 'DISTRIBUTION_LOCKED') {
        // Someone approved it in the meantime — resync instead of leaving a stale form.
        setAdjustOpen(false);
        void load();
      }
      setToast({ type: 'error', message });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <PageTransition>
        <PageHeader title="Profit Distribution" />
        <Skeleton variant="rect" className="h-28" />
        <Skeleton variant="rect" className="mt-4 h-72" />
        <Skeleton variant="rect" className="mt-4 h-72" />
      </PageTransition>
    );
  }

  if (error || !dist) {
    return (
      <PageTransition>
        <PageHeader title="Profit Distribution" />
        <Card>
          <ErrorState
            title="Could not load this distribution"
            description={error ?? 'Distribution not found.'}
            action={{ label: 'Retry', onClick: () => void load() }}
          />
        </Card>
      </PageTransition>
    );
  }

  const shareColumns = [
    { key: 'partner', label: 'Partner' },
    { key: 'pct', label: 'Share %' },
    { key: 'share', label: 'Share' },
    { key: 'reinvestPct', label: 'Reinvest %' },
    { key: 'reinvested', label: 'Reinvested' },
    { key: 'adjustments', label: 'Adjustments' },
    { key: 'final', label: 'Final share' },
    { key: 'withdrawable', label: 'Withdrawable' },
  ];

  const shareRows = dist.partnerShares.map((share) => ({
    _id: share.partnerName,
    partner: <span className="font-medium text-decoricks-dark">{share.partnerName}</span>,
    pct: <span className="tabular-nums">{share.sharePercentage}%</span>,
    share: <span className="tabular-nums">{formatPaisa(share.shareAmount)}</span>,
    reinvestPct: <span className="tabular-nums">{share.reinvestPercentage}%</span>,
    reinvested: <span className="tabular-nums">{formatPaisa(share.reinvestedAmount)}</span>,
    adjustments:
      share.adjustments.length === 0 ? (
        <span className="text-ink-muted">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {share.adjustments.map((adjustment) => (
            <Badge
              key={`${share.partnerName}:${adjustment.adjustedAt}:${adjustment.amount}`}
              size="sm"
              variant={adjustment.amount < 0 ? 'warning' : 'default'}
            >
              {`${adjustment.amount < 0 ? '−' : '+'}${formatPaisa(Math.abs(adjustment.amount)).replace('PKR ', '')} · ${adjustment.reason}`}
            </Badge>
          ))}
        </div>
      ),
    final: <span className="font-semibold tabular-nums text-decoricks-dark">{formatPaisa(share.finalAmount)}</span>,
    withdrawable: (
      <span className={`tabular-nums ${share.availableToWithdraw < 0 ? 'text-status-danger' : 'font-semibold text-decoricks-dark'}`}>
        {formatPaisa(share.availableToWithdraw)}
      </span>
    ),
  }));

  const shareCard = (share: DistributionPartnerShareView) => (
    // key is read from the element itself — the md:hidden map below renders
    // whatever shareCard returns; partnerName is unique per distribution
    // (the settings schema rejects duplicate partner names).
    <div key={share.partnerName} className="rounded-lg border border-line-subtle bg-surface-raised p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-medium text-decoricks-dark">{share.partnerName}</p>
        <p className="text-xs text-ink-muted">
          {share.sharePercentage}% of net profit · reinvest {share.reinvestPercentage}%
        </p>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <div>
          <dt className="text-2xs uppercase tracking-wide text-ink-muted">Share</dt>
          <dd className="tabular-nums">{formatPaisa(share.shareAmount)}</dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-wide text-ink-muted">Reinvested</dt>
          <dd className="tabular-nums">{formatPaisa(share.reinvestedAmount)}</dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-wide text-ink-muted">Final share</dt>
          <dd className="font-semibold tabular-nums text-decoricks-dark">{formatPaisa(share.finalAmount)}</dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-wide text-ink-muted">Withdrawable</dt>
          <dd className={`font-semibold tabular-nums ${share.availableToWithdraw < 0 ? 'text-status-danger' : 'text-decoricks-dark'}`}>
            {formatPaisa(share.availableToWithdraw)}
          </dd>
        </div>
      </dl>
      {share.adjustments.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-line-subtle pt-2 text-xs text-ink-secondary">
          {share.adjustments.map((adjustment) => (
            <li
              key={`${share.partnerName}:${adjustment.adjustedAt}:${adjustment.amount}`}
              className="flex items-baseline justify-between gap-2"
            >
              <span className="min-w-0">
                {adjustment.reason}
                <span className="block text-2xs text-ink-muted">
                  by {adjustment.adjustedByName ?? 'Founder'} ·{' '}
                  {formatKarachiDate(new Date(adjustment.adjustedAt), 'date')}
                </span>
              </span>
              <span
                className={`shrink-0 font-semibold tabular-nums ${
                  adjustment.amount < 0 ? 'text-status-danger' : 'text-status-success'
                }`}
              >
                {`${adjustment.amount < 0 ? '−' : '+'} ${formatPaisa(Math.abs(adjustment.amount))}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const statementRow = (label: React.ReactNode, value: string, opts?: { strike?: boolean; bold?: boolean; muted?: boolean }) => (
    <div
      className={`flex items-baseline justify-between gap-2 py-1.5 ${opts?.bold ? 'border-t-2 border-line-strong' : 'border-t border-line-subtle'}`}
    >
      <dt className={opts?.bold ? 'font-semibold text-decoricks-dark' : 'text-ink-secondary'}>{label}</dt>
      <dd
        className={`tabular-nums ${opts?.bold ? 'font-semibold text-decoricks-dark' : ''} ${
          opts?.strike ? 'text-ink-muted line-through' : ''
        } ${opts?.muted ? 'text-ink-muted' : ''}`}
      >
        {value}
      </dd>
    </div>
  );

  return (
    <PageTransition>
      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      <PageHeader
        title={`Distribution · ${monthLabelKarachi(dist.month)}`}
        description={
          dist.distributionNumber
            ? `${dist.distributionNumber} — calculated ${formatKarachiDate(new Date(dist.createdAt), 'date')} (Karachi), approved and locked only by the Founder.`
            : 'Calculated from the ledger for this Karachi month.'
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_BADGE[dist.status]}>{STATUS_LABEL[dist.status]}</Badge>
        {dist.locked && (
          <span className="text-xs text-ink-muted">
            Locked{dist.approvedByName ? ` by ${dist.approvedByName}` : ''}
            {dist.approvedAt ? ` on ${formatKarachiDate(new Date(dist.approvedAt), 'datetime')}` : ''}
          </span>
        )}
        {dist.distributedAt && (
          <span className="text-xs text-ink-muted">
            · paid out {formatKarachiDate(new Date(dist.distributedAt), 'date')}
          </span>
        )}
      </div>

      {canApprove && !dist.locked && (
        <Card className="mb-4 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-ink-secondary">
              This is a proposal. Review every figure below, adjust if needed, then approve to lock it.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={openAdjust} disabled={busy}>
                Add profit-share adjustment
              </Button>
              <Button onClick={() => setConfirmAction('approve')} disabled={busy}>
                Approve &amp; lock
              </Button>
            </div>
          </div>
        </Card>
      )}

      {canApprove && dist.status === 'approved' && (
        <Card className="mb-4 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-ink-secondary">
              Approved and locked. Once the partners have actually been paid, mark it distributed.
            </p>
            <Button onClick={() => setConfirmAction('distribute')} disabled={busy}>
              Mark distributed
            </Button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* ── P&L snapshot ─────────────────────────────────────────────── */}
        <Card className="p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-decoricks-dark">Profit &amp; loss for the month</h2>
            <Link href={ledgerHref} className="text-xs font-medium text-decoricks-brown hover:underline">
              Ledger records →
            </Link>
          </div>
          <dl className="text-sm">
            {statementRow('Revenue', formatPaisa(dist.totalRevenue))}
            {statementRow('Refunds (deduction)', `− ${formatPaisa(dist.refunds)}`)}
            {statementRow('Net sales', formatPaisa(dist.netSales), { bold: true })}
            {statementRow(
              <span className="flex items-center gap-2">
                COGS
                {dist.cogsProvisional && (
                  <Badge size="sm" variant="warning">Provisional</Badge>
                )}
              </span>,
              `− ${formatPaisa(dist.cogs)}`
            )}
            {statementRow('Gross profit', formatPaisa(dist.grossProfit), { bold: true })}
            {statementRow('Operating expenses', `− ${formatPaisa(dist.operatingExpenses)}`)}
            {statementRow(
              <span className="text-base font-semibold">Net profit</span>,
              formatPaisa(dist.netProfit),
              { bold: true }
            )}
          </dl>
          <CalcPanel
            className="mt-3"
            label="Net profit"
            formula="Net profit = net sales − COGS − operating expenses (SPEC §5.5)"
            inputs={[
              { label: 'Net sales', value: formatPaisa(dist.netSales) },
              { label: 'COGS', value: formatPaisa(dist.cogs) },
              { label: 'Operating expenses', value: formatPaisa(dist.operatingExpenses) },
              { label: 'Net profit', value: formatPaisa(dist.netProfit) },
            ]}
            link={{ href: ledgerHref, label: 'Verify against the ledger' }}
            note={
              dist.cogsProvisional
                ? 'COGS is provisional — purchasing from the ledger until the Phase 5 inventory module provides weighted-average cost.'
                : 'COGS comes from the inventory module (weighted average cost).'
            }
          />
          <p className="mt-2 text-xs text-ink-muted">
            These figures are a snapshot taken when the Founder pressed &quot;Calculate&quot;. Later ledger
            entries do not silently change an approved distribution.
          </p>
        </Card>

        {/* ── The split ────────────────────────────────────────────────── */}
        <Card className="p-4 lg:col-span-3">
          <h2 className="mb-3 text-sm font-semibold text-decoricks-dark">How the profit was split</h2>

          <div className="mb-3 flex items-baseline justify-between gap-2 rounded-md bg-surface-sunken px-3 py-2">
            <span className="text-sm text-ink-secondary">
              Charity · {dist.charityShare.percentage}% of net profit
            </span>
            <span className="font-semibold tabular-nums text-decoricks-dark">
              {formatPaisa(dist.charityShare.amount)}
            </span>
          </div>

          <div className="hidden overflow-x-auto md:block">
            <Table
              columns={shareColumns}
              data={shareRows}
              rowKey="_id"
              caption="Per-partner share calculation for this month"
            />
          </div>
          <div className="space-y-3 md:hidden">{dist.partnerShares.map((share) => shareCard(share))}</div>

          {sums && (
            <div className="mt-4 space-y-1 rounded-md border border-line-subtle bg-surface-raised px-3 py-2 text-sm">
              <p className="flex items-baseline justify-between gap-2">
                <span className="text-ink-secondary">Charity + final partner shares + retained earnings</span>
                <span className="font-semibold tabular-nums text-decoricks-dark">
                  {formatPaisa(sums.charityPlusFinalPlusRetained)}
                </span>
              </p>
              <p className="flex items-baseline justify-between gap-2">
                <span className="text-ink-secondary">Net profit</span>
                <span className="font-semibold tabular-nums text-decoricks-dark">{formatPaisa(dist.netProfit)}</span>
              </p>
              <p className={`text-xs font-medium ${sums.balanced ? 'text-status-success' : 'text-status-danger'}`}>
                {sums.balanced
                  ? 'Adds up exactly — no paisa lost or invented by rounding.'
                  : 'Mismatch — do not approve; reopen and recalculate.'}
              </p>
              <p className="border-t border-line-subtle pt-1 text-xs text-ink-muted">
                Reinvested {formatPaisa(sums.reinvestTotal)} stays in the business ·{' '}
                {formatPaisa(sums.withdrawableTotal)} available to partners now ·{' '}
                {formatPaisa(dist.retainedEarnings)} retained earnings.
              </p>
            </div>
          )}

          <CalcPanel
            className="mt-3"
            label="The split maths"
            formula="Charity = net profit × charity %. Partner pool = net profit × Σ partner %. Shares split across partners by the largest-remainder method, so paisa sum exactly (SPEC §5.7–5.8)."
            inputs={[
              { label: 'Net profit', value: formatPaisa(dist.netProfit) },
              { label: 'Charity %', value: `${dist.policySnapshot.charityPercentage}%` },
              {
                label: 'Partner %',
                value: dist.policySnapshot.partners.map((p) => `${p.name} ${p.percentage}%`).join(', '),
              },
              { label: 'Charity', value: formatPaisa(dist.charityShare.amount) },
              { label: 'Σ partner final shares', value: sums ? formatPaisa(sums.finalTotal) : '—' },
              { label: 'Retained earnings', value: formatPaisa(dist.retainedEarnings) },
            ]}
            note="Per partner: reinvested = floor(share × reinvest %); final = share + adjustments (deductions are redistributed pro-rata to the other partners, bonuses come out of retained earnings); withdrawable = final − reinvested."
          />

          {dist.partnerShares.some((share) => share.adjustments.length > 0) && (
            <p className="mt-2 text-xs text-ink-muted">
              Adjustments were applied after the first calculation. Each one re-split the whole month from the
              stored snapshot — see the reasons above and the audit log.
            </p>
          )}
        </Card>
      </div>

      {/* ── Confirm approve / distribute ───────────────────────────────── */}
      <Modal
        isOpen={confirmAction !== null}
        onClose={() => (busy ? undefined : setConfirmAction(null))}
        title={confirmAction ? CONFIRM_COPY[confirmAction].title : ''}
        description={confirmAction ? CONFIRM_COPY[confirmAction].description : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmAction(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => confirmAction && void runAction(confirmAction)} loading={busy} disabled={busy}>
              {confirmAction ? CONFIRM_COPY[confirmAction].label : ''}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-secondary">
          Net profit {formatPaisa(dist.netProfit)} · Charity {formatPaisa(dist.charityShare.amount)} ·{' '}
          Partners {sums ? formatPaisa(sums.finalTotal) : '—'} · Retained {formatPaisa(dist.retainedEarnings)}
        </p>
      </Modal>

      {/* ── Adjustment modal ───────────────────────────────────────────── */}
      <Modal
        isOpen={adjustOpen}
        onClose={() => (busy ? undefined : setAdjustOpen(false))}
        title="Profit-share adjustment"
        description="Signed-off informally as a bonus or deduction against one partner's share. The reason is mandatory and goes to the audit log; the whole month is then re-split per the settings."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdjustOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void submitAdjustment()} loading={busy} disabled={busy}>
              Apply adjustment
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Select
            label="Partner"
            value={partnerName}
            onChange={(e) => setPartnerName(e.target.value)}
            options={dist.partnerShares.map((share) => ({ value: share.partnerName, label: share.partnerName }))}
          />
          <Select
            label="Direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as 'bonus' | 'deduction')}
            options={[
              { value: 'bonus', label: 'Bonus — add to this partner (from retained earnings)' },
              { value: 'deduction', label: 'Deduction — take from this partner (redistributed to the others)' },
            ]}
          />
          <Input
            label="Amount (PKR)"
            inputMode="decimal"
            placeholder="e.g. 5000"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            error={adjustErrors.amount}
          />
          <Textarea
            label="Reason (required, audit-logged)"
            rows={3}
            placeholder="Why is this share changing?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={adjustErrors.reason}
          />
          <p className="text-xs text-ink-muted">
            Charity is never redistributed. A deduction moves paisa to the other partners in proportion to
            their configured percentages.
          </p>
        </div>
      </Modal>
    </PageTransition>
  );
}
