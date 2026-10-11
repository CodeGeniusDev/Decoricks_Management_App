'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { Toast } from '@/components/ui/Toast';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { apiJson, ApiError } from '@/lib/api-client';
import { useAuth } from '@/components/auth/AuthProvider';
import { can } from '@/lib/permissions-client';
import { ACCOUNT_KIND_LABELS, ACCOUNT_KINDS } from '@/lib/finance';
import type { AccountKind } from '@/lib/finance';
import { formatPaisa } from '@/lib/money';
import {
  fieldIssues,
  paisaToInputValue,
  parsePkrAmount,
  type AccountView,
} from '@/modules/finance/finance-ui';

interface AccountFormState {
  _id?: string;
  name: string;
  kind: AccountKind;
  openingBalance: string;
  isActive: boolean;
  note: string;
}

const EMPTY_FORM: AccountFormState = {
  name: '',
  kind: 'cash',
  openingBalance: '0.00',
  isActive: true,
  note: '',
};

export default function FinanceAccountsPage() {
  const { user } = useAuth();
  const canManage = user ? can({ role: user.role }, 'finance', 'approve') : false;

  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<AccountFormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiJson<{ accounts: AccountView[] }>('/api/finance/accounts');
      setAccounts(data.accounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setErrors({});
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (account: AccountView) => {
    setForm({
      _id: account._id,
      name: account.name,
      kind: account.kind,
      openingBalance: paisaToInputValue(account.openingBalance),
      isActive: account.isActive,
      note: account.note ?? '',
    });
    setErrors({});
    setFormError(null);
    setFormOpen(true);
  };

  const handleSubmit = async () => {
    if (savingRef.current) return;

    const local: Record<string, string> = {};
    if (!form.name.trim()) local.name = 'Name is required';
    const parsedAmount = parsePkrAmount(form.openingBalance || '0');
    if (!parsedAmount.ok) local.openingBalance = parsedAmount.error;
    setErrors(local);
    if (Object.keys(local).length > 0 || !parsedAmount.ok) return;

    savingRef.current = true;
    setSaving(true);
    setFormError(null);

    const body = {
      name: form.name.trim(),
      kind: form.kind,
      openingBalance: parsedAmount.paisa,
      ...(form._id ? { isActive: form.isActive } : {}),
      note: form.note.trim() || undefined,
    };

    try {
      if (form._id) {
        await apiJson(`/api/finance/accounts/${form._id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        setToast({ type: 'success', message: `Account "${form.name.trim()}" updated` });
      } else {
        await apiJson('/api/finance/accounts', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        setToast({ type: 'success', message: `Account "${form.name.trim()}" created` });
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = fieldIssues(err.details);
        if (Object.keys(issues).length > 0) setErrors(issues);
        setFormError(
          err.code === 'DUPLICATE'
            ? 'An account with that name already exists.'
            : err.isForbidden
              ? 'Only the Founder can create or edit accounts.'
              : err.message || 'Could not save the account.'
        );
      } else {
        setFormError('Could not reach the server. Press Save again to retry.');
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const columns = [
    { key: 'name', label: 'Account' },
    { key: 'kind', label: 'Kind' },
    { key: 'opening', label: 'Opening balance' },
    { key: 'balance', label: 'Current balance' },
    { key: 'status', label: 'Status' },
    ...(canManage ? [{ key: 'actions', label: 'Actions' }] : []),
  ];

  return (
    <PageTransition>
      <PageHeader
        title="Accounts"
        description="Manual cash, bank and wallet accounts. No bank integration — balances are computed from the ledger."
        actions={canManage ? <Button onClick={openCreate}>Add account</Button> : undefined}
      />

      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      <Card>
        {loading ? (
          <div className="p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} variant="rect" className="mb-2 h-12" />
            ))}
          </div>
        ) : error ? (
          <ErrorState
            title="Could not load accounts"
            description={error}
            action={{ label: 'Retry', onClick: () => void load() }}
          />
        ) : accounts.length === 0 ? (
          <EmptyState
            title="No accounts yet"
            description="Create a Cash, Bank or Wallet account to start recording transactions."
            action={canManage ? { label: 'Add account', onClick: openCreate } : undefined}
          />
        ) : (
          <>
            <div className="hidden md:block">
              <Table
                caption="Finance accounts"
                columns={columns}
                data={accounts.map((account) => ({
                  _id: account._id,
                  name: (
                    <span className="font-medium text-decoricks-dark">
                      {account.name}
                      {account.note ? (
                        <span className="ml-2 text-xs text-ink-muted">{account.note}</span>
                      ) : null}
                    </span>
                  ),
                  kind: <Badge size="sm">{account.kindLabel}</Badge>,
                  opening: <span className="tabular-nums">{account.openingBalanceDisplay}</span>,
                  balance: (
                    <span className="font-semibold tabular-nums text-decoricks-dark">
                      {account.balanceDisplay}
                    </span>
                  ),
                  status: account.isActive ? (
                    <Badge variant="success" size="sm">
                      Active
                    </Badge>
                  ) : (
                    <Badge size="sm">Inactive</Badge>
                  ),
                  actions: canManage ? (
                    <Button variant="ghost" size="sm" onClick={() => openEdit(account)}>
                      Edit
                    </Button>
                  ) : null,
                }))}
                rowKey="_id"
              />
            </div>
            <ul className="divide-y divide-line-subtle md:hidden">
              {accounts.map((account) => (
                <li key={account._id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-decoricks-dark">
                        {account.name}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {account.kindLabel} · opening {account.openingBalanceDisplay}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-base font-semibold tabular-nums text-decoricks-dark">
                        {account.balanceDisplay}
                      </p>
                      <Badge size="sm" variant={account.isActive ? 'success' : 'default'}>
                        {account.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>
                  </div>
                  {canManage && (
                    <div className="mt-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(account)}>
                        Edit
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="px-4 pb-3 pt-1 text-xs text-ink-muted">
              Total cash across accounts:{' '}
              <span className="font-semibold">
                {formatPaisa(accounts.reduce((sum, a) => sum + a.balance, 0))}
              </span>
            </p>
          </>
        )}
      </Card>

      <div className="mt-4 flex gap-2 text-sm">
        <Link href="/finance" className="text-decoricks-brown hover:underline">
          ← Finance overview
        </Link>
      </div>

      <Modal
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        title={form._id ? 'Edit account' : 'Add account'}
        description={
          form._id
            ? 'Changing the opening balance re-computes the current balance from the ledger.'
            : 'Accounts are manual records of where the business keeps money.'
        }
        size="sm"
        dismissible={!saving}
        footer={
          <>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void handleSubmit()} loading={saving} disabled={saving}>
              Save account
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {formError && (
            <p
              role="alert"
              className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger"
            >
              {formError}
            </p>
          )}
          <Input
            label="Name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            error={errors.name}
            placeholder="e.g. Cash at shop"
          />
          <Select
            label="Kind"
            value={form.kind}
            onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as AccountKind }))}
            options={ACCOUNT_KINDS.map((k) => ({ value: k, label: ACCOUNT_KIND_LABELS[k] }))}
            error={errors.kind}
          />
          <Input
            label="Opening balance (PKR)"
            inputMode="decimal"
            value={form.openingBalance}
            onChange={(e) => setForm((f) => ({ ...f, openingBalance: e.target.value }))}
            error={errors.openingBalance}
          />
          {form._id && (
            <Checkbox
              label="Account is active"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
            />
          )}
          <Textarea
            label="Note"
            rows={2}
            maxLength={500}
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            error={errors.note}
          />
        </div>
      </Modal>
    </PageTransition>
  );
}
