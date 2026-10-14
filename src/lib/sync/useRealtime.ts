'use client'

import { useEffect, useRef } from 'react'
import { syncCoordinator } from './coordinator'
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
