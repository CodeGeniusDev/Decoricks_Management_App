'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ApiError, apiJson } from '@/lib/api-client';
import { useAuth } from '@/components/auth/AuthProvider';
import { enqueueCreate } from '@/lib/offline/browser';
import type { FinanceCreatePayload } from '@/lib/offline/types';
import { ENTRY_TYPE_LABELS, LEDGER_ENTRY_TYPES, SINGLE_ACCOUNT_TYPES } from '@/lib/finance';
import type { LedgerEntryType } from '@/lib/finance';
import {
  PAYMENT_METHODS,
  fieldIssues,
  karachiToday,
  newIdempotencyKey,
  parsePkrAmount,
  type AccountView,
  type CategoryView,
  type EntryView,
  type PartnerView,
} from './finance-ui';

interface EntryFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  accounts: AccountView[];
  categories: CategoryView[];
  partners: PartnerView[];
  /** Withdrawals need `finance.approve` — hidden for roles without it. */
  canApprove: boolean;
  /** Lock state from the server; the create API rejects regardless. */
  withdrawalsLocked: boolean;
  lockedUntilDisplay: string | null;
  initialType?: LedgerEntryType;
  onCreated: (entry: EntryView, replayed: boolean) => void;
  /** Entry stored in the offline queue instead of the server (design §6.1). */
  onQueued?: () => void;
}

/**
 * EntryFormModal — create a ledger entry.
 *
 * Double submits are prevented twice: the button disables while a request is in
 * flight, and a ref guard rejects a second `submit()` from a fast click that
 * beats React's re-render. The idempotency key is generated when the modal
 * opens and kept across failed attempts, so a retry after a network drop can
 * never create a duplicate; a fresh key is minted only after a success.
 */
