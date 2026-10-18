'use client'

/**
 * Live access to the offline queue for React screens.
 *
 * Hydration-safe by construction: the first client render matches the server
 * render exactly (empty list, `loading`), and rows appear only after mount —
 * no hydration warning, no layout shift from "nothing → a table".
 *
 * Refresh sources (all wired to the SAME signals the engine emits, so two
 * tabs never diverge §6.1):
 *  - Dexie's own mutation hooks via `useLiveQuery` (same-tab writes)
 *  - the queue event bus (engine state changes in this tab)
 *  - the BroadcastChannel relay (another tab wrote) — surfaced as bus events
 *    by `startSyncTriggers`, which every authenticated screen mounts.
 */

import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getQueueStore } from '@/lib/offline/db'
import { subscribeQueueEvents } from '@/lib/offline/browser'
import { META_LAST_SYNCED_AT, type QueueEntry } from '@/lib/offline/types'
import { summarizeQueue, type QueueStats } from '@/lib/offline/state-view'

export interface OfflineQueueResult {
  /** This user's rows, creation order; `undefined` until the store opens. */
  entries: QueueEntry[] | undefined
  loading: boolean
}

export const useOfflineQueue = (userId: string | null | undefined): OfflineQueueResult => {
  const [mounted, setMounted] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    setMounted(true)
    // Every engine emit (this tab or a remote tab via the channel) re-runs the
    // query; Dexie's liveQuery already covers same-tab writes, this is the
    // belt for the cross-tab braces.
    return subscribeQueueEvents(() => setRevision((r) => r + 1))
  }, [])

  const entries = useLiveQuery(
    () => (mounted && userId ? getQueueStore().listByUser(userId) : []),
    [mounted, userId, revision],
    undefined
  )

  return { entries, loading: entries === undefined && Boolean(userId) }
}

/** The "Last synced" timestamp for the Sync screen header (§11). */
export const useLastSyncedAt = (): number | null => {
  const [mounted, setMounted] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    setMounted(true)
    return subscribeQueueEvents(() => setRevision((r) => r + 1))
  }, [])
  return (
    useLiveQuery(
      async () => {
        if (!mounted) return null
        const value = await getQueueStore().metaGet(META_LAST_SYNCED_AT)
        return typeof value === 'number' ? value : null
      },
      [mounted, revision],
      null
    ) ?? null
  )
}

/** Counts for the offline banner / nav badge without opening the Sync screen. */
export const useOfflineQueueStats = (
  userId: string | null | undefined
): { stats: QueueStats; loading: boolean } => {
  const { entries, loading } = useOfflineQueue(userId)
  const stats = summarizeQueue(entries ?? [])
  return { stats, loading }
}
