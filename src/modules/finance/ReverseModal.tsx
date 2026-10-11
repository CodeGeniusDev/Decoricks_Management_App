'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { Badge } from '@/components/ui/Badge';
import { ApiError, apiJson } from '@/lib/api-client';
import { ENTRY_TYPE_LABELS } from '@/lib/finance';
import { formatKarachiDate } from '@/lib/date';
import { fieldIssues, newIdempotencyKey, type EntryView } from './finance-ui';

interface ReverseModalProps {
  entry: EntryView | null;
  onClose: () => void;
  onReversed: (reversal: EntryView) => void;
}

/**
 * ReverseModal — explicit confirmation before posting a reversal.
 *
 * Reversing is the only correction path (SPEC §10.2.3 Test 9: no silent edits,
 * no hard deletes), so the dialog repeats what will be cancelled and keeps the
 * original on screen afterwards, marked Reversed. The idempotency key survives
 * failed attempts for the same entry so a retry cannot double-post.
 */
export const ReverseModal = ({ entry, onClose, onReversed }: ReverseModalProps) => {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submittingRef = useRef(false);
  const idempotencyKeyRef = useRef<string>('');

  useEffect(() => {
    if (entry) {
      setReason('');
      setError(null);
      idempotencyKeyRef.current = `rev-${entry._id}-${newIdempotencyKey()}`;
    }
  }, [entry]);

  if (!entry) return null;

  const handleConfirm = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      const reversal = await apiJson<EntryView>(`/api/finance/transactions/${entry._id}/reverse`, {
        method: 'POST',
        body: JSON.stringify({
          reason: reason.trim() || undefined,
          idempotencyKey: idempotencyKeyRef.current,
        }),
      });
      onReversed(reversal);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = fieldIssues(err.details);
        setError(
          Object.values(issues)[0] ??
            (err.code === 'ALREADY_REVERSED'
              ? err.message
              : err.isForbidden
                ? 'Only an approver can reverse transactions.'
                : err.message || 'Could not reverse the transaction.')
        );
      } else {
        setError('Could not reach the server. Press Confirm again to retry.');
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Reverse this transaction?"
      description="The original stays in the ledger, marked as reversed. A mirror entry is appended and audited."
      size="sm"
      dismissible={!submitting}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={handleConfirm}
            loading={submitting}
            disabled={submitting}
          >
            Confirm reversal
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-line bg-surface-sunken px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <Badge size="sm">{ENTRY_TYPE_LABELS[entry.type]}</Badge>
            <span className="font-semibold text-decoricks-dark">{entry.amountDisplay}</span>
          </div>
          <p className="mt-1.5 text-xs text-ink-muted">
            {formatKarachiDate(new Date(entry.date), 'date')} ·{' '}
            {entry.type === 'transfer'
              ? `${entry.fromAccountName ?? '?'} → ${entry.toAccountName ?? '?'}`
              : (entry.accountName ?? entry.categoryLabel ?? '—')}
            {entry.partnerName ? ` · ${entry.partnerName}` : ''}
          </p>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger"
          >
            {error}
          </p>
        )}

        <Textarea
          label="Reason (optional)"
          rows={2}
          maxLength={500}
          placeholder="Why is this being reversed?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={submitting}
        />
      </div>
    </Modal>
  );
};
