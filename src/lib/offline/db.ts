/**
 * IndexedDB via Dexie — the device queue (design §4, §8).
 *
 * Browser-only module: everything that touches it runs inside `typeof window`
 * guards or behind the store contract, so it can never leak into a server
 * bundle. One database, `decoricks-offline`, exactly as the design doc
 * specifies: a `queue` store and a tiny `meta` store.
 *
 * WHAT IS STORED (design §8): queued creates only — ids, paisa integers,
 * category names, typed notes — plus last-sync metadata. NEVER stored: session
 * or CSRF tokens (they live in httpOnly cookies the page cannot read),
 * passwords, full ledgers, cached API responses, other users' rows.
 */

import Dexie, { type Table } from 'dexie'
import { createMemoryStore, type QueueStore } from './store'
import { META_DEVICE_ID, META_LAST_SYNCED_AT, type QueueEntry, type QueueMeta } from './types'

class DecoricksOfflineDB extends Dexie {
  queue!: Table<QueueEntry, string>
  meta!: Table<QueueMeta, string>

  constructor() {
    super('decoricks-offline')
    this.version(1).stores({
      // Indexes: owner filter, drain scans, key lookups, creation order.
      queue: 'id, userId, status, idempotencyKey, createdAt, [userId+status]',
      meta: 'key',
    })
  }
}

/** Store bound to the Dexie tables. */
const createDexieStore = (db: DecoricksOfflineDB): QueueStore => ({
  async listByUser(userId) {
    return db.queue
      .where('[userId+status]')
      .anyOf(
        [userId, 'pending'],
        [userId, 'syncing'],
        [userId, 'synced'],
        [userId, 'failed'],
        [userId, 'conflict']
      )
      .sortBy('createdAt')
  },
  async get(id) {
    return (await db.queue.get(id)) ?? undefined
  },
  async put(entry) {
    await db.queue.put(entry)
  },
  async remove(id) {
    await db.queue.delete(id)
  },
  async clearUser(userId) {
    const ids = await db.queue.where('userId').equals(userId).primaryKeys()
    await db.queue.bulkDelete(ids)
    return ids.length
  },
  async clearAll() {
    await db.queue.clear()
  },
  async metaGet(key) {
    const row = await db.meta.get(key)
    return row?.value
  },
  async metaSet(key, value) {
    await db.meta.put({ key, value })
  },
})

let singleton: QueueStore | null = null
let backend: 'indexeddb' | 'memory' | null = null

export const getQueueBackend = (): 'indexeddb' | 'memory' | null => backend

/**
 * The one store the app uses. Opens IndexedDB lazily on first call from client
 * code; if opening FAILS (Safari private mode, evicted storage, disabled
 * third-party cookies for an installed-PWA edge case) it degrades to a memory
 * store instead of throwing at the form — a queued entry then lives for the
 * tab session, visible on the Sync screen, exactly the honest degradation the
 * design doc promised. A blip never drops a draft (§8).
 */
export const getQueueStore = (): QueueStore => {
  if (singleton) return singleton
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    // SSR or a webview with no storage at all: memory keeps the UI consistent.
    backend = 'memory'
    singleton = createMemoryStore()
    return singleton
  }
  try {
    const db = new DecoricksOfflineDB()
    backend = 'indexeddb'
    singleton = createDexieStore(db)
  } catch {
    backend = 'memory'
    singleton = createMemoryStore()
  }
  return singleton
}

/** Stable per-install id for the audit trail on discarded entries (§7). */
export const getDeviceId = async (): Promise<string> => {
  const store = getQueueStore()
  const existing = (await store.metaGet(META_DEVICE_ID)) as string | undefined
  if (existing) return existing
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}`
  await store.metaSet(META_DEVICE_ID, id)
  return id
}

export const setLastSyncedAt = (now: number): Promise<void> =>
  getQueueStore().metaSet(META_LAST_SYNCED_AT, now)

export const getLastSyncedAt = async (): Promise<number | null> => {
  const value = await getQueueStore().metaGet(META_LAST_SYNCED_AT)
  return typeof value === 'number' ? value : null
}

/**
 * Nuclear clear for logout wipe paths and "Clear local data" (design §8):
 * delete the whole database, not row-by-row, so nothing — not even meta —
 * survives on a shared device. The next getQueueStore() reopens a fresh one.
 */
export const clearAllLocalData = async (): Promise<void> => {
  if (
    typeof window !== 'undefined' &&
    typeof indexedDB !== 'undefined' &&
    backend === 'indexeddb'
  ) {
    try {
      Dexie.delete('decoricks-offline')
    } catch {
      // Best-effort; the memory fallback below still clears the live session.
    }
  }
  singleton = null
  backend = null
  await getQueueStore().clearAll()
}
