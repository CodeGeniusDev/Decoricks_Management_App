'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { Toast } from '@/components/ui/Toast';
import { apiJson, ApiError } from '@/lib/api-client';
import { useAuth } from '@/components/auth/AuthProvider';
import { can } from '@/lib/permissions-client';
import { fieldIssues } from '@/modules/finance/finance-ui';
import { IconPlus } from '@/components/ui/icons';

/**
 * Business Settings — the configurable policy behind every Phase 4 number
 * (Phase 4 brief item 7).
 *
 * Nothing in the engines hard-codes 20% charity or an 80% warning: they read
 * this document on every run. Until the Founder saves here once, the API
 * reports `policyConfigured: false` and the screens fall back to the SPEC.md
 * defaults — this tab says so out loud instead of pretending the defaults
 * were configured values. Writes require finance.approve (Founder by
 * default); everyone with finance.view can read.
 */

interface PartnerRow {
  name: string;
  percentage: string;
  reinvestPercentage: string;
  userId?: string;
  /** Client-only stable identity for React keys — rows are added/removed mid-list. */
  rowId: string;
}

/** The API shape: integer percentages, not form strings. */
interface ApiPartner {
  name: string;
  percentage: number;
  reinvestPercentage: number;
  userId?: string;
}

interface SettingsView {
  withdrawalLockedUntil: string | null;
  withdrawalLockedUntilDisplay: string | null;
  withdrawalsLocked: boolean;
  profitSharing: { partners: ApiPartner[]; charityPercentage: number };
  budgetThresholds: { warning: number; critical: number };
  policyConfigured: boolean;
}

const toRow = (p: ApiPartner): PartnerRow => ({
  name: p.name,
  percentage: String(p.percentage),
  reinvestPercentage: String(p.reinvestPercentage),
  userId: p.userId,
  rowId: crypto.randomUUID(),
});

const DEFAULT_ROWS: PartnerRow[] = [
  { name: 'Partner 1', percentage: '20', reinvestPercentage: '0', rowId: crypto.randomUUID() },
];

