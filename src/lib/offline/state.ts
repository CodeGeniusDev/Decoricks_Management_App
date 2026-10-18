/**
 * Offline queue — the state machine (design §6.2, §6.3, §6.5).
 *
 * PURE module: no Dexie, no DOM, no fetch. That is what makes the queue
 * testable in Vitest without a browser — the unit tests drive these functions
 * directly, and `engine.ts` is the thin imperative shell around them.
 */

import type { QueueEntry, QueueStatus } from './types'

/* ------------------------------ configuration ------------------------------ */

/** §6.3: after the 5th failed attempt the entry flips to permanent `failed`. */
export const MAX_ATTEMPTS = 5

/** §6.3: `delay = baseDelay × 2^(attempts-1)`, base 5s, capped so a laptop
 * waking from sleep does not face an hour-long first retry. */
export const BASE_RETRY_DELAY_MS = 5_000
export const MAX_RETRY_DELAY_MS = 5 * 60_000

/**
 * §4: a `synced` row is kept briefly so the Sync screen can show "just synced",
 * then deleted on the next drain. Failed/conflict rows are kept indefinitely —
 * they are only removed by explicit user action (retry/edit/discard).
 */
export const SYNCED_RETENTION_MS = 60_000

/* -------------------------------- transitions ------------------------------- */

const ALLOWED: Record<QueueStatus, QueueStatus[]> = {
  // Enqueue lands on pending; a due failed row re-enters syncing on retry.
  pending: ['syncing'],
  // Crash mid-send leaves the row in `syncing`; the drain re-picks it (§7).
  syncing: ['synced', 'failed', 'conflict', 'pending'],
  failed: ['syncing', 'conflict'],
  conflict: ['syncing', 'pending'],
  synced: [],
}

export const canTransition = (from: QueueStatus, to: QueueStatus): boolean =>
  ALLOWED[from].includes(to)

/** Entries that must never silently disappear from the Sync screen (§7). */
export const isUserVisibleUnresolved = (entry: QueueEntry): boolean =>
  entry.status === 'pending' ||
  entry.status === 'syncing' ||
  entry.status === 'failed' ||
  entry.status === 'conflict'

/**
 * §6.2 drain eligibility, in creation order:
 *  - `pending`          — never attempted, or waiting after a session 401
 *  - `syncing`          — crashed mid-send; replay with the SAME key is safe
 *  - `failed` due       — transient backoff elapsed AND autoRetry still true
 * `conflict` and permanently-failed rows are NOT drainable: they wait for the
 * user (retry button flips them back to `pending` with the budget reset).
 */
export const isDrainable = (entry: QueueEntry, now: number): boolean => {
  if (entry.status === 'pending' || entry.status === 'syncing') return true
  if (entry.status === 'failed' && entry.autoRetry && entry.attempts < MAX_ATTEMPTS) {
    return entry.nextRetryAt === undefined || now >= entry.nextRetryAt
  }
  return false
}

/** Exponential backoff (§6.3): attempt N waits base × 2^(N-1), capped. */
export const backoffDelayMs = (attempts: number): number => {
  const safe = Math.max(1, Math.min(attempts, MAX_ATTEMPTS))
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** (safe - 1), MAX_RETRY_DELAY_MS)
}

/* ---------------------------- outcome classification ---------------------------- */

/**
 * Every possible sync outcome, named by what the CLIENT must do with it —
 * this is the §6.5 table expressed as a type. `classifySyncResponse` derives
 * it from the HTTP response so the mapping lives in exactly one place.
 */
export type SyncOutcomeKind =
  | 'created' // 201 — genuinely new server row
  | 'replayed' // 200 {created:false} — same idempotency key, deduped (§7)
  | 'validation' // 400 — bad/changed payload → failed, edit & resubmit
  | 'permission' // 403 — revoked while offline → conflict
  | 'business-conflict' // 409 — withdrawal lock / archived account → conflict
  | 'session' // 401 — expired cookie → keep queue, prompt re-login
  | 'transient' // 5xx / network → back off and blind-retry

export interface SyncOutcome {
  kind: SyncOutcomeKind
  message?: string
  data?: Record<string, unknown>
  /** True when ANY HTTP response was received (not a network failure). */
  reachedServer: boolean
}

/**
 * Maps a server response to an outcome (§6.5). Codes come from the API error
 * envelope (`{ error: { code } }`): WITHDRAWALS_LOCKED and the create paths'
 * VALIDATION_ERROR/PERMISSION are already distinct, and 409 only ever means a
 * business conflict today, so the status code alone disambiguates the rest.
 */
