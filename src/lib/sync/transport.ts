import type { SyncCursor, SyncModule, SyncTransport } from './types'

/**
 * The polling `SyncTransport` — Phase 7's automatic fallback.
 *
 * The SSE transport is primary (see `sse-transport.ts`); this is what it
 * degrades to when a live stream cannot be established or delivered, and it is
 * also the standalone choice when EventSource is unavailable. Both emit the
 * same `SyncCursor`, so switching is transparent to the coordinator.
 *
 * It polls a tiny change-cursor endpoint on a timer; that endpoint answers only
 * "has this module changed?" with a timestamp, never row data.
 *
 * Behaviour notes:
 *   - Pauses entirely while the tab is hidden and catches up the instant it is
 *     visible again, so background tabs don't spend requests or battery.
 *   - Fires immediately on `online`, so a reconnect reconciles without waiting
 *     for the next tick.
 *   - Sends `x-session-background: 1` so polling never extends the rolling
 *     inactivity timeout — an idle tab must not keep a session alive forever.
 */

const ALL_MODULES: SyncModule[] = ['tasks', 'chat', 'sales', 'inventory', 'finance']

export function createPollingTransport(options: { intervalMs?: number } = {}): SyncTransport {
  // Floor at 3s: frequent enough to feel live, rare enough that the indexed
  // cursor read is negligible load for an internal team.
  const intervalMs = Math.max(3000, options.intervalMs ?? 6000)

  let timer: ReturnType<typeof setInterval> | null = null
  let onCursor: ((cursor: SyncCursor) => void) | null = null

  const fetchOnce = async (): Promise<void> => {
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      const res = await fetch(`/api/sync/cursor?modules=${ALL_MODULES.join(',')}`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'x-session-background': '1' },
      })
      if (!res.ok) return
      const body = await res.json().catch(() => null)
      if (body?.success && body.data) onCursor?.(body.data as SyncCursor)
    } catch {
      // Network blip or transient 5xx: nothing to reconcile yet. The next tick,
      // the `online` handler, or the visibility catch-up will retry. We never
      // treat a failed poll as "no changes".
    }
  }

  const tick = () => {
    void fetchOnce()
  }
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') tick()
  }
  const onOnline = () => tick()

  return {
    start(cb) {
      onCursor = cb
      if (timer) return
      // Prime immediately so a freshly-mounted page reconciles on once-changed
      // data instead of waiting a full interval for its first signal.
      void fetchOnce()
      timer = setInterval(tick, intervalMs)
      if (typeof window !== 'undefined') window.addEventListener('online', onOnline)
      if (typeof document !== 'undefined')
        document.addEventListener('visibilitychange', onVisibility)
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', onVisibility)
      onCursor = null
    },
  }
}
