'use client'

import { useEffect, useRef, useState } from 'react'
import { syncCoordinator } from './coordinator'
import { subscribeConnection, type ConnectionState, type ConnectionMode } from './connection'
import type { SyncModule } from './types'

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
 */
export function useRealtimeSync(
  module: SyncModule,
  onChanged: () => void | Promise<unknown>,
  enabled = true
): void {
  const callbackRef = useRef(onChanged)
  useEffect(() => {
    callbackRef.current = onChanged
  }, [onChanged])

  useEffect(() => {
    if (!enabled) return
    return syncCoordinator.subscribe(module, () => {
      void callbackRef.current()
    })
  }, [module, enabled])
}

/**
 * Live realtime health for the UI. Returns the current connection state and
 * delivery mode so a screen can show a Live / Reconnecting / Offline chip and
 * the chat composer can disable sending while offline. Purely presentational:
 * it does not open or hold any connection itself.
 */
export function useConnectionState(): { state: ConnectionState; mode: ConnectionMode } {
  const [snapshot, setSnapshot] = useState<{ state: ConnectionState; mode: ConnectionMode }>(
    () => ({ state: 'offline', mode: 'polling' })
  )
  useEffect(() => subscribeConnection(setSnapshot), [])
  return snapshot
}
