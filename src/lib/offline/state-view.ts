/**
 * Queue → UI summaries. PURE module (no React, no Dexie): the Sync screen,
 * the banner and the offline.html counter all derive their numbers from here
 * so "pending / synced-today / failed / conflict" means the same thing in
 * every place it appears (§11).
 */

import { isUserVisibleUnresolved } from './state'
import type { QueueEntry } from './types'

export interface QueueStats {
  /** Rows the engine will still act on automatically (pending/syncing/due). */
  pending: number
  /** Rows needing user action: failed (out of budget/validation) + conflict. */
  needsAction: number
  failed: number
  conflict: number
  /** Synced rows still inside the display grace window ("just synced"). */
  syncedRecently: number
  /** Everything a user should SEE on the Sync screen right now. */
  visible: number
}

export const summarizeQueue = (entries: QueueEntry[], now = Date.now()): QueueStats => {
  let pending = 0
  let failed = 0
  let conflict = 0
  let syncedRecently = 0

  for (const entry of entries) {
    switch (entry.status) {
      case 'pending':
      case 'syncing':
        pending += 1
        break
      case 'failed':
        failed += 1
        break
      case 'conflict':
        conflict += 1
        break
      case 'synced':
        // "today" in the brief's wording ≈ the grace window the row lingers.
        if (entry.syncedAt !== undefined && now - entry.syncedAt < 24 * 60 * 60 * 1000) {
          syncedRecently += 1
        }
        break
    }
  }

  return {
    pending,
    needsAction: failed + conflict,
    failed,
    conflict,
    syncedRecently,
    visible: entries.filter((e) => isUserVisibleUnresolved(e) || e.status === 'synced').length,
  }
}

/** One-line human label for a queue row, built from the stored payload. */
export const describeQueueEntry = (entry: QueueEntry): string => {
  if (entry.operation === 'create_finance') {
    const p = entry.payload as { type?: string; amount?: number; note?: string }
    const amount =
      typeof p.amount === 'number' ? ` PKR ${(p.amount / 100).toLocaleString('en-PK')}` : ''
    return `${String(p.type ?? 'entry')}${amount}${p.note ? ` — ${p.note}` : ''}`
  }
  const p = entry.payload as { name?: string; categories?: unknown[] }
  return `Budget “${p.name ?? 'untitled'}”${
    Array.isArray(p.categories) ? ` (${p.categories.length} allocations)` : ''
  }`
}

/** Status → badge copy. "Pending" NEVER reads as saved (§4: not saved until
 * the server confirms; wording stays honest in every state). */
export const QUEUE_STATUS_LABEL: Record<QueueEntry['status'], string> = {
  pending: 'Pending',
  syncing: 'Syncing…',
  synced: 'Synced',
  failed: 'Failed',
  conflict: 'Conflict',
}