export function BusinessSettingsTab() {
  const { user } = useAuth();
  const canWrite = user ? can({ role: user.role }, 'finance', 'approve') : false;

  const [view, setView] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Form state, seeded from the API on load / save.
  const [partners, setPartners] = useState<PartnerRow[]>(DEFAULT_ROWS);
  const [charity, setCharity] = useState('20');
  const [warning, setWarning] = useState('80');
  const [critical, setCritical] = useState('100');
  const [lockDate, setLockDate] = useState('');
  const [issues, setIssues] = useState<Record<string, string>>({});

  const seed = useCallback((next: SettingsView) => {
    setPartners(next.profitSharing.partners.length > 0 ? next.profitSharing.partners.map(toRow) : DEFAULT_ROWS);
    setCharity(String(next.profitSharing.charityPercentage));
    setWarning(String(next.budgetThresholds.warning));
    setCritical(String(next.budgetThresholds.critical));
    setLockDate(next.withdrawalLockedUntil ?? '');
    setIssues({});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await apiJson<SettingsView>('/api/finance/settings');
      setView(next);
      seed(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load business settings');
    } finally {
      setLoading(false);
    }
  }, [seed]);

  useEffect(() => {
    void load();
  }, [load]);

  const partnerTotal = useMemo(
    () => partners.reduce((sum, p) => sum + (Number.parseInt(p.percentage, 10) || 0), 0),
    [partners]
  );
  const charityValue = Number.parseInt(charity, 10) || 0;

  const validate = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    const names = new Set<string>();
    partners.forEach((partner, index) => {
      const name = partner.name.trim();
      if (!name) errors[`name-${index}`] = 'Name is required';
      else if (names.has(name.toLowerCase())) errors[`name-${index}`] = 'Duplicate partner';
      else names.add(name.toLowerCase());
      for (const [field, value] of [
        ['percentage', partner.percentage],
        ['reinvestPercentage', partner.reinvestPercentage],
      ] as const) {
        const parsed = Number(value);
        if (!/^\d+$/.test(value.trim()) || !Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
          errors[`${field}-${index}`] = 'Whole number 0–100';
        }
      }
    });
    if (partners.length === 0) errors.partners = 'At least one partner is required';
    if (partnerTotal > 100) errors.partners = `Partner percentages sum to ${partnerTotal}% (max 100%)`;
    if (!/^\d+$/.test(charity.trim()) || charityValue < 0 || charityValue > 100) {
      errors.charity = 'Whole number 0–100';
    } else if (partnerTotal + charityValue > 100) {
      errors.charity = `Partners (${partnerTotal}%) + charity (${charityValue}%) exceed 100%`;
    }
    for (const [label, value, key] of [
      ['warning', warning, 'warning'],
      ['critical', critical, 'critical'],
    ] as const) {
      const parsed = Number(value);
      if (!/^\d+$/.test(value.trim()) || parsed < 1 || parsed > 500) {
        errors[key] = `Whole percent 1–500 (${label})`;
      }
    }
    if (!errors.warning && !errors.critical && Number(warning) > Number(critical)) {
      errors.warning = 'Warning must be at or below critical';
    }
    return errors;
  };

  const save = async () => {
    if (savingRef.current) return;
    const local = validate();
    setIssues(local);
    if (Object.keys(local).length > 0) {
      setToast({ type: 'error', message: 'Fix the highlighted fields before saving' });
      return;
    }

    savingRef.current = true;
    setSaving(true);
    try {
      // withdrawalLockedUntil is a required key: '' clears the lock instead of
      // a partial body silently wiping it. The backend validates again — server
      // issues are mapped back onto the same field keys.
      const updated = await apiJson<SettingsView>('/api/finance/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          withdrawalLockedUntil: lockDate || null,
          profitSharing: {
            partners: partners.map((p) => ({
              name: p.name.trim(),
              percentage: Number(p.percentage),
              reinvestPercentage: Number(p.reinvestPercentage),
              ...(p.userId ? { userId: p.userId } : {}),
            })),
            charityPercentage: charityValue,
          },
          budgetThresholds: { warning: Number(warning), critical: Number(critical) },
        }),
      });
      setView(updated);
      seed(updated);
      setToast({ type: 'success', message: 'Business settings saved. Every screen now uses the new policy.' });
    } catch (err) {
      if (err instanceof ApiError) {
        const serverIssues = fieldIssues(err.details);
        if (Object.keys(serverIssues).length > 0) setIssues(serverIssues);
        setToast({ type: 'error', message: err.message });
      } else {
        setToast({ type: 'error', message: 'Could not save business settings' });
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton variant="rect" className="h-40" />
        <Skeleton variant="rect" className="h-64" />
      </div>
    );
  }

  if (error || !view) {
    return (
      <Card>
        <ErrorState
          title="Could not load business settings"
          description={error ?? 'Unknown error.'}
          action={{ label: 'Retry', onClick: () => void load() }}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      {!view.policyConfigured && (
        <Card className="border-status-warning-bg p-4">
          <div className="flex items-start gap-3">
            <Badge variant="warning">Defaults in use</Badge>
            <p className="text-sm text-ink-secondary">
              The Founder has never saved a profit-sharing policy here, so the engines are using the
              SPEC.md defaults. Everything below is live policy the moment it is saved — no numbers in
              the code assume these values.
            </p>
          </div>
        </Card>
      )}

      {!canWrite && (
        <p className="text-sm text-ink-muted">
          You can review the policy; only a Founder can change it.
        </p>
      )}

      <Card className="p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-decoricks-dark">Profit sharing</h2>
          <span
            className={`text-sm tabular-nums ${
              partnerTotal + charityValue <= 100 ? 'text-ink-muted' : 'font-semibold text-status-danger'
            }`}
          >
            Partners {partnerTotal}% + charity {charityValue}% = {partnerTotal + charityValue}%
          </span>
        </div>

        <div className="space-y-3">
          {partners.map((partner, index) => (
            <div
              key={partner.rowId}
              className="grid grid-cols-1 gap-3 rounded-lg border border-line-subtle bg-surface-raised p-3 sm:grid-cols-2 lg:grid-cols-4"
            >
              <div>
                <Input
                  label="Partner name"
                  value={partner.name}
                  readOnly={!canWrite}
                  onChange={(e) =>
                    setPartners((prev) => prev.map((p, i) => (i === index ? { ...p, name: e.target.value } : p)))
                  }
                  error={issues[`name-${index}`]}
                />
              </div>
              <div>
                <Input
                  label="Share of net profit (%)"
                  inputMode="numeric"
                  value={partner.percentage}
                  readOnly={!canWrite}
                  onChange={(e) =>
                    setPartners((prev) =>
                      prev.map((p, i) => (i === index ? { ...p, percentage: e.target.value } : p))
                    )
                  }
                  error={issues[`percentage-${index}`]}
                />
              </div>
              <div>
                <Input
                  label="Reinvest from share (%)"
                  inputMode="numeric"
                  value={partner.reinvestPercentage}
                  readOnly={!canWrite}
                  onChange={(e) =>
                    setPartners((prev) =>
                      prev.map((p, i) => (i === index ? { ...p, reinvestPercentage: e.target.value } : p))
                    )
                  }
                  error={issues[`reinvestPercentage-${index}`]}
                />
              </div>
              <div className="flex items-end gap-2">
                <Input
                  label="Linked user id (optional)"
                  value={partner.userId ?? ''}
                  readOnly={!canWrite}
                  onChange={(e) =>
                    setPartners((prev) =>
                      prev.map((p, i) => (i === index ? { ...p, userId: e.target.value || undefined } : p))
                    )
                  }
                />
                {canWrite && partners.length > 1 && (
                  <Button
                    variant="ghost"
                    onClick={() => setPartners((prev) => prev.filter((_, i) => i !== index))}
                    disabled={saving}
                    aria-label={`Remove ${partner.name || `partner ${index + 1}`}`}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        {issues.partners && <p className="mt-2 text-sm text-status-danger">{issues.partners}</p>}

        {canWrite && (
          <Button
            variant="outline"
            className="mt-3 min-h-11"
            disabled={saving || partners.length >= 12}
            onClick={() =>
              setPartners((prev) => [
                ...prev,
                { name: '', percentage: '0', reinvestPercentage: '0', rowId: crypto.randomUUID() },
              ])
            }
          >
            <IconPlus size={14} className="mr-1 inline-block align-[-2px]" /> Add partner
          </Button>
        )}

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input
            label="Charity (% of net profit)"
            inputMode="numeric"
            value={charity}
            readOnly={!canWrite}
            onChange={(e) => setCharity(e.target.value)}
            error={issues.charity}
          />
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          Percentages are of net profit. Whatever charity and the partners do not take stays as retained
          earnings — the distribution screen proves it adds up to 100% exactly, paisa by paisa.
        </p>
      </Card>

      <Card className="p-4 sm:p-6">
        <h2 className="mb-1 text-lg font-semibold text-decoricks-dark">Budget warnings</h2>
        <p className="mb-4 text-sm text-ink-secondary">
          When spend in a budget category passes these percentages of the allocation, the budget turns a
          warning — now on screen, later in the notification module.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Warning threshold (%)"
            inputMode="numeric"
            value={warning}
            readOnly={!canWrite}
            onChange={(e) => setWarning(e.target.value)}
            error={issues.warning}
          />
          <Input
            label="Critical / over-budget threshold (%)"
            inputMode="numeric"
            value={critical}
            readOnly={!canWrite}
            onChange={(e) => setCritical(e.target.value)}
            error={issues.critical}
          />
        </div>
      </Card>

      <Card className="p-4 sm:p-6">
        <h2 className="mb-1 text-lg font-semibold text-decoricks-dark">Partner withdrawals</h2>
        <p className="mb-4 text-sm text-ink-secondary">
          Lock partner withdrawals until a Karachi date (midnight boundary, same as the ledger). The
          ledger rejects withdrawal entries while the lock is active.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="sm:w-56">
            <Input
              label="Locked until (empty = unlocked)"
              type="date"
              value={lockDate}
              readOnly={!canWrite}
              onChange={(e) => setLockDate(e.target.value)}
            />
          </div>
          <div className="pb-2">
            {view.withdrawalsLocked ? (
              <Badge variant="warning">
                Locked until {view.withdrawalLockedUntilDisplay} (Karachi)
              </Badge>
            ) : lockDate ? (
              <Badge variant="default">Lock set, not enforced yet (future date)</Badge>
            ) : (
              <Badge variant="success">Withdrawals unlocked</Badge>
            )}
          </div>
        </div>
      </Card>

      {canWrite && (
        <div className="flex justify-end">
          <Button onClick={() => void save()} loading={saving} disabled={saving}>
            Save business settings
          </Button>
        </div>
      )}
    </div>
  );
}
