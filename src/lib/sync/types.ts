/**
 * Cross-module realtime sync contracts.
 *
 * Liveness is delivered by a pluggable `SyncTransport`. Phase 7's primary is
 * Server-Sent Events (see `sse-transport.ts`), which auto-degrades to the
 * polling transport (`transport.ts`) when a live stream cannot be maintained.
 * Both emit the same `SyncCursor`, so the `SyncCoordinator` fans out refetches
 * identically whichever one is active — a subscribing module never knows or
 * cares which transport carried the signal.
 *
 * The cursor carries only per-collection last-modified timestamps — never
 * record data — so a signal leaks nothing beyond "something in this module
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
