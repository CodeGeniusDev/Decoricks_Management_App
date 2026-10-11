'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { PageTransition } from '@/components/PageTransition';
import { PageHeader } from '@/components/layout/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Toast } from '@/components/ui/Toast';
import { Modal } from '@/components/ui/Modal';
import { Checkbox } from '@/components/ui/Checkbox';
import { apiJson, ApiError } from '@/lib/api-client';
import { useAuth } from '@/components/auth/AuthProvider';
import { can } from '@/lib/permissions-client';
import { fieldIssues, type CategoryView } from '@/modules/finance/finance-ui';

interface CategoryFormState {
  _id?: string;
  name: string;
  label: string;
  type: 'expense' | 'income';
  isActive: boolean;
}

const EMPTY_FORM: CategoryFormState = {
  name: '',
  label: '',
  type: 'expense',
  isActive: true,
};

/** Derive the stable slug from the label; the API enforces `^[a-z0-9_]+$`. */
const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export default function FinanceCategoriesPage() {
  const { user } = useAuth();
  const canManage = user ? can({ role: user.role }, 'finance', 'approve') : false;

  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<CategoryFormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCategories(await apiJson<CategoryView[]>('/api/finance/categories'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load categories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = (type: 'expense' | 'income') => {
    setForm({ ...EMPTY_FORM, type });
    setErrors({});
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (category: CategoryView) => {
    setForm({
      _id: category._id,
      name: category.name,
      label: category.label,
      type: category.type,
      isActive: category.isActive,
    });
    setErrors({});
    setFormError(null);
    setFormOpen(true);
  };

  const handleSubmit = async () => {
    if (savingRef.current) return;

    const local: Record<string, string> = {};
    if (!form.label.trim()) local.label = 'Label is required';
    if (!form._id && !slugify(form.label)) {
      local.name = 'Label must contain letters or numbers to form a slug';
    }
    setErrors(local);
    if (Object.keys(local).length > 0) return;

    savingRef.current = true;
    setSaving(true);
    setFormError(null);

    try {
      if (form._id) {
        await apiJson(`/api/finance/categories/${form._id}`, {
          method: 'PATCH',
          body: JSON.stringify({ label: form.label.trim(), isActive: form.isActive }),
        });
        setToast({ type: 'success', message: `Category "${form.label.trim()}" updated` });
      } else {
        await apiJson('/api/finance/categories', {
          method: 'POST',
          body: JSON.stringify({
            name: slugify(form.label),
            label: form.label.trim(),
            type: form.type,
          }),
        });
        setToast({ type: 'success', message: `Category "${form.label.trim()}" created` });
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = fieldIssues(err.details);
        if (Object.keys(issues).length > 0) setErrors(issues);
        setFormError(
          err.code === 'DUPLICATE'
            ? 'A category with that slug already exists.'
            : err.isForbidden
              ? 'Only the Founder can manage categories.'
              : err.message || 'Could not save the category.'
        );
      } else {
        setFormError('Could not reach the server. Press Save again to retry.');
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const renderGroup = (title: string, type: 'expense' | 'income') => {
    const items = categories.filter((c) => c.type === type);
    return (
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-decoricks-dark">{title}</h2>
          {canManage && (
            <Button variant="outline" size="sm" onClick={() => openCreate(type)}>
              Add {type} category
            </Button>
          )}
        </div>
        {items.length === 0 ? (
          <EmptyState
            title={`No ${type} categories`}
            description="Add one to make it selectable on entries."
          />
        ) : (
          <ul className="divide-y divide-line-subtle">
            {items.map((category) => (
              <li key={category._id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-decoricks-dark">
                    {category.label}
                    {!category.isActive && (
                      <span className="ml-2">
                        <Badge size="sm">Inactive</Badge>
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-ink-muted">{category.name}</p>
                </div>
                {canManage && (
                  <Button variant="ghost" size="sm" onClick={() => openEdit(category)}>
                    Edit
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  };

  return (
    <PageTransition>
      <PageHeader
        title="Categories"
        description={
          canManage
            ? 'Seeded from SPEC Appendix A. Rename the label or deactivate; the stored slug never changes so history stays linked.'
            : 'Seeded from SPEC Appendix A. Only the Founder can edit categories — this view is read-only.'
        }
      />

      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton variant="rect" className="h-64" />
          <Skeleton variant="rect" className="h-64" />
        </div>
      ) : error ? (
        <Card>
          <ErrorState
            title="Could not load categories"
            description={error}
            action={{ label: 'Retry', onClick: () => void load() }}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {renderGroup('Expense categories', 'expense')}
          {renderGroup('Income categories', 'income')}
        </div>
      )}

      <div className="mt-4 flex gap-2 text-sm">
        <Link href="/finance" className="text-decoricks-brown hover:underline">
          ← Finance overview
        </Link>
      </div>

      <Modal
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        title={form._id ? 'Edit category' : `New ${form.type} category`}
        description={
          form._id
            ? 'The slug stays fixed because posted entries reference it. Rename the label freely.'
            : 'The slug is derived from the label and is what transactions store.'
        }
        size="sm"
        dismissible={!saving}
        footer={
          <>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void handleSubmit()} loading={saving} disabled={saving}>
              Save category
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
            label="Label"
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            error={errors.label ?? errors.name}
            placeholder="e.g. Meta Ads"
          />
          {!form._id ? (
            <>
              <Select
                label="Type"
                value={form.type}
                onChange={(e) =>
                  setForm((f) => ({ ...f, type: e.target.value as 'expense' | 'income' }))
                }
                options={[
                  { value: 'expense', label: 'Expense' },
                  { value: 'income', label: 'Income' },
                ]}
              />
              <p className="text-xs text-ink-muted">
                Stored slug: <code className="font-mono">{slugify(form.label) || '—'}</code>
              </p>
            </>
          ) : (
            <Checkbox
              label="Category is active"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
            />
          )}
        </div>
      </Modal>
    </PageTransition>
  );
}
