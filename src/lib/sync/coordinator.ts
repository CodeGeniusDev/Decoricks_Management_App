import { createSseTransport } from './sse-transport'
import type { SyncCursor, SyncModule, SyncTransport } from './types'

/**
 * One transport, many subscribers.
 *
 * Every component that wants live updates calls `useRealtimeSync(module, …)`,
 * which registers here. The coordinator keeps a *single* transport (so a page
 * with several subscribed modules still issues exactly one cursor request per
 * tick) and fans a change out only to the listeners whose module actually
 * advanced. When the last subscriber unregisters, the transport is torn down —
 * nothing polls on a page that has no live sections.
 *
 * The cursor is retained across subscribe/unsubscribe within a session, so a
 * remount (React StrictMode double-invoke, or navigating back to a page) never
 * triggers a spurious "everything changed" refresh: the first snapshot for a
 * module we've seen before is compared normally, and a module seen for the very
 * first time is adopted silently as a baseline.
 */

type Listener = () => void

export class SyncCoordinator {
  private cursor: SyncCursor = {}
  private listeners = new Map<SyncModule, Set<Listener>>()
  private transport: SyncTransport | null = null

  /**
   * Primary transport is SSE (instant, resumes via Last-Event-ID) with polling
   * built in as its automatic fallback; the transport is injectable so the
   * fan-out semantics stay unit-testable with a fake.
   */
  constructor(private readonly makeTransport: () => SyncTransport = () => createSseTransport()) {}

  subscribe(module: SyncModule, listener: Listener): () => void {
    let set = this.listeners.get(module)
    if (!set) {
      set = new Set()
      this.listeners.set(module, set)
    }
    set.add(listener)
    this.ensureStarted()

    return () => {
      const current = this.listeners.get(module)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(module)
      if (this.listeners.size === 0) this.stop()
    }
  }

  private ensureStarted(): void {
    if (this.transport) return
    this.transport = this.makeTransport()
    this.transport.start((next) => this.handleCursor(next))
  }

  private handleCursor(next: SyncCursor): void {
    for (const [module, ts] of Object.entries(next) as [SyncModule, number][]) {
      const prev = this.cursor[module]
      // Never-seen module: adopt as baseline without firing, so mounting a page
      // doesn't immediately refetch for a change made before the user arrived.
      if (prev === undefined) {
        this.cursor[module] = ts
        continue
      }
      if (ts > prev) {
        this.cursor[module] = ts
        const set = this.listeners.get(module)
        if (set) {
          for (const listener of set) {
            try {
              listener()
            } catch {
              /* one bad listener must not break the fan-out to the others */
            }
          }
        }
      }
    }
  }

  private stop(): void {
    this.transport?.stop()
    this.transport = null
    // Keep `cursor` so a quick unsubscribe/resubscribe doesn't re-baseline and
    // miss a change that landed in the gap.
  }
}

export const syncCoordinator = new SyncCoordinator()
