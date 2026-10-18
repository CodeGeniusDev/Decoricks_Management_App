import type { Collection, Db, Document } from 'mongodb'
import { ObjectId } from 'mongodb'
import { getTaskDocCollection } from '@/lib/models/Tasks'
import { getMessageCollection } from '@/lib/models/Chat'
import { getOrderCollection, getReturnCollection } from '@/lib/models/Sales'
import { getProductCollection, getStockCollection } from '@/lib/models/Product'
import { getLedgerCollection } from '@/lib/models/Ledger'
import { getNotificationCollection } from '@/lib/models/Notifications'
import type { SyncCursor, SyncModule } from './types'

/**
 * Cheap "has this module changed?" reads.
 *
 * Each source is a single indexed `sort(timestamp desc).limit(1)` — no scans, no
 * `$group`. A module's cursor is the newest timestamp across its contributing
 * collections. We deliberately read *timestamps only*, never documents, so the
 * endpoint cannot leak row data and stays trivially fast even as the poll runs
 * every few seconds across all connected clients.
 */
type Source = {
  get: (db: Db) => Collection<Document>
  field: 'createdAt' | 'updatedAt'
  /** Optional filter so the read can ride a compound index (e.g. tasks). */
  filter?: Document
}

const SOURCES: Record<Exclude<SyncModule, 'notifications'>, Source[]> = {
  tasks: [
    // Rides the existing `{ isArchived: 1, updatedAt: -1 }` compound index.
    {
      get: (db) => getTaskDocCollection(db) as unknown as Collection<Document>,
      field: 'updatedAt',
      filter: { isArchived: false },
    },
  ],
  chat: [
    {
      get: (db) => getMessageCollection(db) as unknown as Collection<Document>,
      field: 'createdAt',
    },
  ],
  sales: [
    { get: (db) => getOrderCollection(db) as unknown as Collection<Document>, field: 'updatedAt' },
    {
      get: (db) => getReturnCollection(db) as unknown as Collection<Document>,
      field: 'updatedAt',
    },
  ],
  inventory: [
    {
      get: (db) => getProductCollection(db) as unknown as Collection<Document>,
      field: 'updatedAt',
    },
    {
      get: (db) => getStockCollection(db) as unknown as Collection<Document>,
      field: 'updatedAt',
    },
  ],
  finance: [
    {
      get: (db) => getLedgerCollection(db) as unknown as Collection<Document>,
      field: 'updatedAt',
    },
  ],
}

/**
 * The user-scoped modules are NOT in `SOURCES` (whose filters are static).
 * `notifications` is per-user, so its cursor is computed from the caller's own
 * id in `computeCursor` below rather than a global collection high-water mark.
 */
const USER_SCOPED_MODULES: SyncModule[] = ['notifications']

/**
 * Indexes that make the cursor reads O(log n). Only the descending-timestamp
 * indexes the cursor needs and that aren't already created by the module's own
 * `ensureXIndexes` are added here. Every `createIndex` is idempotent, so this
 * runs lazily from the cursor route (memoized per process) and self-heals on a
 * fresh serverless container without a boot-time dependency.
 */
let syncIndexesPromise: Promise<void> | null = null

export function ensureSyncIndexes(db: Db): Promise<void> {
  if (!syncIndexesPromise) {
    syncIndexesPromise = (async () => {
      try {
        await Promise.all([
          getMessageCollection(db).createIndex({ createdAt: -1 }),
          getOrderCollection(db).createIndex({ updatedAt: -1 }),
          getReturnCollection(db).createIndex({ updatedAt: -1 }),
          getProductCollection(db).createIndex({ updatedAt: -1 }),
          getStockCollection(db).createIndex({ updatedAt: -1 }),
          getLedgerCollection(db).createIndex({ updatedAt: -1 }),
          // Per-user notifications cursor: newest of the caller's own rows.
          getNotificationCollection(db).createIndex(
            { userId: 1, createdAt: -1 },
            { name: 'notifications_user_created' }
          ),
        ])
      } catch (error) {
        // Never let an index hiccup break reads; the cursor degrades to a
        // collection scan rather than failing the request. Reset so the next
        // call retries.
        syncIndexesPromise = null
        console.error('ensureSyncIndexes failed:', error)
      }
    })()
  }
  return syncIndexesPromise
}

async function maxTimestamp(source: Source, db: Db): Promise<number> {
  const doc = await source
    .get(db)
    .find(source.filter ?? {})
    .sort({ [source.field]: -1 })
    .limit(1)
    .project<{ [k: string]: Date | undefined }>({ [source.field]: 1, _id: 0 })
    .next()
  const value = doc?.[source.field]
  return value instanceof Date ? value.getTime() : 0
}

/**
 * Newest timestamp per requested module. Modules with no data return `0`.
 *
 * `userId` is required to answer the user-scoped `notifications` module; when
 * absent that module is simply omitted (never a guess, never another user's
 * timestamp). All other modules are global collection high-water marks.
 */
export async function computeCursor(
  db: Db,
  modules: SyncModule[],
  userId?: string
): Promise<SyncCursor> {
  const cursor: SyncCursor = {}
  await Promise.all(
    modules.map(async (module) => {
      if (module === 'notifications') {
        if (!userId) return
        // Rides `{ userId: 1, createdAt: -1 }`: the caller's newest notification
        // only, so the poll answer leaks nothing beyond "you have something newer".
        const doc = await getNotificationCollection(db)
          .find({ userId: new ObjectId(userId) })
          .sort({ createdAt: -1 })
          .limit(1)
          .project<{ createdAt?: Date }>({ createdAt: 1, _id: 0 })
          .next()
        cursor.notifications = doc?.createdAt instanceof Date ? doc.createdAt.getTime() : 0
        return
      }
      const sources = SOURCES[module]
      if (!sources) return
      const marks = await Promise.all(sources.map((s) => maxTimestamp(s, db)))
      cursor[module] = marks.reduce((max, ts) => (ts > max ? ts : max), 0)
    })
  )
  return cursor
}

export const SYNC_MODULES = [
  ...(Object.keys(SOURCES) as SyncModule[]),
  ...USER_SCOPED_MODULES,
]
