/**
 * The sequential sync engine (design §6.2, §6.3, D3).
 *
 * Framework-free and dependency-injectable: `browser.ts` wires the real
 * fetch/store/BroadcastChannel in, unit tests hand it a memory store and a
 * scripted responder. One entry in flight at a time keeps creation order and
 * makes crash recovery unambiguous — a row caught in `syncing` is drained
 * again with the SAME idempotency key and the server replays the original
 * (§6.5), so exactly-once is structural, not lucky (D3).
 */

import { META_LAST_SYNCED_AT, type QueueEntry } from './types'
import {
  applySyncOutcome,
  isDrainable,
  isExpiredSynced,
  shouldReportFailure,
  type SyncOutcome,
} from './state'
import type { QueueStore } from './store'

export interface SyncRequestBody {
  id: string
  idempotencyKey: string
  operation: string
  payload: unknown
}

export type SyncOutcomeEvent =
  | { type: 'changed' }
  | { type: 'session-required' }
  | { type: 'drained'; synced: number; unresolved: number }

export interface SyncEngineDeps {
  store: QueueStore
  /** One POST of one queued op; resolves to the classified outcome. Injected. */
  postSync: (body: SyncRequestBody) => Promise<SyncOutcome>
  /** Owner notification after a retry budget is exhausted (sync_failure). */
  reportFailure?: (entry: QueueEntry, reason: string) => Promise<void>
  /** UI fan-out: Dexie/live-query refresh, cross-tab broadcast. */
  emit?: (event: SyncOutcomeEvent) => void
  now?: () => number
}

export interface DrainResult {
  processed: number
  synced: number
  /** Rows left visible-unresolved: failed, conflict or session-parked. */
  unresolved: number
  sessionRequired: boolean
  /** True when another drain was already running in THIS tab. */
  skippedReentrant: boolean
}

const EMPTY_RESULT: DrainResult = {
  processed: 0,
  synced: 0,
  unresolved: 0,
  sessionRequired: false,
  skippedReentrant: false,
}

export const createSyncEngine = (deps: SyncEngineDeps) => {
  const { store } = deps
  const now = deps.now ?? (() => Date.now())
  const emit = deps.emit ?? (() => undefined)

  // Re-entrancy guard for this tab: triggers can stack (online + focus + a
  // manual "Sync now" in the same second). Cross-tab duplication is handled
  // one level up by the leader lock; the idempotency key is the real backstop.
  let draining = false

  /**
   * Drain every due row for ONE user, sequentially, oldest first (§6.2).
   * A `session` outcome stops the pass without consuming retry budget — the
   * queue survives intact and drains again after login (§7, never a wipe).
   */
  const drainOnce = async (userId: string): Promise<DrainResult> => {
    if (draining) return { ...EMPTY_RESULT, skippedReentrant: true }
    draining = true
    const result: DrainResult = { ...EMPTY_RESULT }

    try {
      const start = now()
      const rows = await store.listByUser(userId)

      // Purge rows that synced a grace-period ago (§4) and stale expired-synced
      // doubles, then filter to due rows in creation order.
      const due: QueueEntry[] = []
      for (const row of rows) {
        if (isExpiredSynced(row, start)) {
          await store.remove(row.id)
          continue
        }
        if (isDrainable(row, start)) due.push(row)
      }
      if (due.length === 0) {
        emit({ type: 'changed' })
        return result
      }

      for (const entry of due) {
        // §6.2: mark `syncing` BEFORE the request so a crash mid-send leaves
        // an unambiguous trace the next drain replays.
        const sending: QueueEntry = {
          ...entry,
          status: 'syncing',
          lastAttemptAt: now(),
          updatedAt: now(),
        }
        await store.put(sending)
        emit({ type: 'changed' })
        result.processed += 1

        const outcome = await deps.postSync({
          id: sending.id,
          idempotencyKey: sending.idempotencyKey,
          operation: sending.operation,
          payload: sending.payload,
        })

        const after = applySyncOutcome(sending, outcome, now())

        // Retry budget exhausted → notify the owner EXACTLY ONCE (§6.3):
        // persist the flag first is wrong (a crash would lose the report),
        // report then persist the flag: at worst a rare crash re-reports, and
        // the server-side dedupe key collapses the duplicate.
        if (shouldReportFailure(sending, after) && deps.reportFailure) {
          const reason = after.errorMessage ?? 'Repeated sync attempts failed'
          try {
            await deps.reportFailure(after, reason)
            after.failureReported = true
          } catch {
            // Notification plumbing must never fail the queue itself.
          }
        }

        await store.put(after)

        if (outcome.kind === 'created' || outcome.kind === 'replayed') {
          result.synced += 1
        } else {
          result.unresolved += 1
        }

        if (outcome.kind === 'session') {
          result.sessionRequired = true
          emit({ type: 'session-required' })
          // Remaining rows stay untouched `pending` — nothing lost, nothing
          // retried against a dead session.
          break
        }
        emit({ type: 'changed' })
      }

      if (result.synced > 0) await store.metaSet(META_LAST_SYNCED_AT, now())
      emit({ type: 'drained', synced: result.synced, unresolved: result.unresolved })
      return result
    } finally {
      draining = false
    }
  }

  return { drainOnce }
}

export type SyncEngine = ReturnType<typeof createSyncEngine>
