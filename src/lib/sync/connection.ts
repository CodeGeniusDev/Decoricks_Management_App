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

/*
 * `'connecting'`, not `'offline'`, and that word is a bug fix.
 *
 * This was the module's initial value, and `useConnectionState` seeded itself with
 * the same one. Nothing had been attempted yet, so "offline" was not a
 * measurement — it was a default, and it was rendered on the first paint of every
 * page. On a cold Render instance, where the stream and the first snapshot request
 * both take seconds to answer, that default sat there long enough to be read as a
 * fact: the reported symptom was the header going Offline on a phone with full
 * signal while the server woke up. `sse-transport.start()` already reports the
 * truth — it sets `offline` when `navigator.onLine` is false — so an honest
 * initial value costs nothing and self-corrects.
 *
 * `connecting` also keeps SSR and the client's first render identical, which a
 * `navigator.onLine`-derived initial value would not: hydration would see a
 * different label on the server and on a genuinely offline device.
 */
let snapshot: Snapshot = { state: 'connecting', mode: 'polling' }
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
