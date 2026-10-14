import type { SyncModule } from './types'

/**
 * Client-visible realtime health.
 *
 * The transport is the only writer; any component can read/subscribe to render
 * the "Live / Reconnecting / Offline" chip and to gate the chat composer. It is
 * a plain observable (no React) so the transport module stays framework-free
 * and testable, and so two components never fight over ownership of a timer.
 *
 *   live         an SSE stream is open and delivering (or polling is advancing)
 *   connecting   a stream is being opened for the first time
 *   reconnecting a stream dropped; EventSource is retrying and/or polling is
 *                carrying updates meanwhile
 *   offline      the browser reports no connectivity at all
 */

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline'

/** How the current liveness is being delivered, for honest UI wording. */
export type ConnectionMode = 'sse' | 'polling'

interface Snapshot {
  state: ConnectionState
  mode: ConnectionMode
}

let snapshot: Snapshot = { state: 'offline', mode: 'polling' }
const listeners = new Set<(s: Snapshot) => void>()

/** Which module high-water marks we last learned about — used by the UI to
 * tell "everything is current" from "we have not received anything yet". */
const lastSeen: Partial<Record<SyncModule, number>> = {}

export const getConnectionSnapshot = (): Snapshot => snapshot

export const setConnection = (state: ConnectionState, mode?: ConnectionMode): void => {
  const next: Snapshot = { state, mode: mode ?? snapshot.mode }
  if (next.state === snapshot.state && next.mode === snapshot.mode) return
  snapshot = next
  for (const listener of listeners) {
    try {
      listener(snapshot)
    } catch {
      // A bad subscriber must not break notification to the others.
    }
  }
}

export const subscribeConnection = (listener: (s: Snapshot) => void): (() => void) => {
  listeners.add(listener)
  listener(snapshot)
  return () => {
    listeners.delete(listener)
  }
}

export const markSeen = (cursor: Partial<Record<SyncModule, number>>): void => {
  for (const [module, ts] of Object.entries(cursor) as [SyncModule, number][]) {
    lastSeen[module] = Math.max(lastSeen[module] ?? 0, ts)
  }
}

export const hasEverConnected = (): boolean => Object.keys(lastSeen).length > 0
