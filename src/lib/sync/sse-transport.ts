import { createPollingTransport } from './transport'
import { markSeen, setConnection } from './connection'
import type { SyncCursor, SyncModule, SyncTransport } from './types'

/**
 * SSE transport with automatic polling fallback — the primary `SyncTransport`.
 *
 * It speaks the exact same `start(onCursor) / stop()` contract as the polling
 * transport, so `SyncCoordinator` needs no changes: every `change` event is
 * delivered as a per-module cursor patch and the coordinator's existing
 * advance-only, per-module fan-out does the rest. Because the two transports
 * emit the same `SyncCursor` shape, liveness silently degrades to polling with
 * zero subscriber-side logic and no double refetch storm.
 *
 * Fallback triggers, in order of increasing severity:
 *   - EventSource unavailable (no browser / ancient env) → poll immediately.
 *   - Startup watchdog: the stream opens but no `cursor`/`hello` lands within
 *     `handshakeTimeoutMs` (a buffering proxy, a paused host) → poll as a
 *     carrier while the stream keeps trying.
 *   - `onerror` while the stream is reconnecting (readyState CONNECTING) → poll;
 *     the browser retries the stream itself, and a later `cursor` stops polling.
 *   - `reconcile` (a resume gap) → poll once to close the hole.
 *   - a hard-closed stream (readyState CLOSED) → re-open with exponential
 *     backoff, still carrying updates via polling meanwhile.
 *
 * `navigator.onLine` drives the honest `offline` chip and pauses both transports'
 * work until `online`, at which point the stream is re-opened immediately.
 */

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 8000
const REOPEN_BASE_MS = 3000
const REOPEN_MAX_MS = 60_000

export interface SseTransportOptions {
  url?: string
  handshakeTimeoutMs?: number
}

export function createSseTransport(options: SseTransportOptions = {}): SyncTransport {
  const url = options.url ?? '/api/events'
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS

  let onCursor: ((cursor: SyncCursor) => void) | null = null
  let es: EventSource | null = null
  let poll: SyncTransport | null = null
  let merged: SyncCursor = {}
  let started = false
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null
  let reopenTimer: ReturnType<typeof setTimeout> | null = null
  let reopenAttempts = 0

  const deliver = (patch: SyncCursor): void => {
    for (const [module, ts] of Object.entries(patch) as [SyncModule, number][]) {
      merged[module] = Math.max(merged[module] ?? 0, ts)
    }
    markSeen(patch)
    onCursor?.({ ...merged })
  }

  const startPolling = (): void => {
    if (poll) return
    poll = createPollingTransport()
    poll.start(deliver)
    if (typeof navigator === 'undefined' || navigator.onLine)
      setConnection('reconnecting', 'polling')
  }

  const stopPolling = (): void => {
    poll?.stop()
    poll = null
  }

  const clearHandshake = (): void => {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
  }

  const scheduleReopen = (): void => {
    if (reopenTimer || !started) return
    const delay = Math.min(REOPEN_BASE_MS * 2 ** reopenAttempts, REOPEN_MAX_MS)
    reopenAttempts += 1
    reopenTimer = setTimeout(() => {
      reopenTimer = null
      if (started) open()
    }, delay)
  }

  function open(): void {
    if (!started) return
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      startPolling()
      return
    }

    clearHandshake()
    setConnection('connecting', 'sse')
    es = new EventSource(url, { withCredentials: true })

    // Arm the watchdog the moment we try; a live `cursor` cancels it.
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null
      startPolling()
    }, handshakeTimeoutMs)

    es.addEventListener('cursor', (event) => {
      onLiveSignal()
      try {
        deliver(JSON.parse((event as MessageEvent).data) as SyncCursor)
      } catch {
        // A malformed baseline is not fatal; the next change or poll reconciles.
      }
    })

    es.addEventListener('change', (event) => {
      onLiveSignal()
      try {
        const { module, ts } = JSON.parse((event as MessageEvent).data) as {
          module: SyncModule
          ts: number
        }
        deliver({ [module]: ts })
      } catch {
        /* ignore a bad frame */
      }
    })

    es.addEventListener('reconcile', () => {
      // The server could not replay our gap — poll to catch up.
      startPolling()
    })

    es.onerror = () => {
      if (!started) return
      if (es?.readyState === EventSource.CLOSED) {
        // Fatal for this stream; the browser will not retry it. Keep polling as
        // the carrier and re-open a fresh stream on our own backoff.
        startPolling()
        es = null
        scheduleReopen()
      } else {
        // CONNECTING: the browser is already retrying. Carry via polling meanwhile
        // (startPolling sets the reconnecting state when we are online).
        startPolling()
      }
    }
  }

  /** A real event landed: the stream is authoritative, so stand down polling. */
  const onLiveSignal = (): void => {
    clearHandshake()
    stopPolling()
    reopenAttempts = 0
    setConnection('live', 'sse')
  }

  const onOffline = (): void => {
    setConnection('offline', poll ? 'polling' : 'sse')
  }
  const onOnline = (): void => {
    if (!started) return
    reopenAttempts = 0
    // Drop the (already-failed) stream and open a fresh one immediately.
    es?.close()
    es = null
    open()
  }

  return {
    start(cb) {
      if (started) return
      onCursor = cb
      started = true
      if (typeof window !== 'undefined') {
        window.addEventListener('online', onOnline)
        window.addEventListener('offline', onOffline)
        if (!navigator.onLine) {
          setConnection('offline', 'sse')
          return // Don't dial a stream we cannot reach; wait for `online`.
        }
      }
      open()
    },
    stop() {
      started = false
      clearHandshake()
      if (reopenTimer) {
        clearTimeout(reopenTimer)
        reopenTimer = null
      }
      es?.close()
      es = null
      stopPolling()
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline)
        window.removeEventListener('offline', onOffline)
      }
      setConnection('offline', 'polling')
      onCursor = null
    },
  }
}
