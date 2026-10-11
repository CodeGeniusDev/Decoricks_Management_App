'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { PageTransition } from '@/components/PageTransition';
import { PageHeader, Metric, MetricGrid } from '@/components/layout/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { Table } from '@/components/ui/Table';
import { Toast } from '@/components/ui/Toast';
import { CalcPanel } from '@/components/ui/CalcPanel';
import { BudgetBars } from '@/components/charts/BudgetBars';
import { IconChevronLeft } from '@/components/ui/icons';
import { apiJson, ApiError } from '@/lib/api-client';
import { useAuth } from '@/components/auth/AuthProvider';
import { can } from '@/lib/permissions-client';
import { formatPaisa } from '@/lib/money';
import { formatKarachiDate } from '@/lib/date';
import { toKarachiInputDate, type CategoryView } from '@/modules/finance/finance-ui';
import { BudgetFormModal, type BudgetFormValues } from '@/modules/budget/BudgetFormModal';
import {
  BUDGET_STATUS_LABEL,
  PERIOD_KIND_LABEL,
  WARNING_LEVEL_BADGE,
  WARNING_LEVEL_LABEL,
  categoryLabel,
  type BudgetDetailView,
} from '@/modules/budget/budget-ui';

/**
 * Budget detail — actual vs budget, history and lifecycle (Phase 4 brief
 * items 1–2, 5).
 *
 * The figures are recomputed by the API from the ledger on every load; this
 * screen refetches after every mutation, so a saved edit can never leave a
 * stale number on screen. Deleting is not offered anywhere — closing a budget
 * out is `archive`, which keeps the document, its revisions and the audit
 * trail.
 */

type BudgetAction = 'approve' | 'archive' | 'reopen';

