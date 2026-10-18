import type { Db } from 'mongodb'
import { ObjectId } from 'mongodb'
import { getBudgetCollection, type Budget } from '@/lib/models/Operations'
import { getBusinessSettingsCollection } from '@/lib/models/Ledger'
import type { StockSummaryItem } from '@/lib/stock-summary'
import { buildStockSummary } from '@/lib/stock-summary'
import { fetchLedgerExpenses, loadBudgetThresholds } from '@/lib/budget-queries'
import { budgetPeriodRange, computeBudgetActuals } from '@/lib/budget-actuals'
import type { LedgerEntryType } from '@/lib/finance'
import { formatPaisa, formatPkr, pkrToPaisa } from '@/lib/money'
import { formatKarachiDate } from '@/lib/date'
import { emitToAllEligible, emitToUsers, getFounderUserIds } from './emit'
import {
  budgetCriticalKey,
  budgetWarningKey,
  financialEventKey,
  lowStockKey,
  pendingApprovalKey,
  syncConflictKey,
  syncFailureKey,
  taskDueSoonKey,
  taskOverdueKey,
} from './dedupe'

/**
 * Phase 9 event catalogues (design §2.4).
 *
 * Every function here is a thin, typed wrapper over `emitNotification` that
 * supplies the human copy and — crucially — the DEDUPE KEY, so call sites in the
 * write routes stay one line and can never invent a subtly different key that
 * would defeat dedup. NONE of them re-implement business math: budget crossings
 * come from `computeBudgetActuals` (the exact engine the dashboard uses) and low
 * stock from `buildStockSummary` (the exact source of the dashboard's count).
 *
 * They are all best-effort and never throw into the caller's transaction: a
 * notification refusing to send must never fail a successful write.
 */

/* ------------------------------ low stock -------------------------------- */

/**
 * Emit a low-stock alert for products the given summary marks low. Called after
 * a stock write (targeted, via `productId`) and by the daily sweep (whole
 * catalogue). The dedupe key is per product per Karachi day, so re-running the
 * whole catalogue every sweep costs nothing for products already alerted today.
 */
export async function notifyLowStock(db: Db, items: StockSummaryItem[]): Promise<number> {
  let emitted = 0
  for (const item of items.filter((i) => i.lowStock)) {
    emitted += await emitToAllEligible(db, {
      type: 'low_stock',
      dedupeKey: lowStockKey(item._id),
      title: `Low stock: ${item.name}`,
      message:
        item.reorderLevel !== null
          ? `${item.totalAvailable} unit(s) left (reorder level ${item.reorderLevel})`
          : `${item.totalAvailable} unit(s) left`,
      data: { entityType: 'product', entityId: item._id, link: `/inventory?product=${item._id}` },
    })
  }
  return emitted
}

/** Convenience for a stock write on one product. */
export async function notifyLowStockForProduct(db: Db, productId: string): Promise<number> {
  const summary = await buildStockSummary(db, { productId }).catch(() => null)
  if (!summary) return 0
  return notifyLowStock(db, summary.items)
}

/* --------------------------- budget crossings ---------------------------- */

/**
 * Recompute the categories of one budget and emit warning / critical crossings.
 * Uses `computeBudgetActuals` — the SAME engine the dashboard and reconciliation
 * read — so a notification can never disagree with what the screen shows.
 *
 * Warning dedupes per crossing bucket (the rounded 10-percent band), so 80%→89%
 * stays one alert but a genuine move into the 90s or across critical re-alerts.
 * Critical is a one-shot per budget+category.
 */
