/**
 * Queue storage contract (design §4).
 *
 * The engine talks to THIS interface only, never to Dexie directly. Two
 * implementations exist:
 *
 *  - `DexieStore` (db.ts)   — IndexedDB via Dexie, the real device storage
 *  - `createMemoryStore()`  — unit tests AND a runtime fallback: private-mode
 *    Safari throws on IndexedDB open, and a queued create must not crash the
 *    form because of it. Memory fallback means the entry lives until the tab
 *    closes — honest degradation, the Sync screen still shows it.
 */

import type { QueueEntry } from './types'

export interface QueueStore {
  /** This user's rows in creation order — cross-user rows are never surfaced. */
  listByUser: (userId: string) => Promise<QueueEntry[]>
  get: (id: string) => Promise<QueueEntry | undefined>
  /** Insert or overwrite by `id`. */
  put: (entry: QueueEntry) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Logout/discard wipe for one user only (§8: the queue is user-scoped). */
  clearUser: (userId: string) => Promise<number>
  /** Delete every row regardless of user — "Clear local data" on the Sync screen. */
  clearAll: () => Promise<void>
  metaGet: (key: string) => Promise<unknown>
  metaSet: (key: string, value: unknown) => Promise<void>
}

/** In-memory implementation — the test double and the private-mode fallback. */
export const createMemoryStore = (): QueueStore => {
  const entries = new Map<string, QueueEntry>()
  const meta = new Map<string, unknown>()

  return {
    async listByUser(userId) {
      return [...entries.values()]
        .filter((e) => e.userId === userId)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    },
    async get(id) {
      return entries.get(id)
    },
    async put(entry) {
      entries.set(entry.id, { ...entry })
    },
    async remove(id) {
      entries.delete(id)
    },
    async clearUser(userId) {
      let n = 0
      for (const [id, e] of entries) {
        if (e.userId === userId) {
          entries.delete(id)
          n += 1
        }
      }
      return n
    },
    async clearAll() {
      entries.clear()
    },
    async metaGet(key) {
      return meta.get(key)
    },
    async metaSet(key, value) {
      meta.set(key, value)
    },
  }
}