export const classifySyncResponse = (
  status: number,
  body: { code?: string; message?: string; details?: unknown } | null
): SyncOutcome => {
  if (status === 201) return { kind: 'created', reachedServer: true }
  if (status === 200) return { kind: 'replayed', reachedServer: true }
  if (status === 401) {
    return { kind: 'session', message: 'Session expired — log in to sync', reachedServer: true }
  }
  if (status === 403) {
    return {
      kind: 'permission',
      message: body?.message ?? 'You no longer have access to record this',
      reachedServer: true,
    }
  }
  if (status === 409) {
    return {
      kind: 'business-conflict',
      message: body?.message ?? 'Conflicts with the current server state',
      data: (body?.details as Record<string, unknown>) ?? undefined,
      reachedServer: true,
    }
  }
  if (status >= 400 && status < 500) {
    return {
      kind: 'validation',
      message: body?.message ?? 'The server rejected this entry',
      data: (body?.details as Record<string, unknown>) ?? undefined,
      reachedServer: true,
    }
  }
  return {
    kind: 'transient',
    message: body?.message ?? `Server error (${status})`,
    reachedServer: true,
  }
}

/** A fetch that never got a response (offline, DNS, abort) is transient (§7). */
export const networkFailureOutcome = (): SyncOutcome => ({
  kind: 'transient',
  message: 'Could not reach the server',
  reachedServer: false,
})

/* ------------------------------- outcome → state ------------------------------- */

/**
 * Applies an outcome to an entry and returns the UPDATED row (§6.5). Pure —
 * the engine persists the result. The key rules:
 *
 *  - synced only on a definite created/replayed answer — never optimistic (§4)
 *  - session keeps `pending` and does NOT consume the retry budget: logging in
 *    again must not burn attempts the user never really made
 *  - validation/permission/conflict short-circuit autoRetry — they need user
 *    action, so they must not burn the backoff budget blind (§6.3)
 *  - transient reschedules with backoff; the MAX_ATTEMPTS-th flips the row to
 *    a permanent failed with `failureReported` pending (the engine then fires
 *    the sync_failure notification exactly once)
 */
export const applySyncOutcome = (
  entry: QueueEntry,
  outcome: SyncOutcome,
  now: number
): QueueEntry => {
  const base: QueueEntry = {
    ...entry,
    updatedAt: now,
    reachedServer: entry.reachedServer || outcome.reachedServer,
  }

  switch (outcome.kind) {
    case 'created':
    case 'replayed':
      return {
        ...base,
        status: 'synced',
        syncedAt: now,
        errorMessage: undefined,
        conflictData: undefined,
        nextRetryAt: undefined,
        autoRetry: undefined,
      }

    case 'session':
      return {
        ...base,
        status: 'pending',
        errorMessage: outcome.message,
        nextRetryAt: undefined,
      }

    case 'permission':
    case 'business-conflict':
      return {
        ...base,
        status: 'conflict',
        errorMessage: outcome.message,
        conflictData: outcome.data,
        autoRetry: false,
        nextRetryAt: undefined,
      }

    case 'validation':
      return {
        ...base,
        status: 'failed',
        errorMessage: outcome.message,
        conflictData: outcome.data,
        autoRetry: false,
        nextRetryAt: undefined,
      }

    case 'transient': {
      const attempts = base.attempts + 1
      if (attempts >= MAX_ATTEMPTS) {
        // Retry budget exhausted: permanent `failed`, reason visible, and the
        // engine fires sync_failure to the owner exactly once (§6.3, §2.4).
        return {
          ...base,
          status: 'failed',
          attempts,
          lastAttemptAt: now,
          errorMessage: outcome.message,
          autoRetry: false,
          nextRetryAt: undefined,
        }
      }
      return {
        ...base,
        status: 'failed',
        attempts,
        lastAttemptAt: now,
        errorMessage: outcome.message,
        autoRetry: true,
        nextRetryAt: now + backoffDelayMs(attempts),
      }
    }
  }
}

/** True when this write made the entry permanently failed and un-reported —
 * exactly one sync_failure notification per entry, never a duplicate (§7). */
export const shouldReportFailure = (before: QueueEntry, after: QueueEntry): boolean =>
  after.status === 'failed' &&
  after.autoRetry === false &&
  after.attempts >= MAX_ATTEMPTS &&
  !before.failureReported

/** User pressed Retry (§7): reset the budget, back into the drain queue. */
export const entryForManualRetry = (entry: QueueEntry, now: number): QueueEntry => ({
  ...entry,
  status: 'pending',
  attempts: 0,
  nextRetryAt: undefined,
  autoRetry: undefined,
  errorMessage: undefined,
  updatedAt: now,
})

/** Rows whose synced-grace has elapsed are safe to delete (§4: removal only
 * AFTER server confirmation, never on a transient error). */
export const isExpiredSynced = (entry: QueueEntry, now: number): boolean =>
  entry.status === 'synced' &&
  entry.syncedAt !== undefined &&
  now - entry.syncedAt >= SYNCED_RETENTION_MS