export async function notifyBudgetCrossings(db: Db, budget: Budget): Promise<number> {
  if (!budget._id || budget.status !== 'active') return 0
  const thresholds = await loadBudgetThresholds(db)
  const range = budgetPeriodRange(budget.periodStart, budget.periodEnd)
  const entries = await fetchLedgerExpenses(db, range)
  const actuals = computeBudgetActuals(
    { categories: budget.categories, periodStart: budget.periodStart, periodEnd: budget.periodEnd },
    entries,
    thresholds
  )

  const budgetId = budget._id.toString()
  let emitted = 0
  for (const warning of actuals.warnings) {
    if (warning.level === 'critical') {
      emitted += await emitToAllEligible(db, {
        type: 'budget_critical',
        dedupeKey: budgetCriticalKey(budgetId, warning.category),
        title: `Budget critical: ${budget.name}`,
        message: `${warning.category} is at ${warning.percentUsed}% of budget (critical line ${warning.threshold}%).`,
        data: { entityType: 'budget', entityId: budgetId, link: `/budgets?budget=${budgetId}` },
      })
    } else {
      const bucket = Math.floor(warning.percentUsed / 10) * 10
      emitted += await emitToAllEligible(db, {
        type: 'budget_warning',
        dedupeKey: budgetWarningKey(budgetId, warning.category, bucket),
        title: `Budget warning: ${budget.name}`,
        message: `${warning.category} has reached ${warning.percentUsed}% of its budget.`,
        data: { entityType: 'budget', entityId: budgetId, link: `/budgets?budget=${budgetId}` },
      })
    }
  }
  return emitted
}

/**
 * After an expense posts, re-check only the ACTIVE budgets that actually carry
 * that category and cover that date — never the whole catalogue — then emit any
 * crossings. Kept cheap by an indexed-shaped filter on a small collection.
 */
export async function notifyBudgetCrossingsForExpense(
  db: Db,
  category: string,
  date: Date
): Promise<number> {
  const budgets = await getBudgetCollection(db)
    .find({
      status: 'active',
      periodStart: { $lte: date },
      periodEnd: { $gte: date },
      'categories.category': category,
    })
    .toArray()
  let emitted = 0
  for (const budget of budgets) emitted += await notifyBudgetCrossings(db, budget)
  return emitted
}

/* ---------------------------- financial events --------------------------- */

/**
 * Withdrawal-request / large-expense / distribution-locked alerts to the
 * Founder (they hold `finance.view`, so `emitToUsers` gating passes them and
 * only them among finance viewers who are Founders — here we target Founders
 * explicitly because these are owner decisions, not general finance views).
 *
 * Large-expense is disabled until the Founder configures `largeExpenseThresholdPkr`.
 */
export async function notifyWithdrawalRequest(
  db: Db,
  transactionId: string,
  partnerName: string | undefined
): Promise<number> {
  const founders = await getFounderUserIds(db)
  return emitToUsers(db, founders, {
    type: 'financial_event',
    dedupeKey: financialEventKey('withdrawal_request', transactionId),
    title: 'Partner withdrawal recorded',
    message: `A partner withdrawal${partnerName ? ` by ${partnerName}` : ''} was recorded and may need review.`,
    data: {
      entityType: 'transaction',
      entityId: transactionId,
      link: `/finance?transaction=${transactionId}`,
      kind: 'withdrawal_request',
    },
  })
}

/**
 * Returns whether the entry qualifies as a large expense and, if so, emits. The
 * caller passes the amount in paisa so the threshold comparison happens exactly
 * once, here, against the Founder's configured number (no invented default).
 */
export async function maybeNotifyLargeExpense(
  db: Db,
  args: { transactionId: string; type: LedgerEntryType; amountPaisa: number; note?: string }
): Promise<number> {
  if (args.type !== 'expense') return 0
  const settings = await getBusinessSettingsCollection(db).findOne({ key: 'business' })
  // The Founder configures the threshold in whole PKR; amounts arrive in paisa.
  // Convert once, here, so the comparison is unit-consistent and never doubled.
  const thresholdPkr = settings?.largeExpenseThresholdPkr
  if (typeof thresholdPkr !== 'number' || thresholdPkr <= 0) return 0
  if (args.amountPaisa < pkrToPaisa(thresholdPkr)) return 0

  const founders = await getFounderUserIds(db)
  return emitToUsers(db, founders, {
    type: 'financial_event',
    dedupeKey: financialEventKey('large_expense', args.transactionId),
    title: 'Large expense recorded',
    message: `An expense of ${formatPaisa(args.amountPaisa)} met the large-expense threshold (${formatPkr(
      thresholdPkr
    )}).`,
    data: {
      entityType: 'transaction',
      entityId: args.transactionId,
      link: `/finance?transaction=${args.transactionId}`,
      kind: 'large_expense',
    },
  })
}

