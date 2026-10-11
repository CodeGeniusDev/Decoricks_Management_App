'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { IconPlus, IconTrash } from '@/components/ui/icons';
import { parsePkrAmount } from '@/modules/finance/finance-ui';
import type { BudgetPeriodKindView } from './budget-ui';

/**
 * BudgetFormModal — create and edit share one form (Phase 4 brief item 1).
 *
 * Amounts are typed in PKR and converted to integer paisa on submit; nothing
 * here computes an actual figure — actuals come from the ledger, never from
 * this form. The submit handler receives the validated payload and is
 * responsible for the API call; the returned promise keeps the button in a
 * loading state so a double click cannot double-submit.
 */

export interface BudgetFormValues {
  name: string;
  periodStart: string;
  periodEnd: string;
  /** 'auto' derives the kind from the dates server-side. */
  periodKind: 'auto' | BudgetPeriodKindView;
  categories: { category: string; budgeted: number }[];
}

interface BudgetFormModalProps {
  isOpen: boolean;
  mode: 'create' | 'edit';
  categoryOptions: { value: string; label: string }[];
  initial?: Partial<{
    name: string;
    periodStart: string;
    periodEnd: string;
    categories: { category: string; amount: string }[];
  }>;
  onClose: () => void;
  /** Resolves when the save succeeded; throws to show errors in the modal. */
  onSubmit: (values: BudgetFormValues) => Promise<void>;
}

interface CategoryRow {
  category: string;
  amount: string;
  /** Client-only stable identity for React keys — rows are removed mid-list. */
  rowId: string;
}

export const BudgetFormModal = ({
  isOpen,
  mode,
  categoryOptions,
  initial,
  onClose,
  onSubmit,
}: BudgetFormModalProps) => {
  const [name, setName] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [periodKind, setPeriodKind] = useState<'auto' | BudgetPeriodKindView>('auto');
  const [rows, setRows] = useState<CategoryRow[]>([
    { category: '', amount: '', rowId: crypto.randomUUID() },
  ]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // Re-seed the fields every time the dialog opens, so editing one budget
  // after another can never show the previous document's values.
  useEffect(() => {
    if (!isOpen) return;
    setName(initial?.name ?? '');
    setPeriodStart(initial?.periodStart ?? '');
    setPeriodEnd(initial?.periodEnd ?? '');
    setPeriodKind('auto');
    setRows(
      initial?.categories && initial.categories.length > 0
        ? initial.categories.map((c) => ({ ...c, rowId: crypto.randomUUID() }))
        : [{ category: categoryOptions[0]?.value ?? '', amount: '', rowId: crypto.randomUUID() }]
    );
    setErrors({});
    setFormMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const validate = (): BudgetFormValues | null => {
    const next: Record<string, string> = {};
    if (name.trim().length < 2) next.name = 'Give the budget a name (at least 2 characters)';
    if (!periodStart) next.periodStart = 'Start date is required';
    if (!periodEnd) next.periodEnd = 'End date is required';
    if (periodStart && periodEnd && periodEnd < periodStart)
      next.periodEnd = 'End date must be on or after the start date';

    const seen = new Set<string>();
    const categories: { category: string; budgeted: number }[] = [];
    rows.forEach((row, index) => {
      if (!row.category && !row.amount.trim()) return; // fully blank row is ignored
      if (!row.category) {
        next[`category-${index}`] = 'Pick a category';
        return;
      }
      const key = row.category.toLowerCase();
      if (seen.has(key)) next[`category-${index}`] = 'Duplicate category';
      seen.add(key);
      const parsed = parsePkrAmount(row.amount);
      if (!parsed.ok) {
        next[`amount-${index}`] = parsed.error;
        return;
      }
      if (parsed.paisa <= 0) next[`amount-${index}`] = 'Allocation must be greater than zero';
      categories.push({ category: row.category, budgeted: parsed.paisa });
    });
    if (Object.keys(next).length === 0 && categories.length === 0)
      next['__rows'] = 'Add at least one category allocation';

    setErrors(next);
    if (Object.keys(next).length > 0) return null;
    return { name: name.trim(), periodStart, periodEnd, periodKind, categories };
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (savingRef.current) return;
    const values = validate();
    if (!values) return;

    savingRef.current = true;
    setSaving(true);
    setFormMessage(null);
    try {
      await onSubmit(values);
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not save the budget');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={mode === 'create' ? 'Create budget' : 'Edit budget'}
      description="Allocations per category for the period. Actual spend is calculated from the ledger — it is never typed here."
      size="lg"
      dismissible={!saving}
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {formMessage && (
          <p role="alert" className="rounded-md bg-status-danger-bg px-3 py-2 text-xs text-status-danger">
            {formMessage}
          </p>
        )}

        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          disabled={saving}
          placeholder="e.g. October operating budget"
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Select
            label="Period type"
            value={periodKind}
            onChange={(e) => setPeriodKind(e.target.value as 'auto' | BudgetPeriodKindView)}
            disabled={saving}
            options={[
              { value: 'auto', label: 'Derive from dates' },
              { value: 'weekly', label: 'Weekly (≤ 7 days)' },
              { value: 'monthly', label: 'Monthly (full Karachi month)' },
              { value: 'custom', label: 'Custom' },
            ]}
          />
          <Input
            label="Start (Karachi)"
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            error={errors.periodStart}
            disabled={saving}
          />
          <Input
            label="End (Karachi)"
            type="date"
            value={periodEnd}
            min={periodStart || undefined}
            onChange={(e) => setPeriodEnd(e.target.value)}
            error={errors.periodEnd}
            disabled={saving}
          />
        </div>

        <fieldset className="space-y-2" disabled={saving}>
          <legend className="text-xs font-medium text-ink-secondary">Category allocations (PKR)</legend>
          {errors.__rows && (
            <p className="text-xs text-status-danger" role="alert">
              {errors.__rows}
            </p>
          )}
          {rows.map((row, index) => (
            <div key={row.rowId} className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <div className="flex-1">
                <Select
                  aria-label={`Category ${index + 1}`}
                  value={row.category}
                  onChange={(e) =>
                    setRows((all) => all.map((r, i) => (i === index ? { ...r, category: e.target.value } : r)))
                  }
                  error={errors[`category-${index}`]}
                  options={[
                    { value: '', label: 'Select category…' },
                    ...categoryOptions,
                  ]}
                />
              </div>
              <div className="w-full sm:w-40">
                <Input
                  aria-label={`Allocation in PKR for category ${index + 1}`}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={row.amount}
                  onChange={(e) =>
                    setRows((all) =>
                      all.map((r, i) => (i === index ? { ...r, amount: e.target.value } : r))
                    )
                  }
                  error={errors[`amount-${index}`]}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 self-start sm:self-center"
                onClick={() => setRows((all) => all.filter((_, i) => i !== index))}
                disabled={rows.length === 1}
                aria-label={`Remove category row ${index + 1}`}
              >
                <IconTrash size={16} />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setRows((all) => [
                ...all,
                { category: categoryOptions[0]?.value ?? '', amount: '', rowId: crypto.randomUUID() },
              ])
            }
          >
            <IconPlus size={14} className="mr-1 inline-block align-[-2px]" />
            Add category
          </Button>
        </fieldset>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving} disabled={saving}>
            {mode === 'create' ? 'Create budget' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
