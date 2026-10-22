import { getDatabase } from '@/lib/mongodb'
import { getKarachiDate } from '@/lib/date'
import type { ChangeStreamDocument } from 'mongodb'
import type { SyncModule } from '@/lib/sync/types'
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
  /** Per-module monotonicity floor for published signals — see `nextSignalTs`. */
  var _decoricksLastSignalTs: Map<SyncModule, number> | undefined
}

const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 30_000

/**
 * Timestamp for a published signal: an upper bound on anything the client may
 * already have adopted for this module, and strictly greater than the last
 * signal published for it.
 *
 * Two separate failures are closed here, both reproduced on the live wire in
 * Phase 5 §3, and both consequences of the same rule: subscribers fire on
 * `ts > prev` only, which is what makes the SSE path and the polling path
 * interchangeable without refetching one advance twice.
 *
 * 1. **Same-second collapse.** A `clusterTime` has ONE-SECOND resolution, so
 *    every write inside the same second converts to the identical epoch-ms
 *    value and the second is indistinguishable from a duplicate. Observed as
 *    three byte-identical `{"module":"inventory","ts":…908000}` frames from
 *    three writes, the last of which was an archive that never reached the open
 *    tab. `clusterTimeToMs` takes a `floor` for exactly this purpose; passing
 *    `0` discarded the guarantee it was written to provide.
 * 2. **Clock-domain split.** The client's `prev` is a cursor built from
 *    `updatedAt`/`createdAt`, and those are stamped by `getKarachiDate()` — the
 *    process clock read through the Asia/Karachi convention. `clusterTime` is
 *    the database's true UTC instant. On a host that is not in Asia/Karachi the
 *    two differ by the offset, so every live signal sits HOURS BELOW the
 *    baseline and nothing on the stream can ever fire. Reproduced with
 *    `TZ=UTC` (what a serverless platform hands you): a page connected to a
 *    database whose marks were stamped +5h ahead received `ts=1792576011000`
 *    against an adopted baseline of `1792594003000` and suppressed all four
 *    changes. `appClockMs()` keeps the signal in the domain the cursor uses.
 *
 * The residual slack is one millisecond per same-second write, which the
 * millisecond-precise polled cursor overtakes within a second.
 *
 * Floors are held on `globalThis` like the bus itself: the bus is a process
 * singleton, so a second watcher with a private map could publish a lower ts
 * into it and re-open the very hole this closes.
 */
function nextSignalTs(module: SyncModule, clusterTime: { t: number; i?: number } | undefined) {
  const floors = (global._decoricksLastSignalTs ??= new Map<SyncModule, number>())
  const ts = Math.max(appClockMs(), clusterTimeToMs(clusterTime, (floors.get(module) ?? 0) + 1))
  floors.set(module, ts)
  return ts
}

/**
 * The process clock in the same convention the writes use, at millisecond
 * precision. `getKarachiDate()` truncates to the second, so the sub-second part
 * of the true instant is added back; that is exact because the Asia/Karachi
 * offset is a whole number of hours with no DST, and it is what keeps this
 * strictly above a stamp taken earlier in the same second.
 */
function appClockMs(): number {
  return getKarachiDate().getTime() + (Date.now() % 1000)
}

/** Idempotent per process. Safe to call from every SSE connection. */
export function ensureChangeStreamWatcher(): void {
  if (global._decoricksChangeStreamStarted) return
  global._decoricksChangeStreamStarted = true
  void runLoop()
}

/* ------------------------- stream-readiness handshake ------------------------ */

/**
 * Is a change stream actually watching right now, and if not, when will it be?
 *
 * This exists because the SSE handshake promises more than it can deliver on a
 * cold process. `ensureChangeStreamWatcher()` was fire-and-forget and the route
 * immediately computed and sent the authoritative `cursor` baseline — and a
 * `cursor` frame is what tells the client to STAND POLLING DOWN
 * (`onLiveSignal()` in `sync/sse-transport.ts`). Between that baseline and the
 * stream actually being open, every write was invisible: no signal (the stream
 * was not watching yet) and no poll (the client had just been told to stop).
 * Reproduced as a Phase 5 §3 test failing on a freshly started server — the
 * remote product existed, the API returned it as the newest row, and the open
 * tab never learned about it — while the identical test passed seconds later on
 * a warm server.
 *
 * So the route asks this before it makes the liveness claim: `true` only once
 * `db.watch()` has completed its server-side handshake.
 */
