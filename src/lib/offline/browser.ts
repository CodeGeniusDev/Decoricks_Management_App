/**
 * Browser wiring for the offline queue (design §6.1, §6.2, §6.3, §9).
 *
 * Everything that touches window lives HERE, behind guards, so the pure
 * modules (state/engine/store) stay importable from Vitest and server bundles.
 *
 * Multi-tab model (§6.1): every tab may TRIED to drain, but `navigator.locks`
 * lets only one hold the `decoricks-offline-drain` critical section at a time —
 * the others skip (never queue, so a hidden tab cannot stall a visible one).
 * The lock is an efficiency measure; the idempotency key is the correctness
 * guarantee, so even a lock race double-send returns the original row.
 */

import { apiFetch } from '@/lib/api-client'
import { getQueueStore } from './db'
import { createSyncEngine, type SyncEngine, type SyncOutcomeEvent } from './engine'
import { classifySyncResponse, entryForManualRetry, networkFailureOutcome } from './state'
import { META_DEVICE_ID, type QueueEntry } from './types'

export const SYNC_TAG = 'decoricks-drain'
const CHANNEL_NAME = 'decoricks-offline'
const DRAIN_LOCK = 'decoricks-offline-drain'

/* ------------------------------- event bus -------------------------------- */

type BusListener = (event: SyncOutcomeEvent) => void
const listeners = new Set<BusListener>()

export const subscribeQueueEvents = (listener: BusListener): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const emitLocal = (event: SyncOutcomeEvent): void => {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // A broken subscriber must not break the drain.
    }
  }
}

let channel: BroadcastChannel | null = null
/** The signed-in user this tab serves; set by startSyncTriggers. */
let currentUserId: string | null = null
const getChannel = (): BroadcastChannel | null => {
  if (channel) return channel
  if (typeof BroadcastChannel === 'undefined') return null
  channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (event) => {
    const data = event.data as { type?: string } | null
    if (data?.type === 'queue-changed') emitLocal({ type: 'changed' })
    if (data?.type === 'drain-request' && currentUserId) void drainQueueNow(currentUserId)
  }
  return channel
}

const broadcastChanged = (): void => {
  getChannel()?.postMessage({ type: 'queue-changed' })
}

/* ------------------------------ sync engine ------------------------------- */

/** POST one queued op and classify the response into an outcome (§6.5). */
const postSyncViaApi = async (body: {
  id: string
  idempotencyKey: string
  operation: string
  payload: unknown
}) => {
  try {
    const res = await apiFetch('/api/offline/sync', {
      method: 'POST',
      body: JSON.stringify({
        id: body.id,
        idempotencyKey: body.idempotencyKey,
        operation: body.operation,
        payload: body.payload,
      }),
    })
    const json = (await res.json().catch(() => null)) as {
      success?: boolean
      data?: { created?: boolean }
      error?: { code?: string; message?: string; details?: unknown }
    } | null

    if (res.ok) {
      // 201 created vs 200 replay — the route sets the status, we trust it.
      return classifySyncResponse(res.status, null)
    }
    return classifySyncResponse(
      res.status,
      json?.error ?? { message: `Request failed (${res.status})` }
    )
  } catch {
    // Fetch itself rejected: offline, DNS, aborted. Transient by definition (§7).
    return networkFailureOutcome()
  }
}

/** Owner-visible failure after an exhausted budget → server notification (§6.3). */
const reportFailureToServer = async (entry: QueueEntry, reason: string): Promise<void> => {
  await apiFetch('/api/offline/sync-failure', {
    method: 'POST',
    body: JSON.stringify({ idempotencyKey: entry.idempotencyKey, reason }),
  }).catch(() => undefined)
}

let engine: SyncEngine | null = null
const getEngine = (): SyncEngine => {
  if (engine) return engine
  engine = createSyncEngine({
    store: getQueueStore(),
    postSync: postSyncViaApi,
    reportFailure: reportFailureToServer,
    emit: (event) => {
      emitLocal(event)
      broadcastChanged()
    },
  })
  return engine
}

/* ---------------------------- leader-locked drain ---------------------------- */

let drainScheduled = false

/**
 * Try to drain NOW, skipping (not queueing) when another tab holds the lock.
 * `ifUnavailable: true` is the "skip" form of the Web Locks API; browsers
 * without the API just run — the idempotency key still protects the ledger.
 */
export const drainQueueNow = async (userId: string): Promise<void> => {
  if (!userId) return
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (locks) {
    try {
      await locks.request(DRAIN_LOCK, { ifUnavailable: true } as unknown as LockOptions, (held) => {
        if (held === undefined) return undefined // another tab is draining
        return getEngine().drainOnce(userId)
      })
      return
    } catch {
      // Older option spelling or unsupported — fall through to a plain drain.
    }
  }
  await getEngine().drainOnce(userId)
}

/** Debounced drain: stacked triggers (online + focus + enqueue) collapse. */
export const scheduleDrain = async (userId: string, delayMs = 400): Promise<void> => {
  if (drainScheduled) return
  drainScheduled = true
  setTimeout(() => {
    drainScheduled = false
    void drainQueueNow(userId)
  }, delayMs)
}

