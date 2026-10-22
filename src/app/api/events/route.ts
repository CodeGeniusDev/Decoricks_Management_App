import { NextRequest } from 'next/server'
import { discoverViewScopes } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { handleRouteError } from '@/lib/http'
import { computeCursor, ensureSyncIndexes } from '@/lib/sync/cursor'
import type { SyncModule } from '@/lib/sync/types'
import type { PermissionModule } from '@/lib/models/User'
import { realtimeBus } from '@/lib/realtime/bus'
import { awaitChangeStreamOpen, ensureChangeStreamWatcher } from '@/lib/realtime/watcher'
import type { RealtimeSignal } from '@/lib/realtime/types'

/**
 * GET /api/events — Server-Sent Events (SPEC §7.1, §7.2).
 *
 * One authenticated, long-lived stream per tab. It carries ONLY dataless change
 * signals ("module X advanced"), never record data, and the module set is
 * resolved from the caller's view permissions *on connect*: a user with no
 * finance grant is never even sent a finance signal, let alone its contents.
 *
 * Wire protocol (consumed by the client SSE transport):
 *   retry: <ms>            browser auto-reconnect cadence
 *   event: hello           { modules, id } — the scope we agreed to serve
 *   event: cursor          { module: ts }  — authoritative baseline on connect
 *   event: change          id + { module, ts } — one advanced high-water mark
 *   event: reconcile       no replay for this gap → client must poll once. Reasons:
 *                          `watcher-not-ready` (stream still connecting, so no
 *                          baseline is claimed), `cursor-unavailable` (the DB read
 *                          failed), `resume-window-expired` (Last-Event-ID aged out)
 *   : ping                 heartbeat comment, keeps proxies from closing us
 *
 * Resume: a reconnecting client sends `Last-Event-ID`. If the bus still holds
 * everything after it we replay those signals exactly (no missed, no duplicate
 * refetch); if they have aged out we emit `reconcile` and the client's polling
 * fallback closes the hole. Either way the coordinator dedupes by module ts.
 *
 * Runs on the Node runtime because it needs the driver-backed change stream and
 * a stream that outlives a single request — the persistent-host decision from
 * Checkpoint 1. It is `force-dynamic` so Next never tries to cache the stream.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEARTBEAT_MS = 20_000

/**
 * How long a connection waits for the change stream before degrading itself to
 * polling. Kept well under the client's 8 s handshake watchdog so the client
 * never has to guess: either a baseline lands here, or a `reconcile` does.
 */
const WATCHER_READY_TIMEOUT_MS = 3_000

/**
 * Second, non-blocking chance for a stream that was slower than
 * `WATCHER_READY_TIMEOUT_MS`. Polling already covers this window, so the only
 * cost of waiting longer is a slightly later switch to the instant carrier.
 */
const LATE_BASELINE_TIMEOUT_MS = 15_000

const PERMISSION: Record<Exclude<SyncModule, 'notifications'>, [PermissionModule, string]> = {
  tasks: ['tasks', 'view'],
  chat: ['chat', 'view'],
  sales: ['sales', 'view'],
  inventory: ['inventory', 'view'],
  finance: ['finance', 'view'],
}

const encoder = new TextEncoder()

const frame = (event: string, data: unknown, id?: string): Uint8Array => {
  let out = ''
  if (id) out += `id: ${id}\n`
  out += `event: ${event}\n`
  out += `data: ${JSON.stringify(data)}\n\n`
  return encoder.encode(out)
}

