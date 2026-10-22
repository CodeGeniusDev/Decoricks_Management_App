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
 * module we've seen before is compared normally. A module seen for the very
 * first time revalidates once — see `handleCursor`, because adopting it quietly
 * was how Phase 5 lost a cross-device change for the rest of a session.
 */

type Listener = () => void

/**
 * A subscriber plus the freshness evidence *it* has supplied.
 *
 * The mark is per registration, not per module, and that distinction is the
 * reason this design is safe: two components can subscribe to `finance` while
 * reading different endpoints of it (the ledger table and the overview figures),
 * so "the screen is fresh as of T" is a claim only the reader can make about its
 * own data. A module-level mark would let the later of two reads suppress a
 * signal the earlier one still needed.
 *
 * A registration also tracks the reads it has *outstanding*. A signal that lands
 * while one is in flight is held rather than acted on, because the only honest
 * answer at that moment is "wait and see what that read brings back": firing
 * immediately put a second, identical request on the wire beside its predecessor
 * — measured on a production build as a duplicate wave on every document load —
 * and two concurrent reads of the same module on an M0 pool make every *other*
 * request on the page slower as well.
 */
interface Registration {
  listener: Listener
  /**
   * The earliest server-clock instant this subscriber's newest completed read can
   * have started querying at. `undefined` until a read has answered.
   */
  proofAt?: number
  /** Reads this subscriber has issued that have not answered yet. */
  pending: number
  /** Newest first-snapshot held back because a read was in flight. */
  heldSnapshot?: number
  /** A genuine advance (not a baseline) is held back too. */
  heldAdvance: boolean
}

export interface SyncSubscription {
  dispose: () => void
  /**
   * Call immediately BEFORE a read of the subscribed module goes out. Pairs with
   * `settleRead`/`abandonRead`; the count is per registration, so overlapping
   * reads of one component (a filter change superseding a mount read) are all
   * accounted for.
   */
  beginRead: () => void
  /**
   * Record that this subscriber now holds the module's rows, and how current
   * they are. Pass the `serverTime` from `apiJsonMeta` *with* the client-measured
   * `durationMs` of that request, and never a local `Date.now()`: the value is
   * compared against collection timestamps produced by the server, and guessing
   * across two clocks is exactly the mistake that strands someone else's change.
   *
   * The proof is the read's *start*, not its completion: a handler stamps its
   * envelope when it finishes, and a query that began a second before a colleague
   * committed their write does not contain that write however late it answers.
   * Subtracting the observed round trip puts the proof conservatively early.
   *
   * The mark can only ever *cancel a duplicate read*. It never authorises
   * anything, so a missing, late or wrong mark costs one extra request.
   */
  settleRead: (serverTimeMs: number | null | undefined, durationMs?: number) => void
  /** A read that aborted or failed proves nothing; release anything it held. */
  abandonRead: () => void
}

/**
 * How much later than a module's newest write a read must be before the first
 * cursor snapshot may be treated as already-seen.
 *
 * The proof is already in a single clock domain — `proofAt` is derived from the
 * server's own envelope instant, `newestWrite` from the collection's newest row —
 * so this margin is not a cross-clock guess. It absorbs the two real
 * imprecisions left: the client-measured duration is not exactly the server-side
 * query window (queueing, parse time, connection setup), and a route handler's
 * clock can differ from the one that wrote the row. Two seconds is comfortable,
 * and the cost of the margin falls only on the rare side: a colleague's write
 * that landed within two seconds of you opening the page revalidates once, which
 * is precisely when revalidating is the correct answer.
 */
const SKEW_GUARD_MS = 2_000

/** True when a subscriber can prove its own read postdates the newest write. */
const isProvenFresh = (proofAt: number | undefined, newestWrite: number): boolean =>
  proofAt !== undefined && newestWrite <= proofAt - SKEW_GUARD_MS

export class SyncCoordinator {
  private cursor: SyncCursor = {}
  private listeners = new Map<SyncModule, Set<Registration>>()
  private transport: SyncTransport | null = null

  /**
   * Primary transport is SSE (instant, resumes via Last-Event-ID) with polling
   * built in as its automatic fallback; the transport is injectable so the
   * fan-out semantics stay unit-testable with a fake.
   */
  constructor(private readonly makeTransport: () => SyncTransport = () => createSseTransport()) {}

  subscribe(module: SyncModule, listener: Listener): () => void {
    return this.register(module, listener).dispose
  }