/* ------------------------------ background sync ------------------------------ */

/**
 * Best-effort deferred drain (§9): where Background Sync exists (Android/
 * desktop Chrome) the browser re-fires `sync` on the SW even after the tab
 * closed; the SW relays it to any live client as DRAIN_QUEUE. iOS has no
 * Background Sync — nothing fails there, the feature simply no-ops.
 */
export const registerBackgroundSync = async (): Promise<void> => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    const sync = (
      registration as
        | (ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } })
        | undefined
    )?.sync
    if (sync) await sync.register(SYNC_TAG)
  } catch {
    // Unsupported/failed registration is invisible to the user by design.
  }
}

/* --------------------------------- triggers --------------------------------- */

let triggersStarted = false

/**
 * Start every drain trigger (§6): reconnect, app open, tab focus/visibility,
 * Background Sync relay, and the SW message channel. Idempotent — called from
 * the OfflineProvider on mount; returns a teardown for unmount/HMR hygiene.
 */
export const startSyncTriggers = (userId: string): (() => void) => {
  if (typeof window === 'undefined') return () => undefined
  currentUserId = userId
  getChannel() // ensure the cross-tab channel is live for broadcasts

  const onOnline = () => void drainQueueNow(userId)
  const onFocus = () => void scheduleDrain(userId, 1_000)
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void scheduleDrain(userId, 500)
  }
  const onSwMessage = (event: MessageEvent) => {
    if ((event.data as { type?: string })?.type === 'DRAIN_QUEUE') void drainQueueNow(userId)
  }

  // App open: one drain shortly after boot (the queue may hold crashed rows).
  void scheduleDrain(userId, 1_500)

  if (!triggersStarted) {
    window.addEventListener('online', onOnline)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    if ('serviceWorker' in navigator)
      navigator.serviceWorker.addEventListener('message', onSwMessage)
    triggersStarted = true
  }

  return () => {
    // Only the last live owner tears the shared listeners down (StrictMode
    // mounts twice; the flags keep exactly one set attached).
    window.removeEventListener('online', onOnline)
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisibility)
    if ('serviceWorker' in navigator)
      navigator.serviceWorker.removeEventListener('message', onSwMessage)
    triggersStarted = false
  }
}

/* --------------------------------- enqueue --------------------------------- */

export const localUuid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`

/**
 * Store a validated create body as a `pending` row (§4). The idempotency key
 * comes from the FORM (minted once per modal session) so an online attempt
 * that failed mid-network and this queue share ONE key — the server dedupes
 * either path into exactly one entry. Never regenerates after the first call.
 */
export const enqueueCreate = async (args: {
  userId: string
  operation: QueueEntry['operation']
  payload: QueueEntry['payload']
  idempotencyKey: string
}): Promise<QueueEntry> => {
  const now = Date.now()
  const entry: QueueEntry = {
    id: localUuid(),
    userId: args.userId,
    operation: args.operation,
    payload: args.payload,
    idempotencyKey: args.idempotencyKey,
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  }
  await getQueueStore().put(entry)
  emitLocal({ type: 'changed' })
  broadcastChanged()
  // If we ARE online (a transient failure put it here), retry shortly; if not,
  // the trigger list drains it on reconnect. Background Sync is best-effort.
  void scheduleDrain(args.userId, 500)
  void registerBackgroundSync()
  return entry
}

/* --------------------------------- actions --------------------------------- */

/** Manual "Retry" on the Sync screen (§7): reset the budget, re-enter drain. */
export const retryQueueEntry = async (entry: QueueEntry): Promise<void> => {
  await getQueueStore().put(entryForManualRetry(entry, Date.now()))
  emitLocal({ type: 'changed' })
  broadcastChanged()
  void scheduleDrain(entry.userId, 0)
}

/**
 * Discard (§7), returning whether it completed. An entry that EVER reached the
 * server is audit-logged via POST /api/offline/discard BEFORE the local row
 * disappears — a discard whose audit call failed (offline, 5xx) keeps the row
 * visible so nothing silently vanishes; one that never left the device is
 * removed locally with no round-trip at all.
 */
export const discardQueueEntry = async (
  entry: QueueEntry,
  opts: { replace?: boolean; deviceId?: string } = {}
): Promise<{ ok: boolean; auditFailed: boolean }> => {
  if (!entry.reachedServer) {
    await getQueueStore().remove(entry.id)
    emitLocal({ type: 'changed' })
    broadcastChanged()
    return { ok: true, auditFailed: false }
  }
  try {
    const deviceId = opts.deviceId ?? (await getQueueStore().metaGet(META_DEVICE_ID)) ?? undefined
    const res = await apiFetch('/api/offline/discard', {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: entry.idempotencyKey,
        operation: entry.operation,
        reason: opts.replace ? 'replaced-by-edit' : 'discarded-by-user',
        entryCreatedAt: new Date(entry.createdAt).toISOString(),
        deviceId,
      }),
    })
    if (!res.ok) return { ok: false, auditFailed: true }
    await getQueueStore().remove(entry.id)
    emitLocal({ type: 'changed' })
    broadcastChanged()
    return { ok: true, auditFailed: false }
  } catch {
    return { ok: false, auditFailed: true }
  }
}