async function __GET(request: NextRequest): Promise<Response> {
  // --- Resolve the caller and their per-module view scope BEFORE opening the
  // stream. A missing session throws AuthenticationError → 401 (never a stream),
  // which is exactly the "unauthenticated connection rejected" contract.
  //
  // ONE resolution for the whole module set. This used to be `requireAuth()` plus
  // a serial `authorize()` per module: six identical session aggregates back to
  // back (472 ms of measured connect time) to answer a question the single role
  // document already answers, and one `permission_denied` audit row per module the
  // caller merely doesn't have a widget for. `discoverViewScopes` keeps the 401,
  // drops the rest, and still withholds every gated module from an account that
  // has not changed its temporary password — the net effect the per-module
  // `authorize()` throws had, because each one was caught and omitted its module.
  const { userId: callerId, viewable } = await discoverViewScopes(
    Object.values(PERMISSION).map(([module]) => module)
  )
  const granted = new Set(viewable)

  const GATED = Object.entries(PERMISSION) as [
    Exclude<SyncModule, 'notifications'>,
    [PermissionModule, string],
  ][]

  // Order matches the previous SYNC_MODULES iteration, so the `hello` handshake
  // and the baseline cursor keep describing the same module list.
  const permitted = new Set<SyncModule>([
    // `notifications` is user-scoped, not module-gated: any authenticated user
    // may subscribe because its cursor/signal can only ever describe *their own*
    // newest notification (see §2.6 of the design doc).
    ...GATED.filter(([, [permModule]]) => granted.has(permModule)).map(([mod]) => mod),
    'notifications',
  ])

  // A `notifications` signal must reach ONLY its recipient's streams — it is
  // fanned in-process to every connection, so we filter by the caller here. Any
  // other module is a global per-collection mark gated by the view grant.
  const canDeliver = (signal: RealtimeSignal): boolean =>
    signal.module === 'notifications' ? signal.userId === callerId : permitted.has(signal.module)

  const db = await getDatabase()
  await ensureSyncIndexes(db)
  ensureChangeStreamWatcher()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return
        try {
          controller.enqueue(chunk)
        } catch {
          // Enqueue throws once the client disconnects; tear down idempotently.
          closed = true
        }
      }

      // Reconnect cadence + scope handshake.
      safeEnqueue(encoder.encode(`retry: 3000\n\n`))
      safeEnqueue(frame('hello', { modules: [...permitted], id: realtimeBus.latestId() }))

      // Subscribe BEFORE waiting for the watcher and before snapshotting the
      // baseline: a write that lands during either wait must not fall between the
      // two, or its signal is dropped and the client sits on stale data until the
      // polling fallback happens to catch up. Frames may then arrive out of order
      // relative to the baseline, which the coordinator absorbs by taking the max
      // per module — an advance-only merge, never a regression.
      const onSignal = (signal: RealtimeSignal) => {
        if (!canDeliver(signal)) return
        safeEnqueue(frame('change', { module: signal.module, ts: signal.ts }, signal.id))
      }
      const unsubscribe = realtimeBus.subscribe(onSignal)

      // Baseline cursor so the coordinator adopts silently instead of firing a
      // refetch for changes that happened before this tab connected.
      //
      // Gate the claim on the watcher actually watching. A `cursor` frame is what
      // tells the client to stand its polling down (`onLiveSignal()` in
      // `sync/sse-transport.ts`), so emitting it from a process whose change
      // stream has not completed its server-side handshake would silently remove
      // the only working carrier during exactly the window where nothing can be
      // signalled — reproduced in Phase 5 §3 as a remote write that never reached
      // an open tab on a freshly started server, while passing seconds later on a
      // warm one. Not ready yet therefore means "keep polling", not "trust me".
      const sendBaseline = (): void => {
        void computeCursor(db, [...permitted], callerId)
          .then((cursor) => safeEnqueue(frame('cursor', cursor)))
          .catch(() => safeEnqueue(frame('reconcile', { reason: 'cursor-unavailable' })))
      }

      if (await awaitChangeStreamOpen(WATCHER_READY_TIMEOUT_MS)) {
        sendBaseline()
      } else {
        safeEnqueue(frame('reconcile', { reason: 'watcher-not-ready' }))
        // Keep waiting off-thread: if the stream does come up, the baseline it
        // unlocks is what stands polling down. A caller that never becomes ready
        // (no change streams at all) simply leaves polling as the carrier.
        void awaitChangeStreamOpen(LATE_BASELINE_TIMEOUT_MS).then((ready) => {
          if (ready) sendBaseline()
        })
      }

      // Resume: replay anything the client missed since `Last-Event-ID`.
      const lastEventId = request.headers.get('last-event-id') ?? undefined
      if (lastEventId) {
        const { signals, gap } = realtimeBus.replayAfter(lastEventId)
        if (gap) {
          safeEnqueue(frame('reconcile', { reason: 'resume-window-expired' }))
        } else {
          for (const signal of signals) {
            if (canDeliver(signal)) {
              safeEnqueue(frame('change', { module: signal.module, ts: signal.ts }, signal.id))
            }
          }
        }
      }

      const heartbeat = setInterval(() => safeEnqueue(encoder.encode(`: ping\n\n`)), HEARTBEAT_MS)

      const cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        unsubscribe()
        try {
          controller.close()
        } catch {
          // Already closed by the transport.
        }
      }

      request.signal.addEventListener('abort', cleanup)
      // Fallback for transports that cancel the stream without firing the
      // request-level abort first (some proxy configurations).
      const controllerSignal = (controller as unknown as { signal?: AbortSignal }).signal
      controllerSignal?.addEventListener('abort', cleanup)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disables buffering on the common reverse proxies so events flush now.
      'X-Accel-Buffering': 'no',
    },
  })
}

export const GET = async (request: NextRequest): Promise<Response> => {
  try {
    return await __GET(request)
  } catch (error) {
    // Auth / DB failures must surface as a plain 401/503 JSON, not a stream.
    return handleRouteError(error)
  }
}
