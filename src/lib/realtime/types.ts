import type { SyncModule } from '@/lib/sync/types'

/**
 * Phase 7 realtime contracts (server side).
 *
 * A `RealtimeSignal` is deliberately DATALESS: it says only "module X changed
 * at timestamp T". Every subscriber still re-fetches its own records through
 * the normal permission-checked endpoints, so an event can never leak a field
 * the viewer has no grant to see — a finance signal tells a non-finance user
 * nothing, because they are filtered out before it is ever sent to them.
 *
 * The single client of a signal is the existing `SyncCoordinator`, which treats
 * it exactly like a polled cursor advance: it fans a refetch out to the modules
 * whose high-water mark moved. That is what keeps SSE and the polling fallback
 * interchangeable and why there is no ordering/duplication logic to get wrong.
 */

export interface RealtimeSignal {
  /** Monotonic, per-process. Becomes the SSE `id:` so a client can resume. */
  id: string
  module: SyncModule
  /** Epoch-ms high-water mark to adopt for the module. */
  ts: number
}

/** Mongo collection name → the sync module a write to it should refresh. */
export const COLLECTION_MODULES: Record<string, SyncModule> = {
  messages: 'chat',
  tasks: 'tasks',
  taskComments: 'tasks',
  taskActivity: 'tasks',
  orders: 'sales',
  returns: 'sales',
  products: 'inventory',
  stock: 'inventory',
  stockMovements: 'inventory',
  ledger: 'finance',
}

/**
 * Cluster timestamp (second resolution) → epoch-ms, falling back to wall clock
 * when the token is absent. Never returns a value below `floor`, so a
 * same-second burst of changes still advances the cursor monotonically.
 */
export function clusterTimeToMs(
  clusterTime: { t: number; i?: number } | undefined,
  floor: number
): number {
  if (!clusterTime?.t) return Math.max(Date.now(), floor)
  return Math.max(clusterTime.t * 1000 + (clusterTime.i ?? 0) / 2 ** 31, floor)
}