export const EntryFormModal = ({
  isOpen,
  onClose,
  accounts,
  categories,
  partners,
  canApprove,
  withdrawalsLocked,
  lockedUntilDisplay,
  initialType = 'income',
  onCreated,
  onQueued,
}: EntryFormModalProps) => {
  const { user } = useAuth();
  const [type, setType] = useState<LedgerEntryType>(initialType);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [accountId, setAccountId] = useState('');
  const [fromAccountId, setFromAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [category, setCategory] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [note, setNote] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submittingRef = useRef(false);
  const idempotencyKeyRef = useRef<string>('');

  // Reset the session whenever the modal opens: fresh fields, fresh key.
  useEffect(() => {
    if (!isOpen) return;
    setType(initialType);
    setAmount('');
    setDate(karachiToday());
    setAccountId('');
    setFromAccountId('');
    setToAccountId('');
    setCategory('');
    setPartnerId('');
    setPaymentMethod('');
    setNote('');
    setErrors({});
    setFormError(null);
    idempotencyKeyRef.current = newIdempotencyKey();
  }, [isOpen, initialType]);

  const needsSingleAccount = SINGLE_ACCOUNT_TYPES.has(type);
  const needsCategory = type === 'income' || type === 'expense';
  const needsPartner = type === 'partner_capital' || type === 'partner_withdrawal';

  const visibleCategories = categories.filter(
    (c) => c.isActive && (needsCategory ? c.type === type : false)
  );
  const activeAccounts = accounts.filter((a) => a.isActive);

  const accountOptions = activeAccounts.map((a) => ({ value: a._id, label: a.name }));

  const buildPayload = useCallback((): Record<string, unknown> | null => {
    const local: Record<string, string> = {};
    const parsedAmount = parsePkrAmount(amount);
    if (!parsedAmount.ok) local.amount = parsedAmount.error;
    if (!date) local.date = 'Date is required';

    if (needsSingleAccount && !accountId) local.accountId = 'Select an account';
    if (type === 'transfer') {
      if (!fromAccountId) local.fromAccountId = 'Select the source account';
      if (!toAccountId) local.toAccountId = 'Select the destination account';
      if (fromAccountId && toAccountId && fromAccountId === toAccountId) {
        local.toAccountId = 'Must differ from the source account';
      }
    }
    if (needsCategory && !category) local.category = 'Select a category';

    setErrors(local);
    if (Object.keys(local).length > 0 || !parsedAmount.ok) return null;

    const base: Record<string, unknown> = {
      type,
      amount: parsedAmount.paisa,
      date,
      note: note.trim() || undefined,
      idempotencyKey: idempotencyKeyRef.current,
    };

    if (type === 'transfer') {
      base.fromAccountId = fromAccountId;
      base.toAccountId = toAccountId;
      return base;
    }

    if (needsSingleAccount) base.accountId = accountId;
    if (needsCategory) base.category = category;
    if (needsPartner && partnerId) {
      base.partnerId = partnerId;
      const partner = partners.find((p) => p._id === partnerId);
      if (partner) base.partnerName = partner.name;
    }
    if (paymentMethod) base.paymentMethod = paymentMethod;
    return base;
  }, [
    type,
    amount,
    date,
    accountId,
    fromAccountId,
    toAccountId,
    category,
    partnerId,
    paymentMethod,
    note,
    needsSingleAccount,
    needsCategory,
    needsPartner,
    partners,
  ]);

  const handleSubmit = async () => {
    // Ref guard: a second click can arrive before React disables the button.
    if (submittingRef.current) return;
    const payload = buildPayload();
    if (!payload) return;

    submittingRef.current = true;
    setSubmitting(true);
    setFormError(null);

    // Offline path (design §6.1): the entry goes to the local queue instead,
    // carrying the key this modal session already minted — an online attempt
    // that died mid-network and this queued row share ONE key, so the server
    // can only ever produce one entry. No queue row without a signed-in user.
    const queueCurrentEntry = async (): Promise<boolean> => {
      if (!user?._id) return false;
      await enqueueCreate({
        userId: user._id,
        operation: 'create_finance',
        payload: payload as unknown as FinanceCreatePayload,
        idempotencyKey: idempotencyKeyRef.current,
      });
      onQueued?.();
      onClose();
      return true;
    };

    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (await queueCurrentEntry()) return;
      }
      const entry = await apiJson<EntryView>('/api/finance/transactions', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      // Success (or an idempotent replay): mint a new key so the next open of
      // the same session is a genuinely new entry.
      idempotencyKeyRef.current = newIdempotencyKey();
      onCreated(entry, false);
      onClose();
    } catch (error) {
      if (error instanceof ApiError) {
        const issues = fieldIssues(error.details);
        if (Object.keys(issues).length > 0) setErrors(issues);
        setFormError(
          error.code === 'WITHDRAWALS_LOCKED'
            ? error.message
            : error.isForbidden
              ? 'You do not have permission to create transactions here.'
              : error.message || 'Could not save the transaction.'
        );
      } else if (await queueCurrentEntry()) {
        // Connection blip after we thought we were online: queue the draft
        // rather than drop it ("never lose an entry" §6). The engine retries
        // it on reconnect exactly like a genuinely offline entry.
        return;
      } else {
        setFormError(
          'Could not reach the server. Your entry was not saved — press Save again to retry.'
        );
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const typeOptions = LEDGER_ENTRY_TYPES.filter(
    (t) => t !== 'partner_withdrawal' || canApprove
  ).map((t) => ({ value: t, label: ENTRY_TYPE_LABELS[t] }));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="New transaction"
      description="Posted entries are permanent — mistakes are corrected with a linked reversal."
      size="md"
      dismissible={!submitting}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={submitting} disabled={submitting}>
            Save transaction
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

        <Select
          label="Type"
          value={type}
          onChange={(e) => {
            setType(e.target.value as LedgerEntryType);
            setErrors({});
          }}
          options={typeOptions}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Amount (PKR)"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={errors.amount}
          />
          <Input
            label="Date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            error={errors.date}
          />
        </div>

        {type === 'transfer' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label="From account"
              value={fromAccountId}
              onChange={(e) => setFromAccountId(e.target.value)}
              options={[{ value: '', label: 'Select account…' }, ...accountOptions]}
              error={errors.fromAccountId}
            />
            <Select
              label="To account"
              value={toAccountId}
              onChange={(e) => setToAccountId(e.target.value)}
              options={[{ value: '', label: 'Select account…' }, ...accountOptions]}
              error={errors.toAccountId}
            />
            <p className="sm:col-span-2 -mt-1 text-xs text-ink-muted">
              Transfers move money between your own accounts. They never count as income or expense.
            </p>
          </div>
        ) : type === 'reinvestment' ? (
          <p className="text-xs text-ink-muted">
            Reinvestment records profit retained in the business. It does not move money between
            accounts and never affects cash flow.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <Select
              label={type === 'partner_withdrawal' ? 'Paid from account' : 'Account'}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              options={[{ value: '', label: 'Select account…' }, ...accountOptions]}
              error={errors.accountId}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {needsCategory && (
                <Select
                  label="Category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  options={[
                    { value: '', label: 'Select category…' },
                    ...visibleCategories.map((c) => ({ value: c.name, label: c.label })),
                  ]}
                  error={errors.category}
                />
              )}
              {needsPartner && (
                <Select
                  label="Partner"
                  value={partnerId}
                  onChange={(e) => setPartnerId(e.target.value)}
                  options={[
                    { value: '', label: 'Select partner…' },
                    ...partners.map((p) => ({ value: p._id, label: p.name })),
                  ]}
                  error={errors.partnerId}
                />
              )}
              <Select
                label="Payment method"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                options={[{ value: '', label: 'Not specified' }, ...PAYMENT_METHODS]}
                error={errors.paymentMethod}
              />
            </div>
          </div>
        )}

        {type === 'partner_withdrawal' && withdrawalsLocked && lockedUntilDisplay && (
          <p className="rounded-md bg-status-warning-bg px-3 py-2 text-xs text-status-warning">
            Withdrawals are locked until {lockedUntilDisplay}. The server will reject this entry
            while the lock is active.
          </p>
        )}

        <Textarea
          label="Note"
          rows={3}
          maxLength={1000}
          placeholder="What was this for?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          error={errors.note}
        />
      </div>
    </Modal>
  );
};
