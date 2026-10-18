/**
 * Phase 9 notification dedupe keys (design §2.7).
 *
 * The unique `{ userId, dedupeKey }` index is THE dedup mechanism: the same
 * event must never notify twice even if the server wakes twice, double-fires, or
 * a client tick races. Centralising the key formats here keeps the emit call
 * sites short and gives the unit tests one place to assert the "per product per
 * Karachi day", "per budget per crossing", etc. shapes.
 *
 * `karachiDay` is the business day the event is attributed to. The app runs on
 * Asia/Karachi (every date util in `@/lib/date` uses it), so a task that became
 * overdue just after local midnight is "today overdue", not yesterday's — and a
 * daily low-stock alert fires once per Karachi day, not once per UTC day.
 */

const TIMEZONE = 'Asia/Karachi'

/** `YYYY-MM-DD` in Asia/Karachi. `en-CA` is the locale that yields ISO order. */
export function karachiDay(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

export function lowStockKey(productId: string, date?: Date): string {
  return `low_stock:${productId}:${karachiDay(date)}`
}

export function taskOverdueKey(taskId: string, date?: Date): string {
  return `task_overdue:${taskId}:${karachiDay(date)}`
}

/** Due-soon is a one-shot per task (not per day): it only ever crosses once. */
export function taskDueSoonKey(taskId: string): string {
  return `task_due_soon:${taskId}`
}

/**
 * Budget warning is per crossing bucket, so moving from 80% to 90% does not
 * re-alert but a fresh crossing of a new bucket can. `bucket` is a coarse value
 * (e.g. the rounded percent) supplied by the caller; the critical line is a
 * separate one-shot key.
 */
export function budgetWarningKey(budgetId: string, category: string, bucket: number): string {
  return `budget_warn:${budgetId}:${category}:${bucket}`
}

export function budgetCriticalKey(budgetId: string, category: string): string {
  return `budget_crit:${budgetId}:${category}`
}

export function pendingApprovalKey(entityType: string, entityId: string): string {
  return `pending:${entityType}:${entityId}`
}

/** Tied to the client idempotency key so a retried entry never re-alerts. */
export function syncFailureKey(idempotencyKey: string): string {
  return `sync_fail:${idempotencyKey}`
}

export function syncConflictKey(idempotencyKey: string): string {
  return `sync_conflict:${idempotencyKey}`
}

export function financialEventKey(kind: string, entityId: string): string {
  return `fin:${kind}:${entityId}`
}
