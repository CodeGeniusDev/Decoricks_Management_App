import { NextRequest } from 'next/server'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { handleRouteError } from '@/lib/http'
import { errorResponse } from '@/lib/api-response'
import { computeCursor, ensureSyncIndexes, SYNC_MODULES } from '@/lib/sync/cursor'
import type { SyncModule } from '@/lib/sync/types'
import type { PermissionModule } from '@/lib/models/User'
import { realtimeBus } from '@/lib/realtime/bus'
import { ensureChangeStreamWatcher } from '@/lib/realtime/watcher'
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
 *   event: reconcile       resume token was a gap → client must poll once
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

const PERMISSION: Record<SyncModule, [PermissionModule, string]> = {
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
  const permitted = new Set<SyncModule>()
  for (const mod of SYNC_MODULES) {
    const [permModule, action] = PERMISSION[mod]
    try {
      await authorize(permModule, action)
      permitted.add(mod)
    } catch {
      // No grant for this module: omit its signals rather than fail the stream.
    }
  }

  // A session whose every module was refused is treated as unauthenticated for
  // this endpoint so we never hand an empty-but-open stream to a bad actor.
  if (permitted.size === 0) {
    return errorResponse('You have no modules available for live updates', 403, 'FORBIDDEN')
  }

  const db = await getDatabase()
  await ensureSyncIndexes(db)
  ensureChangeStreamWatcher()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
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

      // Baseline cursor so the coordinator adopts silently instead of firing a
      // refetch for changes that happened before this tab connected.
      void computeCursor(db, [...permitted])
        .then((cursor) => safeEnqueue(frame('cursor', cursor)))
        .catch(() => safeEnqueue(frame('reconcile', { reason: 'cursor-unavailable' })))

      // Resume: replay anything the client missed since `Last-Event-ID`.
      const lastEventId = request.headers.get('last-event-id') ?? undefined
      if (lastEventId) {
        const { signals, gap } = realtimeBus.replayAfter(lastEventId)
        if (gap) {
          safeEnqueue(frame('reconcile', { reason: 'resume-window-expired' }))
        } else {
          for (const signal of signals) {
            if (permitted.has(signal.module)) {
              safeEnqueue(frame('change', { module: signal.module, ts: signal.ts }, signal.id))
            }
          }
        }
      }

      const onSignal = (signal: RealtimeSignal) => {
        if (!permitted.has(signal.module)) return
        safeEnqueue(frame('change', { module: signal.module, ts: signal.ts }, signal.id))
      }
      const unsubscribe = realtimeBus.subscribe(onSignal)

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