export async function notifyDistributionLocked(
  db: Db,
  distributionId: string,
  periodLabel: string
): Promise<number> {
  const founders = await getFounderUserIds(db)
  return emitToUsers(db, founders, {
    type: 'financial_event',
    dedupeKey: financialEventKey('distribution_locked', distributionId),
    title: 'Distribution locked',
    message: `The profit distribution for ${periodLabel} was locked.`,
    data: {
      entityType: 'distribution',
      entityId: distributionId,
      link: `/finance`,
      kind: 'distribution_locked',
    },
  })
}

/* --------------------------- pending approvals --------------------------- */

/** A budget awaiting approval, or any entity the Founder must action. */
export async function notifyPendingApproval(
  db: Db,
  args: { entityType: 'budget' | 'distribution'; entityId: string; label: string }
): Promise<number> {
  const founders = await getFounderUserIds(db)
  return emitToUsers(db, founders, {
    type: 'pending_approval',
    dedupeKey: pendingApprovalKey(args.entityType, args.entityId),
    title: 'Pending approval',
    message: `${args.label} is awaiting approval.`,
    data: {
      entityType: args.entityType,
      entityId: args.entityId,
      link: args.entityType === 'budget' ? `/budgets?budget=${args.entityId}` : `/finance`,
    },
  })
}

/* --------------------------------- tasks --------------------------------- */

export async function notifyTaskOverdue(
  db: Db,
  args: { taskId: string; title: string; assigneeIds: string[]; dueDate: Date }
): Promise<number> {
  return emitToUsers(db, args.assigneeIds, {
    type: 'task_overdue',
    dedupeKey: taskOverdueKey(args.taskId),
    title: 'Task overdue',
    message: `"${args.title}" was due ${formatKarachiDate(args.dueDate, 'date')} and is not done.`,
    data: { entityType: 'task', entityId: args.taskId, link: `/tasks?task=${args.taskId}` },
  })
}

export async function notifyTaskDueSoon(
  db: Db,
  args: { taskId: string; title: string; assigneeIds: string[]; dueDate: Date }
): Promise<number> {
  return emitToUsers(db, args.assigneeIds, {
    type: 'task_due_soon',
    dedupeKey: taskDueSoonKey(args.taskId),
    title: 'Task due soon',
    message: `"${args.title}" is due ${formatKarachiDate(args.dueDate, 'date')}.`,
    data: { entityType: 'task', entityId: args.taskId, link: `/tasks?task=${args.taskId}` },
  })
}

/* --------------------------------- sync ---------------------------------- */

/** A queued offline entry exhausted its retry budget — always reaches the owner. */
export async function notifySyncFailure(
  db: Db,
  args: { userId: string; idempotencyKey: string; reason: string }
): Promise<number> {
  return emitToUsers(db, [new ObjectId(args.userId)], {
    type: 'sync_failure',
    dedupeKey: syncFailureKey(args.idempotencyKey),
    title: 'Offline entry failed to sync',
    message: `An offline entry could not be saved: ${args.reason}. It is still in your Sync queue.`,
    data: { entityType: 'sync', entityId: args.idempotencyKey, link: `/sync` },
  })
}

/** A resolved-to-conflict entry — reaches the owner AND the Founder (design §7). */
export async function notifySyncConflict(
  db: Db,
  args: { userId: string; idempotencyKey: string; reason: string }
): Promise<number> {
  const founders = await getFounderUserIds(db)
  const recipients = [...new Set([args.userId, ...founders])]
  return emitToUsers(db, recipients, {
    type: 'sync_conflict',
    dedupeKey: syncConflictKey(`${args.userId}:${args.idempotencyKey}`),
    title: 'Offline entry needs attention',
    message: `An offline entry conflicts: ${args.reason}. Review it in your Sync queue.`,
    data: { entityType: 'sync', entityId: args.idempotencyKey, link: `/sync` },
  })
}
