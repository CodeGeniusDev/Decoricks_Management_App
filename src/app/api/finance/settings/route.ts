import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { authorize } from '@/lib/authorization';
import { getDatabase } from '@/lib/mongodb';
import { getRequestMeta, handleRouteError, withAuth } from '@/lib/http';
import { recordAuditEntry } from '@/lib/audit';
import { successResponse, validationError } from '@/lib/api-response';
import { formatKarachiDate } from '@/lib/date';
import { businessSettingsUpdateSchema } from '@/lib/schemas/finance';
import { parseLedgerDate } from '@/lib/finance-ledger';
import { getBusinessSettingsCollection, type BusinessSettings } from '@/lib/models/Ledger';
import { resolveBusinessPolicy, validateProfitSharing } from '@/lib/business-policy';

/** The Phase 4 slice of the settings document the UI and engines read. */
function settingsPayload(settings: BusinessSettings | null) {
  const policy = resolveBusinessPolicy(settings);
  const lock = settings?.withdrawalLockedUntil ?? null;
  return {
    withdrawalLockedUntil: lock ? lock.toISOString() : null,
    withdrawalLockedUntilDisplay: lock ? formatKarachiDate(lock, 'date') : null,
    withdrawalsLocked: lock ? Date.now() < lock.getTime() : false,
    profitSharing: {
      partners: policy.partners,
      charityPercentage: policy.charityPercentage,
    },
    budgetThresholds: policy.budgetThresholds,
    /** False while the Founder has never saved a real policy — the UI says so. */
    policyConfigured: policy.configured,
  };
}

/**
 * GET /api/finance/settings
 *
 * Business configuration the ledger and the Phase 4 engines depend on: the
 * withdrawal lock, the profit-sharing policy and the budget thresholds. Reads
 * require `finance.view` (all four roles per SPEC §4.2); writes require
 * `finance.approve` (Founder by default).
 */
async function __GET() {
  try {
    await authorize('finance', 'view');
    const db = await getDatabase();
    const settings = await getBusinessSettingsCollection(db).findOne({ key: 'business' });
    return successResponse(settingsPayload(settings));
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * PATCH /api/finance/settings
 *
 * Sets or clears `withdrawalLockedUntil`, and (Phase 4) replaces the
 * profit-sharing policy and budget thresholds. A `YYYY-MM-DD` lock value is
 * interpreted as Karachi midnight — the same boundary the ledger uses
 * everywhere else — so "locked until 2027-02-04" blocks withdrawals through
 * 2027-02-03 and allows them from 2027-02-04 onwards. The percentages are
 * validated against SPEC §3.2 (partner sums ≤ 100, charity keeps the total
 * within 100). Every change is audited with before/after values; settings are
 * configuration, not financial records, so they are genuinely editable.
 */
async function __PATCH(request: NextRequest) {
  try {
    const auth = await authorize('finance', 'approve');

    const parsed = businessSettingsUpdateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        }))
      );
    }

    const raw = parsed.data.withdrawalLockedUntil;
    const next = raw === null || raw === '' ? null : parseLedgerDate(raw);
    if (next && Number.isNaN(next.getTime())) {
      return validationError('Invalid date', [
        { path: 'withdrawalLockedUntil', message: 'Date could not be parsed' },
      ]);
    }

    if (parsed.data.profitSharing) {
      const issues = validateProfitSharing(parsed.data.profitSharing);
      if (issues.length > 0) {
        return validationError(
          'Invalid profit-sharing policy',
          issues.map((message) => ({ path: 'profitSharing', message }))
        );
      }
    }

    if (parsed.data.budgetThresholds) {
      const { warning, critical } = parsed.data.budgetThresholds;
      if (warning > critical) {
        return validationError('Invalid budget thresholds', [
          {
            path: 'budgetThresholds.warning',
            message: 'The warning threshold must be at or below the critical threshold',
          },
        ]);
      }
    }

    const db = await getDatabase();
    const collection = getBusinessSettingsCollection(db);
    const settings = await collection.findOne({ key: 'business' });
    const before = settingsPayload(settings);

    const set: Record<string, unknown> = {
      withdrawalLockedUntil: next ?? undefined,
      updatedAt: new Date(),
      updatedBy: auth.user._id as ObjectId,
    };
    if (parsed.data.profitSharing) {
      set.profitSharing = {
        partners: parsed.data.profitSharing.partners.map((partner) => ({
          ...partner,
          userId: partner.userId?.trim() || undefined,
        })),
        charityPercentage: parsed.data.profitSharing.charityPercentage,
      };
    }
    if (parsed.data.budgetThresholds) {
      set.budgetThresholds = parsed.data.budgetThresholds;
    }

    await collection.updateOne(
      { key: 'business' },
      { $set: set, $setOnInsert: { key: 'business', createdAt: new Date() } },
      { upsert: true }
    );

    const updated = await collection.findOne({ key: 'business' });
    const after = settingsPayload(updated);

    const meta = await getRequestMeta();
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'business_settings_updated',
      entityType: 'finance',
      entityId: null,
      oldValue: {
        withdrawalLockedUntil: before.withdrawalLockedUntil,
        profitSharing: before.profitSharing,
        budgetThresholds: before.budgetThresholds,
      },
      newValue: {
        withdrawalLockedUntil: after.withdrawalLockedUntil,
        profitSharing: after.profitSharing,
        budgetThresholds: after.budgetThresholds,
      },
      details: next
        ? `Withdrawals locked until ${formatKarachiDate(next, 'date')}`
        : 'Withdrawal lock cleared',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return NextResponse.json({ success: true, data: after, timestamp: new Date().toISOString() });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const GET = withAuth(__GET);
export const PATCH = withAuth(__PATCH);
