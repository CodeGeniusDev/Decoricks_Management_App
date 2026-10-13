import { NextRequest, NextResponse } from 'next/server';
import { ObjectId, type Db } from 'mongodb';
import { authorize } from '@/lib/authorization';
import { getDatabase } from '@/lib/mongodb';
import { getRequestMeta, handleRouteError, withAuth } from '@/lib/http';
import { recordAuditEntry } from '@/lib/audit';
import { successResponse, validationError } from '@/lib/api-response';
import { formatKarachiDate } from '@/lib/date';
import { businessSettingsUpdateSchema } from '@/lib/schemas/finance';
import { parseLedgerDate } from '@/lib/finance-ledger';
import { getBusinessSettingsCollection, getAccountCollection, type BusinessSettings } from '@/lib/models/Ledger';
import { resolveBusinessPolicy, validateProfitSharing, resolveCommentEditWindow } from '@/lib/business-policy';

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
    /*
     * Phase 5. `allowNegativeStock` defaults to false, which is the safe
     * reading: a missing document or a missing field both mean "block". The
     * account ids are surfaced as strings (or null when unset) so the client
     * never has to reason about ObjectId marshalling.
     */
    inventory: {
      allowNegativeStock: settings?.allowNegativeStock === true,
    },
    postingAccounts: {
      purchasingAccountId: settings?.purchasingAccountId ? String(settings.purchasingAccountId) : null,
      salesIncomeAccountId: settings?.salesIncomeAccountId ? String(settings.salesIncomeAccountId) : null,
    },
    /*
     * Phase 6: surfaced as the resolved integer, not the raw field, so the UI
     * can show the effective value (15 by default) even when the Founder has
     * never set it. The `configured` flag lets the tab hint that the setting
     * is still on its default without hiding the number.
     */
    taskComments: {
      editWindowMinutes: resolveCommentEditWindow(settings),
      editWindowConfigured:
        typeof settings?.commentEditWindowMinutes === 'number' &&
        Number.isInteger(settings.commentEditWindowMinutes) &&
        settings.commentEditWindowMinutes >= 0,
    },
  };
}

/** Active accounts the Founder can bind to a Phase 5 flow. */
async function postingAccountOptions(db: Db) {
  const accounts = await getAccountCollection(db)
    .find({ isActive: true })
    .sort({ createdAt: 1 })
    .toArray();
  return accounts.map((account) => ({
    id: String(account._id),
    name: account.name,
    kind: account.kind,
  }));
}

/**
 * Confirm a configured account still exists and is active. Settings are
 * configuration, so a stale id is corrected on save rather than discovered by
 * a purchase failing three days later.
 */
async function isUsableAccount(db: Db, id: string): Promise<boolean> {
  const account = await getAccountCollection(db).findOne({ _id: new ObjectId(id), isActive: true });
  return Boolean(account);
}

/** The settings view plus the account list the Founder can pick from. */
async function settingsView(db: Db, settings: BusinessSettings | null) {
  return { ...settingsPayload(settings), accountOptions: await postingAccountOptions(db) };
}

/**
 * GET /api/finance/settings
 *
 * Business configuration the ledger and the Phase 4/5 engines depend on: the
 * withdrawal lock, the profit-sharing policy, the budget thresholds, the
 * negative-stock guard and the accounts purchases and COD income post to.
 * Reads require `finance.view` (all four roles per SPEC §4.2); writes require
 * `finance.approve` (Founder by default).
 */
async function __GET() {
  try {
    await authorize('finance', 'view');
    const db = await getDatabase();
    const settings = await getBusinessSettingsCollection(db).findOne({ key: 'business' });
    return successResponse(await settingsView(db, settings));
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
 * within 100). Phase 5 adds the inventory/sales configuration on the same
 * document: the negative-stock guard and the accounts purchase expenses and COD
 * income post to. Every change is audited with before/after values; settings
 * are configuration, not financial records, so they are genuinely editable.
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

    /*
     * Phase 5: an account binding is only useful if it survives, so it is
     * checked against live accounts here instead of failing at the next
     * purchase. Empty string and null both mean "clear it" — the flows then
     * fall back to the oldest active account.
     */
    const accountIssues: Array<{ path: string; message: string }> = [];
    for (const [field, label] of [
      ['purchasingAccountId', 'Purchase expense account'],
      ['salesIncomeAccountId', 'Sales income account'],
    ] as const) {
      const value = parsed.data[field];
      if (value) {
        if (!(await isUsableAccount(db, value))) {
          accountIssues.push({ path: field, message: `${label}: choose an existing, active account` });
        }
      }
    }
    if (accountIssues.length > 0) {
      return validationError('Invalid posting account', accountIssues);
    }

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
    if (typeof parsed.data.allowNegativeStock === 'boolean') {
      set.allowNegativeStock = parsed.data.allowNegativeStock;
    }
    if (parsed.data.purchasingAccountId !== undefined) {
      set.purchasingAccountId =
        parsed.data.purchasingAccountId === '' || parsed.data.purchasingAccountId === null
          ? null
          : new ObjectId(parsed.data.purchasingAccountId);
    }
    if (parsed.data.salesIncomeAccountId !== undefined) {
      set.salesIncomeAccountId =
        parsed.data.salesIncomeAccountId === '' || parsed.data.salesIncomeAccountId === null
          ? null
          : new ObjectId(parsed.data.salesIncomeAccountId);
    }
    /*
     * Phase 6: `null` / empty string clears the override and lets the resolver
     * fall back to the 15-minute default. An explicit integer is stored as-is
     * (including 0, meaning "the author cannot edit after posting").
     */
    if (parsed.data.commentEditWindowMinutes !== undefined) {
      set.commentEditWindowMinutes =
        parsed.data.commentEditWindowMinutes === '' || parsed.data.commentEditWindowMinutes === null
          ? undefined
          : parsed.data.commentEditWindowMinutes;
      // `undefined` under $set drops the key entirely — matches the pattern
      // used by the other optional writers in this file.
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
        inventory: before.inventory,
        postingAccounts: before.postingAccounts,
      },
      newValue: {
        withdrawalLockedUntil: after.withdrawalLockedUntil,
        profitSharing: after.profitSharing,
        budgetThresholds: after.budgetThresholds,
        inventory: after.inventory,
        postingAccounts: after.postingAccounts,
      },
      details: [
        next
          ? `Withdrawals locked until ${formatKarachiDate(next, 'date')}`
          : 'Withdrawal lock cleared',
        `Negative stock ${after.inventory.allowNegativeStock ? 'allowed' : 'blocked'}`,
      ].join(' · '),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return NextResponse.json({
      success: true,
      data: await settingsView(db, updated),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const GET = withAuth(__GET);
export const PATCH = withAuth(__PATCH);
