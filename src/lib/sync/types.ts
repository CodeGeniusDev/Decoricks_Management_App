/**
 * Cross-module realtime sync contracts.
 *
 * The app has no persistent connection layer (it is deployed on Netlify
 * serverless, where request handlers cannot hold a WebSocket or a long-lived
 * SSE stream). So synchronisation is delivered by a *transport* that today
 * polls a tiny change-cursor endpoint, but the interface is deliberately
 * transport-agnostic: a future `SyncTransport` backed by WebSockets/SSE can be
 * dropped into the coordinator without touching a single subscribing module.
 *
 * The cursor carries only per-collection last-modified timestamps — never
 * record data — so a poll leaks nothing beyond "something in this module
 * changed", and every subscriber still re-fetches its own data through the
 * normal permission-checked endpoints.
 */

export type SyncModule = 'tasks' | 'chat' | 'sales' | 'inventory' | 'finance'

/** Epoch-millisecond high-water marks, one per module the caller may view. */
export type SyncCursor = Partial<Record<SyncModule, number>>

export interface SyncTransport {
  /** Begin delivering cursor snapshots. Safe to call once; further calls no-op. */
  start(onCursor: (cursor: SyncCursor) => void): void
  /** Tear down timers/listeners. After `stop()` a fresh `start()` may be called. */
  stop(): void
}
