import { getDatabase } from '@/lib/mongodb'
import type { ChangeStreamDocument } from 'mongodb'
import { realtimeBus } from './bus'
import { COLLECTION_MODULES, clusterTimeToMs } from './types'

/**
 * MongoDB change-stream watcher → realtime bus.
 *
 * Runs ONE database-level stream per process (guarded on `globalThis`, started
 * lazily on the first SSE connection). Because every change carries only a
 * module tag derived from its namespace, the stream leaks nothing: the actual
 * document is never read here, only "which collection moved".
 *
 * Free-tier reality (documented in docs/REALTIME.md): an M0 stream is supported
 * but the cluster can pause after 30 idle days and the tier caps throughput.
 * We therefore treat the watcher as best-effort — if `db.watch()` is unavailable
 * (a standalone dev `mongod`, a paused cluster, a killed cursor) we log once and
 * step aside. The client is none the wiser: its SSE stream simply has no live
 * signals, and the coordinator's automatic polling fallback reconciles. Liveness
 * is guaranteed by polling; the stream only makes it *instant*.
 */

declare global {
  // eslint-disable-next-line no-var
  var _decoricksChangeStreamStarted: boolean | undefined
}

const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 30_000

/** Idempotent per process. Safe to call from every SSE connection. */
export function ensureChangeStreamWatcher(): void {
  if (global._decoricksChangeStreamStarted) return
  global._decoricksChangeStreamStarted = true
  void runLoop()
}

async function runLoop(): Promise<void> {
  let attempts = 0
  // Per-connection lifetime: a resumed stream that then dies retries with
  // exponential backoff so a transient Atlas blip is not a permanent outage.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const db = await getDatabase()
      // Database-level stream over every collection; we filter to the watched
      // ones in `handleChange` by namespace, so no `$match` pipeline is needed
      // (and free-tier namespace filters stay out of the picture entirely).
      const stream = db.watch()
      attempts = 0
      for await (const change of stream) {
        handleChange(change)
      }
      // Stream closed cleanly (rare) — fall through to reconnect.
    } catch (error) {
      logWatchFailure(error, attempts)
    }
    attempts += 1
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS)
    await new Promise((r) => setTimeout(r, delay))
  }
}

function handleChange(change: ChangeStreamDocument): void {
  // Only collection-scoped events carry `ns.coll`; DDL events (dropDatabase,
  // invalidate) have a different shape and are irrelevant to module refresh.
  // Cast the whole document because the union's members differ on `ns`.
  const loose = change as unknown as {
    ns?: { coll?: string }
    clusterTime?: { t: number; i?: number }
  }
  const coll = loose.ns?.coll
  if (!coll) return
  const mod = COLLECTION_MODULES[coll]
  if (!mod) return
  // Deletions of a mapped collection must still refresh the module, so we do
  // not gate on operationType here — every write to a watched collection is a
  // reason to re-fetch. clusterTime keeps the cursor monotonic per second.
  realtimeBus.publish(mod, clusterTimeToMs(loose.clusterTime, 0))
}

/**
 * A standalone `mongod` (common on a dev laptop) does not support change
 * streams at all, and a paused free cluster drops the cursor. These are
 * expected in this deployment, so we downgrade them to a single informative
 * log rather than spamming a stack every reconnect.
 */
let loggedUnsupported = false
function logWatchFailure(error: unknown, attempts: number): void {
  const message = error instanceof Error ? error.message : String(error)
  const unsupported =
    /does not support|change stream|not a replica set|no replset config|Unauthorized/i.test(message)
  if (unsupported && !loggedUnsupported) {
    loggedUnsupported = true
    console.warn(
      '[realtime] MongoDB change streams unavailable (likely a standalone dev instance or paused free tier). Falling back to polling for live updates. ' +
        message
    )
    return
  }
  // Back off logging as retries climb so a hard outage doesn't flood stdout.
  if (attempts < 3 || attempts % 10 === 0) {
    console.warn(`[realtime] change stream dropped, retry #${attempts}: ${message}`)
  }
}