export default function BudgetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();

  const canEdit = user ? can({ role: user.role }, 'budget', 'edit') : false;
  const canApprove = user ? can({ role: user.role }, 'budget', 'approve') : false;

  const [budget, setBudget] = useState<BudgetDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<BudgetAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const actionRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBudget(await apiJson<BudgetDetailView>(`/api/budgets/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load budget');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const labels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const category of categories) map[category.name] = category.label;
    return map;
  }, [categories]);

  const categoryOptions = useMemo(
    () =>
      categories
        .filter((c) => c.type === 'expense' && c.isActive)
        .map((c) => ({ value: c.name, label: c.label })),
    [categories]
  );

  const runAction = async (action: BudgetAction) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setActionBusy(true);
    try {
      await apiJson(`/api/budgets/${id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      setConfirmAction(null);
      setToast({ type: 'success', message: 'Budget status updated and recorded in the audit log.' });
      await load();
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof ApiError ? err.message : `Could not ${action} the budget`,
      });
    } finally {
      actionRef.current = false;
      setActionBusy(false);
    }
  };

  const saveEdit = async (values: BudgetFormValues) => {
    const body: Record<string, unknown> = {
      name: values.name,
      periodStart: values.periodStart,
      periodEnd: values.periodEnd,
      categories: values.categories,
    };
    if (values.periodKind !== 'auto') body.periodKind = values.periodKind;

    // The API answers a PUT with the full fresh detail payload — using it
    // directly means zero chance of stale figures after saving.
    const updated = await apiJson<BudgetDetailView>(`/api/budgets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    setBudget(updated);
    setEditOpen(false);
    setToast({ type: 'success', message: 'Budget updated. The change is in the history below.' });
  };

  if (loading) {
    return (
      <PageTransition>
        <PageHeader title="Budget" description="Actual versus budget, calculated from the ledger." />
        <div className="space-y-4">
          <Skeleton variant="rect" className="h-24" />
          <Skeleton variant="rect" className="h-64" />
        </div>
      </PageTransition>
    );
  }

  if (error || !budget) {
    return (
      <PageTransition>
        <PageHeader title="Budget" />
        <Card>
          <ErrorState
            title="Could not load this budget"
            description={error ?? 'Budget not found.'}
            action={{ label: 'Back to budgets', onClick: () => router.push('/budgets') }}
          />
        </Card>
      </PageTransition>
    );
  }

  // Karachi day boundaries the actuals were computed over — the same range
  // the transactions screen is deep-linked with.
  const rangeStart = toKarachiInputDate(budget.periodStart);
  const rangeEnd = toKarachiInputDate(budget.periodEnd);
  const ledgerHref = `/finance/transactions?${new URLSearchParams({
    type: 'expense',
    startDate: rangeStart,
    endDate: rangeEnd,
  }).toString()}`;

  const actions: { action: BudgetAction; label: string; show: boolean }[] = [
    { action: 'approve', label: 'Approve', show: canApprove && budget.status === 'draft' },
    { action: 'archive', label: 'Archive', show: canEdit && budget.status !== 'archived' },
    { action: 'reopen', label: 'Reopen as draft', show: canEdit && budget.status === 'archived' },
  ];

  const CONFIRM_COPY: Record<BudgetAction, { title: string; body: string }> = {
    approve: {
      title: 'Approve this budget?',
      body: 'Approving activates the budget and records your approval in the audit log. Allocations can still be edited afterwards — every change keeps history.',
    },
    archive: {
      title: 'Archive this budget?',
      body: 'Archiving closes the budget out. It is not deleted: the document, its revisions and its actual-vs-budget history remain available. An archived budget cannot be edited.',
    },
    reopen: {
      title: 'Reopen this budget?',
      body: 'The budget returns to draft for editing and must be approved again.',
    },
  };

  return (
    <PageTransition>
      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      <PageHeader
        title={budget.name}
        description={`${budget.budgetNumber ?? '—'} · ${PERIOD_KIND_LABEL[budget.periodKind]} · ${formatKarachiDate(
          new Date(budget.periodStart),
          'date'
        )} – ${formatKarachiDate(new Date(budget.periodEnd), 'date')} (Karachi)`}
        actions={
          <>
            <Link
              href="/budgets"
              className="flex min-h-11 items-center gap-1 text-sm font-medium text-decoricks-brown hover:underline"
            >
              <IconChevronLeft size={16} /> Budgets
            </Link>
            {canEdit && budget.status !== 'archived' && (
              <Button variant="outline" onClick={() => setEditOpen(true)}>
                Edit
              </Button>
            )}
            {actions
              .filter((entry) => entry.show)
              .map((entry) => (
                <Button
                  key={entry.action}
                  variant={entry.action === 'approve' ? 'primary' : 'outline'}
                  onClick={() => setConfirmAction(entry.action)}
                >
                  {entry.label}
                </Button>
              ))}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge variant={budget.status === 'active' ? 'success' : budget.status === 'draft' ? 'default' : 'warning'}>
          {BUDGET_STATUS_LABEL[budget.status]}
        </Badge>
        {budget.level !== 'ok' && (
          <Badge variant={WARNING_LEVEL_BADGE[budget.level]}>
            Total {WARNING_LEVEL_LABEL[budget.level].toLowerCase()} ({budget.percentUsed}% used)
          </Badge>
        )}
        {budget.warnings.map((warning) => (
          <Badge key={warning.category} variant={WARNING_LEVEL_BADGE[warning.level]} size="sm">
            {categoryLabel(warning.category, labels)} — {warning.percentUsed}% (threshold{' '}
            {warning.threshold}%)
          </Badge>
        ))}
      </div>

      <MetricGrid>
        <Metric label="Allocated" value={formatPaisa(budget.totalBudgeted)} hint={`${budget.categories.length} categories`} />
        <Metric
          label="Spent (from ledger)"
          value={formatPaisa(budget.totalActual)}
          hint={`${budget.sourceEntries.length} expense entries`}
        />
        <Metric
          label="Remaining"
          value={formatPaisa(budget.totalRemaining)}
          tone={budget.totalRemaining < 0 ? 'negative' : 'default'}
          hint={budget.totalRemaining < 0 ? 'Over budget' : undefined}
        />
        <Metric
          label="Used"
          value={`${budget.percentUsed}%`}
          tone={budget.level === 'critical' ? 'negative' : 'default'}
          hint={
            budget.level === 'critical'
              ? 'At or above critical threshold'
              : budget.level === 'warning'
                ? 'At or above warning threshold'
                : undefined
          }
        />
      </MetricGrid>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-decoricks-dark">Budget vs actual</h2>
          {budget.categories.length === 0 ? (
            <p className="text-sm text-ink-muted">This budget has no category allocations.</p>
          ) : (
            <BudgetBars
              caption="Allocated versus spent per category, computed from the ledger"
              rows={budget.categories.map((row) => ({
                label: categoryLabel(row.category, labels),
                budgeted: row.budgeted,
                actual: row.actual,
                level: row.level,
              }))}
            />
          )}
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-decoricks-dark">How these figures were derived</h2>
          <CalcPanel
            label="Total spent"
            formula="Spent = Σ ledger expense entries dated inside the period (reversals count as negatives; transfers and equity entries are ignored)"
            inputs={[
              { label: 'Period start (Karachi)', value: formatKarachiDate(new Date(budget.periodStart), 'date') },
              { label: 'Period end (Karachi)', value: formatKarachiDate(new Date(budget.periodEnd), 'date') },
              { label: 'Expense entries counted', value: String(budget.sourceEntries.length) },
              { label: 'Allocated total', value: formatPaisa(budget.totalBudgeted) },
              { label: 'Spent total', value: formatPaisa(budget.totalActual) },
              { label: 'Used', value: `${budget.percentUsed}%` },
            ]}
            link={{ href: ledgerHref, label: 'Open these ledger records' }}
            note="Warning levels come from the configurable budget thresholds in Business Settings, not fixed numbers."
          />
          <div className="mt-3">
            <h3 className="text-xs font-semibold text-decoricks-dark">Ledger records behind the figures</h3>
            {budget.sourceEntries.length === 0 ? (
              <p className="mt-1 text-xs text-ink-muted">No ledger expenses fall inside this period yet.</p>
            ) : (
              <ul className="mt-1 max-h-48 divide-y divide-line-subtle overflow-y-auto text-xs">
                {budget.sourceEntries.map((entry) => (
                  <li key={entry._id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="min-w-0 truncate text-ink-secondary">
                      {formatKarachiDate(new Date(entry.date), 'date')} ·{' '}
                      {categoryLabel(entry.category, labels)}
                      {entry.note ? ` · ${entry.note}` : ''}
                    </span>
                    <span
                      className={`shrink-0 font-semibold tabular-nums ${
                        entry.amount < 0 ? 'text-status-success' : 'text-decoricks-dark'
                      }`}
                    >
                      {formatPaisa(entry.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      <Card className="mt-4 p-4">
        <h2 className="mb-3 text-sm font-semibold text-decoricks-dark">Category breakdown</h2>
        {/* Desktop table → mobile cards, same data. */}
        <div className="hidden md:block">
          <Table
            caption="Budget versus actual per category"
            columns={[
              { key: 'category', label: 'Category' },
              { key: 'budgeted', label: 'Allocated' },
              { key: 'actual', label: 'Spent' },
              { key: 'remaining', label: 'Remaining' },
              { key: 'used', label: 'Used' },
              { key: 'level', label: 'Status' },
              { key: 'records', label: 'Records' },
            ]}
            data={budget.categories.map((row) => ({
              category: categoryLabel(row.category, labels),
              budgeted: <span className="tabular-nums">{formatPaisa(row.budgeted)}</span>,
              actual: <span className="tabular-nums">{formatPaisa(row.actual)}</span>,
              remaining: (
                <span className={`tabular-nums ${row.remaining < 0 ? 'text-status-danger' : ''}`}>
                  {formatPaisa(row.remaining)}
                </span>
              ),
              used: <span className="tabular-nums">{row.percentUsed}%</span>,
              level: <Badge size="sm" variant={WARNING_LEVEL_BADGE[row.level]}>{WARNING_LEVEL_LABEL[row.level]}</Badge>,
              records: (
                <Link
                  href={`/finance/transactions?${new URLSearchParams({
                    type: 'expense',
                    category: row.category,
                    startDate: rangeStart,
                    endDate: rangeEnd,
                  }).toString()}`}
                  className="text-xs font-medium text-decoricks-brown hover:underline"
                >
                  View →
                </Link>
              ),
            }))}
          />
        </div>
        <ul className="divide-y divide-line-subtle md:hidden">
          {budget.categories.map((row) => (
            <li key={row.category} className="py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-decoricks-dark">
                    {categoryLabel(row.category, labels)}
                  </p>
                  <p className="text-2xs text-ink-muted">{row.percentUsed}% used</p>
                </div>
                <Badge size="sm" variant={WARNING_LEVEL_BADGE[row.level]}>
                  {WARNING_LEVEL_LABEL[row.level]}
                </Badge>
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <dt className="text-ink-muted">Allocated</dt>
                  <dd className="font-semibold tabular-nums">{formatPaisa(row.budgeted)}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Spent</dt>
                  <dd className="font-semibold tabular-nums">{formatPaisa(row.actual)}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Remaining</dt>
                  <dd className={`font-semibold tabular-nums ${row.remaining < 0 ? 'text-status-danger' : ''}`}>
                    {formatPaisa(row.remaining)}
                  </dd>
                </div>
              </dl>
              <Link
                href={`/finance/transactions?${new URLSearchParams({
                  type: 'expense',
                  category: row.category,
                  startDate: rangeStart,
                  endDate: rangeEnd,
                }).toString()}`}
                className="mt-2 inline-block min-h-11 text-xs font-medium text-decoricks-brown hover:underline"
              >
                View ledger records →
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-4 p-4">
        <h2 className="mb-1 text-sm font-semibold text-decoricks-dark">Change history</h2>
        <p className="mb-3 text-xs text-ink-muted">
          Every edit stores a snapshot of the previous allocations and an audit-log entry. Budgets
          are never hard-deleted.
        </p>
        {budget.revisions.length === 0 ? (
          <p className="text-sm text-ink-muted">No edits yet.</p>
        ) : (
          <ol className="space-y-3">
            {[...budget.revisions].reverse().map((revision, index) => (
              <li key={`${revision.revisedAt}-${index}`} className="rounded-lg border border-line-subtle bg-surface-sunken px-3 py-2.5">
                <p className="text-xs font-medium text-decoricks-dark">
                  {revision.revisedByName ?? 'Unknown'} ·{' '}
                  {formatKarachiDate(new Date(revision.revisedAt), 'date')}
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-ink-secondary">
                  {revision.changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <BudgetFormModal
        isOpen={editOpen}
        mode="edit"
        categoryOptions={categoryOptions}
        initial={{
          name: budget.name,
          periodStart: rangeStart,
          periodEnd: rangeEnd,
          categories: budget.categories.map((row) => ({
            category: row.category,
            amount: (row.budgeted / 100).toFixed(2),
          })),
        }}
        onClose={() => setEditOpen(false)}
        onSubmit={saveEdit}
      />

      <Modal
        isOpen={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        title={confirmAction ? CONFIRM_COPY[confirmAction].title : ''}
        dismissible={!actionBusy}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmAction(null)} disabled={actionBusy}>
              Cancel
            </Button>
            <Button
              variant={confirmAction === 'archive' ? 'secondary' : 'primary'}
              loading={actionBusy}
              disabled={actionBusy}
              onClick={() => confirmAction && void runAction(confirmAction)}
            >
              {confirmAction ? CONFIRM_COPY[confirmAction].title.replace('?', '') : 'Confirm'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-secondary">
          {confirmAction ? CONFIRM_COPY[confirmAction].body : ''}
        </p>
      </Modal>
    </PageTransition>
  );
}
