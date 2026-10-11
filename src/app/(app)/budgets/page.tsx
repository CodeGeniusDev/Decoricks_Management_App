'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageTransition } from '@/components/PageTransition';
import { PageHeader } from '@/components/layout/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Select } from '@/components/ui/Select';
import { Table } from '@/components/ui/Table';
import { Toast } from '@/components/ui/Toast';
import { IconPlus } from '@/components/ui/icons';
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
  categoryLabel,
  newIdempotencyKey,
  type BudgetView,
} from '@/modules/budget/budget-ui';

/**
 * Budgets — list and creation (Phase 4 brief items 1–2).
 *
 * The list carries live actual-vs-budget figures: every row's spend is
 * recomputed from the ledger on each load, so numbers can never be stale
 * between visits. Creation is Founder-only by default (`budget.create`),
 * guarded by an idempotency key per form session so a retry cannot
 * double-create a budget. Editing, approval and the archive lifecycle live
 * on the detail screen.
 */

type StatusFilter = 'all' | 'draft' | 'active' | 'archived';

const STATUS_BADGE: Record<BudgetView['status'], 'default' | 'success' | 'warning'> = {
  draft: 'default',
  active: 'success',
  archived: 'warning',
};

export default function BudgetsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const canCreate = user ? can({ role: user.role }, 'budget', 'create') : false;

  const [budgets, setBudgets] = useState<BudgetView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  // One key per form session, minted when the dialog opens.
  const idempotencyKeyRef = useRef('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBudgets(await apiJson<BudgetView[]>('/api/budgets'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load budgets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Reference data for labels and the create form; not fatal if it fails.
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

  const visible = useMemo(
    () => (statusFilter === 'all' ? budgets : budgets.filter((b) => b.status === statusFilter)),
    [budgets, statusFilter]
  );

  const openCreate = () => {
    idempotencyKeyRef.current = newIdempotencyKey();
    setModalOpen(true);
  };

  const createBudget = async (values: BudgetFormValues) => {
    const body: Record<string, unknown> = {
      name: values.name,
      periodStart: values.periodStart,
      periodEnd: values.periodEnd,
      categories: values.categories,
      idempotencyKey: idempotencyKeyRef.current,
    };
    if (values.periodKind !== 'auto') body.periodKind = values.periodKind;

    await apiJson('/api/budgets', { method: 'POST', body: JSON.stringify(body) });
    setModalOpen(false);
    setToast({ type: 'success', message: `Budget "${values.name}" created as a draft.` });
    await load();
  };

  if (loading) {
    return (
      <PageTransition>
        <PageHeader title="Budgets" description="Period allocations with live actual-vs-budget." />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} variant="rect" className="h-20" />
          ))}
        </div>
      </PageTransition>
    );
  }

  if (error) {
    return (
      <PageTransition>
        <PageHeader title="Budgets" />
        <Card>
          <ErrorState
            title="Could not load budgets"
            description={error}
            action={{ label: 'Retry', onClick: () => void load() }}
          />
        </Card>
      </PageTransition>
    );
  }

  const columns = [
    { key: 'name', label: 'Budget' },
    { key: 'period', label: 'Period' },
    { key: 'status', label: 'Status' },
    { key: 'budgeted', label: 'Allocated' },
    { key: 'actual', label: 'Spent' },
    { key: 'used', label: 'Used' },
    { key: 'warnings', label: 'Warnings' },
  ];

  const rows = visible.map((budget) => ({
    _id: budget._id,
    name: (
      <div className="min-w-0">
        <p className="truncate font-medium text-decoricks-dark">{budget.name}</p>
        <p className="text-xs text-ink-muted">{budget.budgetNumber ?? '—'}</p>
      </div>
    ),
    period: (
      <div>
        <p className="text-xs text-ink-secondary">
          {formatKarachiDate(new Date(budget.periodStart), 'date')} –{' '}
          {formatKarachiDate(new Date(budget.periodEnd), 'date')}
        </p>
        <p className="text-2xs text-ink-muted">{PERIOD_KIND_LABEL[budget.periodKind]}</p>
      </div>
    ),
    status: <Badge variant={STATUS_BADGE[budget.status]}>{BUDGET_STATUS_LABEL[budget.status]}</Badge>,
    budgeted: <span className="tabular-nums">{formatPaisa(budget.totalBudgeted)}</span>,
    actual: <span className="tabular-nums">{formatPaisa(budget.totalActual)}</span>,
    used: (
      <div className="flex items-center gap-2">
        <span className="tabular-nums">{budget.percentUsed}%</span>
        {budget.level !== 'ok' && (
          <Badge size="sm" variant={budget.level === 'critical' ? 'error' : 'warning'}>
            {budget.level === 'critical' ? 'Over limit' : 'Near limit'}
          </Badge>
        )}
      </div>
    ),
    warnings:
      budget.warnings.length > 0 ? (
        <span className="text-xs text-status-warning">
          {budget.warnings.length} categor{budget.warnings.length === 1 ? 'y' : 'ies'} at or above{' '}
          {budget.warnings[0].threshold}%
        </span>
      ) : (
        <span className="text-xs text-ink-muted">—</span>
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
        title="Budgets"
        description="Allocations per category, with actual spend calculated live from the ledger."
        actions={
          <>
            <div className="w-40">
              <Select
                aria-label="Filter by status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                options={[
                  { value: 'all', label: 'All statuses' },
                  { value: 'draft', label: 'Draft' },
                  { value: 'active', label: 'Active' },
                  { value: 'archived', label: 'Archived' },
                ]}
              />
            </div>
            {canCreate && (
              <Button onClick={openCreate}>
                <IconPlus size={16} className="mr-1 inline-block align-[-3px]" />
                New budget
              </Button>
            )}
          </>
        }
      />

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            title={budgets.length === 0 ? 'No budgets yet' : 'No budgets with this status'}
            description={
              budgets.length === 0
                ? 'Create a budget to allocate spend per category for a week, a month or any custom period.'
                : 'Change the status filter to see the rest.'
            }
            action={canCreate && budgets.length === 0 ? { label: 'New budget', onClick: openCreate } : undefined}
          />
        </Card>
      ) : (
        <>
          {/* Desktop: one dense table. */}
          <div className="hidden md:block">
            <Card className="overflow-hidden p-0">
              <Table
                columns={columns}
                data={rows}
                rowKey="_id"
                caption="Budgets with live actual-vs-budget figures"
                onRowClick={(row) => router.push(`/budgets/${String(row._id)}`)}
              />
            </Card>
          </div>

          {/* Mobile: the same rows as cards (no horizontal scroll, 44px targets). */}
          <ul className="space-y-3 md:hidden">
            {visible.map((budget) => (
              <li key={budget._id}>
                <button
                  type="button"
                  onClick={() => router.push(`/budgets/${budget._id}`)}
                  className="w-full rounded-lg border border-line-subtle bg-surface-raised px-4 py-3 text-left min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-decoricks-brown"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-decoricks-dark">{budget.name}</p>
                      <p className="text-xs text-ink-muted">
                        {budget.budgetNumber ?? '—'} ·{' '}
                        {toKarachiInputDate(budget.periodStart)} → {toKarachiInputDate(budget.periodEnd)}
                      </p>
                    </div>
                    <Badge variant={STATUS_BADGE[budget.status]} size="sm">
                      {BUDGET_STATUS_LABEL[budget.status]}
                    </Badge>
                  </div>
                  <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <dt className="text-ink-muted">Allocated</dt>
                      <dd className="font-semibold tabular-nums text-decoricks-dark">
                        {formatPaisa(budget.totalBudgeted)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-muted">Spent</dt>
                      <dd className="font-semibold tabular-nums text-decoricks-dark">
                        {formatPaisa(budget.totalActual)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-muted">Used</dt>
                      <dd
                        className={`font-semibold tabular-nums ${
                          budget.level === 'critical'
                            ? 'text-status-danger'
                            : budget.level === 'warning'
                              ? 'text-status-warning'
                              : 'text-decoricks-dark'
                        }`}
                      >
                        {budget.percentUsed}%
                      </dd>
                    </div>
                  </dl>
                  {budget.warnings.length > 0 && (
                    <p className="mt-2 rounded-md bg-status-warning-bg px-2 py-1 text-2xs text-status-warning">
                      {budget.warnings
                        .map((w) => `${categoryLabel(w.category, labels)} (${w.percentUsed}%)`)
                        .join(', ')}{' '}
                      at or above threshold
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-xs text-ink-muted">
            Budgets never store actual spend — every figure above is recomputed from the ledger on
            load. Open a budget for its category breakdown, history and approvals.
          </p>
        </>
      )}

      <BudgetFormModal
        isOpen={modalOpen}
        mode="create"
        categoryOptions={categoryOptions}
        onClose={() => setModalOpen(false)}
        onSubmit={createBudget}
      />
    </PageTransition>
  );
}