  register(module: SyncModule, listener: Listener): SyncSubscription {
    const registration: Registration = { listener, pending: 0, heldAdvance: false }
    let set = this.listeners.get(module)
    if (!set) {
      set = new Set()
      this.listeners.set(module, set)
    }
    set.add(registration)
    this.ensureStarted()

    let active = true
    return {
      dispose: () => {
        if (!active) return
        active = false
        const current = this.listeners.get(module)
        if (!current) return
        current.delete(registration)
        if (current.size === 0) this.listeners.delete(module)
        if (this.listeners.size === 0) this.stop()
      },
      beginRead: () => {
        if (!active) return
        registration.pending += 1
      },
      settleRead: (serverTimeMs, durationMs = 0) => {
        if (!active) return
        if (registration.pending > 0) registration.pending -= 1
        if (typeof serverTimeMs === 'number' && Number.isFinite(serverTimeMs)) {
          // Where the read must have begun, in the server's own clock.
          const startedAt = serverTimeMs - Math.max(0, Math.round(durationMs))
          if (registration.proofAt === undefined || startedAt > registration.proofAt) {
            registration.proofAt = startedAt
          }
        }
        this.flushHeld(registration)
      },
      abandonRead: () => {
        if (!active) return
        if (registration.pending > 0) registration.pending -= 1
        this.flushHeld(registration)
      },
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
      if (prev === undefined) {
        /*
         * The first snapshot this document has ever received for a module cannot
         * be swallowed as a baseline: it is newer than the data on screen. The
         * page read its own rows from the same mount effect that subscribed here,
         * while the snapshot is taken after the connect round trip — so any write
         * that committed in between is ALREADY folded into `ts` and can therefore
         * never present as an advance. Silently adopting it hid the change for the
         * rest of the session, and because a `cursor` frame also stands the
         * polling fallback down (`onLiveSignal()` in `sync/sse-transport.ts`),
         * nothing else was going to look again. Measured on a cold production
         * server in Phase 5 §3: the tab's mount read of `/api/stock/summary` was
         * served at 11:09:12.383 (its body, captured in the Playwright trace, held
         * the other 12 products and not the new one), the write committed by
         * 11:09:12.592, and the baseline this method adopted at ~11:09:12.9 already
         * counted it. Twenty-four polls of the row: never there.
         *
         * So the first snapshot re-reads the module once, and every later one is
         * compared normally. Nothing here costs a request for a module nobody is
         * looking at (`notify` returns immediately with no listeners), and a page
         * whose module was already baselined by an earlier frame — the normal case
         * for soft navigation, since the stream outlives the page — does not
         * refetch, which is the mount-time behaviour this rule was written for.
         *
         * The one case that is provably not a change is when a subscriber holds
         * the module *already read after that write*, both instants measured in
         * server time: its `proofAt` came from the envelope of its own request and
         * `ts` from the collection's newest row. In the Phase 5 incident the two
         * were 209 ms apart in the wrong direction, so that tab revalidated exactly
         * as it does today. `SKEW_GUARD_MS` widens the proof to cover measurement
         * error; anything inside the guard revalidates.
         */
        this.cursor[module] = ts
        this.notify(module, ts)
        continue
      }
      if (ts > prev) {
        this.cursor[module] = ts
        this.notify(module)
      }
    }
  }

  /**
   * Fan one module out to its listeners. A throwing listener must not stop the
   * others.
   *
   * `firstSnapshot` is the module's very first cursor value, and the only place
   * where a subscriber may be skipped: it has already read the module after the
   * newest write inside it, so re-reading would be a duplicate rather than a
   * correction. A genuine advance is always broadcast in full — a proof about one
   * subscriber's data says nothing about another's on that path, because the
   * write it is reacting to postdates every read on screen.
   *
   * Either kind of signal is *held* while that subscriber has a read outstanding,
   * and decided when the read answers (see `flushHeld`). Holding is not
   * suppressing: a signal that cannot be proved already-seen is still delivered.
   */
  private notify(module: SyncModule, firstSnapshot?: number): void {
    const set = this.listeners.get(module)
    if (!set) return
    for (const registration of set) {
      if (registration.pending > 0) {
        if (firstSnapshot === undefined) registration.heldAdvance = true
        else if (
          registration.heldSnapshot === undefined ||
          firstSnapshot > registration.heldSnapshot
        ) {
          registration.heldSnapshot = firstSnapshot
        }
        continue
      }
      if (firstSnapshot !== undefined && isProvenFresh(registration.proofAt, firstSnapshot)) {
        continue
      }
      this.invoke(registration)
    }
  }

  /**
   * A held signal is judged with the evidence its in-flight read just produced:
   * if that read demonstrably began after the write the cursor is reporting,
   * the rows arriving are the ones the signal was going to fetch, and firing the
   * listener would be a pure duplicate. Anything else — including a read that
   * failed or aborted and so proved nothing — is delivered.
   */
  private flushHeld(registration: Registration): void {
    if (registration.pending > 0) return
    const advance = registration.heldAdvance
    const snapshot = registration.heldSnapshot
    registration.heldAdvance = false
    registration.heldSnapshot = undefined
    if (!advance && snapshot === undefined) return
    if (!advance && snapshot !== undefined && isProvenFresh(registration.proofAt, snapshot)) {
      return
    }
    this.invoke(registration)
  }

  private invoke(registration: Registration): void {
    try {
      registration.listener()
    } catch {
      /* one bad listener must not break the fan-out to the others */
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
