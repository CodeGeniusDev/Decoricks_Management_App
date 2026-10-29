'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { syncCoordinator, type SyncSubscription } from './coordinator'
import { subscribeConnection, type ConnectionState, type ConnectionMode } from './connection'
import { connectionView } from './connection-view'
import { useBrowserOnline } from '@/hooks/useBrowserOnline'
import type { SyncModule } from './types'

/**
 * The read-tracking handle `useRealtimeSync` hands to a component.
 *
 * Three calls around one read let the sync layer tell a change that needs
 * re-fetching apart from a duplicate of a request already in flight:
 *
 * ```ts
 * const sync = useRealtimeSync('finance', refresh)
 * sync.begin()
 * try {
 *   const { data, serverTime, durationMs } = await apiJsonMeta('/api/finance/transactions')
 *   sync.settle(serverTime, durationMs)
 *   setData(data)
 * } catch {
 *   sync.abandon()
 * }
 * ```
 *
 * `begin`/`abandon` are optional in the sense that omitting them cannot lose a
 * change: with no outstanding-read bookkeeping the coordinator behaves exactly
 * as it did before, refetching on the first snapshot.
 */
export interface RealtimeReadTracker {
  begin: () => void
  settle: (serverTime: number | null | undefined, durationMs?: number) => void
  abandon: () => void
}

/**
 * Subscribe a component to cross-device changes for one module.
 *
 * `onChanged` fires only when the server reports that this module's newest
 * timestamp advanced since the last snapshot — so the caller refreshes on real
 * changes, not on a blind timer. The refresh itself should be the *silent*
 * variant (keep existing content painted, update in place) so a remote edit
 * never blanks the UI; that is exactly what the task board and dashboard now
 * do.
 *
 * `enabled` lets a page stop listening while it's not safe to refresh (a modal
 * open, a drag in flight) without tearing down the shared transport for other
 * subscribers.
 *
 * Returns the read tracker for this subscription (see `RealtimeReadTracker`).
 * It exists because the correctness rule in `sync/coordinator.ts` cannot tell,
 * on its own, that the page has *just* been served the rows the baseline is
 * offering to re-fetch — or that a read carrying them is still on the wire.
 * Measured on the production build, that missing evidence cost an identical
 * second wave of requests on every document load.
 */
export function useRealtimeSync(
  module: SyncModule,
  onChanged: () => void | Promise<unknown>,
  enabled = true
): RealtimeReadTracker {
  const callbackRef = useRef(onChanged)
  useEffect(() => {
    callbackRef.current = onChanged
  }, [onChanged])

  const subscriptionRef = useRef<SyncSubscription | null>(null)

  useEffect(() => {
    if (!enabled) return
    const subscription = syncCoordinator.register(module, () => {
      void callbackRef.current()
    })
    subscriptionRef.current = subscription
    return () => {
      if (subscriptionRef.current === subscription) subscriptionRef.current = null
      subscription.dispose()
    }
  }, [module, enabled])

  // Stable identity, so callers can keep it in a `useCallback` dependency list.
  // Marks made while unsubscribed are dropped rather than remembered: a component
  // that stopped listening has no claim about what is on screen.
  return useMemo<RealtimeReadTracker>(
    () => ({
      begin: () => subscriptionRef.current?.beginRead(),
      settle: (serverTime, durationMs) =>
        subscriptionRef.current?.settleRead(serverTime, durationMs),
      abandon: () => subscriptionRef.current?.abandonRead(),
    }),
    []
  )
}

/**
 * Live realtime health for the UI. Returns the current connection state and
 * delivery mode so a screen can show a Live / Reconnecting / Offline chip and
 * the chat composer can disable sending while offline. Purely presentational:
 * it does not open or hold any connection itself.
 */
export function useConnectionState(): { state: ConnectionState; mode: ConnectionMode } {
  /*
   * A fixed literal, deliberately NOT `getConnectionSnapshot()`. Reading the live
   * module here would make the client's first render say `live` for a component
   * that the server rendered as `connecting` — a hydration mismatch on the header
   * chip, which is exactly the class of bug this file's sibling
   * `NotificationBell` goes out of its way to avoid. The effect below subscribes
   * and the store pushes the real snapshot synchronously, so the literal lives
   * for less than one frame.
   *
   * It says `connecting` because that used to be `offline`, and `offline` was a
   * claim about the network that nothing had earned: on a cold Render instance it
   * sat on screen for seconds while the server woke up, on a phone with signal.
   */
  const [snapshot, setSnapshot] = useState<{ state: ConnectionState; mode: ConnectionMode }>(
    () => ({ state: 'connecting', mode: 'polling' })
  )
  useEffect(() => subscribeConnection(setSnapshot), [])
  return snapshot
}

/**
 * The chip's words, from the store's facts *and* the browser's.
 *
 * `waking` is passed in by the data layer, because "the server is booting" is
 * something only a request can discover; the transport knows its own state, not
 * why the API is quiet.
 */
export function useConnectionView(waking = false): {
  label: string
  tone: 'success' | 'warning' | 'danger'
} {
  const { state, mode } = useConnectionState()
  const online = useBrowserOnline()
  return connectionView({ state, mode, online, waking })
}