let streamOpen = false
/** False once per failure that means streams are unavailable here at all. */
let streamGaveUp = false
const openWaiters = new Set<(ok: boolean) => void>()

const settleOpen = (ok: boolean): void => {
  const waiters = [...openWaiters]
  openWaiters.clear()
  for (const resolve of waiters) resolve(ok)
}

/**
 * Resolves `true` the moment a change stream is watching, `false` if the watcher
 * has declared change streams unavailable here, or `false` after `timeoutMs`
 * (the caller then degrades the connection to polling instead of claiming
 * liveness it cannot back up).
 */
export function awaitChangeStreamOpen(timeoutMs = 3000): Promise<boolean> {
  if (streamOpen) return Promise.resolve(true)
  if (streamGaveUp) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      openWaiters.delete(settle)
      resolve(false)
    }, timeoutMs)
    const settle = (ok: boolean): void => {
      clearTimeout(timer)
      openWaiters.delete(settle)
      resolve(ok)
    }
    openWaiters.add(settle)
  })
}

/** Test seam: forget any recorded stream state. Not used by production code. */
export function __resetChangeStreamState(): void {
  streamOpen = false
  streamGaveUp = false
  loggedOpen = false
  loggedUnsupported = false
  settleOpen(false)
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
      // `watch()` returns an object without talking to the server; the initial
      // aggregate is issued by the first `next()`. Awaiting `tryNext()` is
      // therefore the difference between "a stream object exists" and "this
      // cursor is live on the database" — which is what the handshake reports.
      const first = await stream.tryNext()
      const reopened = loggedOpen
      streamOpen = true
      settleOpen(true)
      logStreamOpen(db.databaseName)
      // Anything that happened while the stream was down is unrecoverable here
      // (no resume token is configured, and the dead window's events are gone),
      // so every open tab must re-read its own modules once. Publishing a signal
      // per module is exactly that: dataless, permission-filtered at the route,
      // and idempotent — a refetch of unchanged data costs a GET and paints the
      // same rows. Without it a watcher outage is silent forever, because the
      // heartbeat keeps each client's chip reading "Live".
      if (reopened) resyncAllModules()
      if (first) handleChange(first)
      for await (const change of stream) handleChange(change)
      // Stream closed cleanly (rare) — fall through to reconnect.
    } catch (error) {
      logWatchFailure(error, attempts)
      if (loggedUnsupported) streamGaveUp = true
    }
    streamOpen = false
    settleOpen(false)
    attempts += 1
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS)
    await new Promise((r) => setTimeout(r, delay))
  }
}

/** Every module a collection can advance, in first-seen order. */
const SIGNALLED_MODULES = [
  ...new Set(Object.values(COLLECTION_MODULES as Record<string, SyncModule>)),
]

function resyncAllModules(): void {
  for (const mod of SIGNALLED_MODULES) {
    // No cluster token: `nextSignalTs` falls back to the process clock, which is
    // ahead of anything the dead window could have produced.
    realtimeBus.publish(mod, nextSignalTs(mod, undefined))
  }
}

/**
 * Exported only so the monotonicity guarantee in `nextSignalTs` is testable
 * against real change documents; the sole production caller is `runLoop`.
 */
export function handleChange(change: ChangeStreamDocument): void {
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
  // reason to re-fetch. `nextSignalTs` keeps the per-module cursor advancing
  // even when two writes share a cluster second.
  realtimeBus.publish(mod, nextSignalTs(mod, loose.clusterTime))
}

/**
 * One line per process naming the database being watched. Worth keeping:
 * "the UI says Live but nothing syncs" can only be settled from the server side,
 * and Phase 5 chased a phantom here that turned out to be a client-side parsing
 * bug. Logged once because a stream that opens and dies repeatedly must not
 * flood stdout — the reconnect itself is already covered by `logWatchFailure`.
 */
let loggedOpen = false
function logStreamOpen(database: string): void {
  if (loggedOpen) return
  loggedOpen = true
  console.log(`[realtime] change stream open on "${database}"`)
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
