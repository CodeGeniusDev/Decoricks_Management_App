/**
 * Change-stream readiness handshake — Phase 5 §3 cold-start contract.
 *
 * `awaitChangeStreamOpen()` is what `/api/events` consults before it sends the
 * authoritative `cursor` baseline, and that baseline is what tells every client
 * to stand its polling fallback down (`onLiveSignal()` in `sync/sse-transport.ts`).
 * A false positive here is not a cosmetic bug: the connection claims liveness
 * while nothing is watching, and for that window the app has NO carrier at all.
 * A false negative merely keeps polling, which is correct but not instant.
 *
 * Kept in its own file because it needs a controllable `@/lib/mongodb` double
 * and fake timers, while `watcher.test.ts` asserts signal arithmetic against a
 * double that must never open a connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ChangeStreamDocument } from 'mongodb'
import type { SyncModule } from '@/lib/sync/types'

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => ({
    databaseName: 'decoricks_test',
    watch: () => watchImpl(),
  })),
}))

type FakeStream = {
  tryNext: () => Promise<ChangeStreamDocument | null>
  [Symbol.asyncIterator]: () => AsyncIterator<ChangeStreamDocument>
}

/** The stream `db.watch()` hands out on the next call. */
let watchImpl = (): FakeStream => {
  throw new Error('test forgot to install a fake change stream')
}

/**
 * A `tryNext()` that blocks until the test releases it — the only way to observe
 * the interval where a stream object exists but no cursor is live yet.
 */
let releaseTryNext!: () => void
const gatedTryNext = (): Promise<ChangeStreamDocument | null> =>
  new Promise((resolve) => {
    releaseTryNext = () => resolve(null)
  })

/** `tryNext()` that answers immediately, as a healthy cluster's empty batch does. */
const eagerTryNext = async (): Promise<ChangeStreamDocument | null> => null

/** An iterator parked forever: the watcher's `for await` never ends, as in life. */
const endlessIterator = (): AsyncIterator<ChangeStreamDocument> => ({
  next: () => new Promise<IteratorResult<ChangeStreamDocument>>(() => undefined),
})

const gatedStream = (): FakeStream => ({
  tryNext: gatedTryNext,
  [Symbol.asyncIterator]: endlessIterator,
})
const eagerStream = (): FakeStream => ({
  tryNext: eagerTryNext,
  [Symbol.asyncIterator]: endlessIterator,
})

let warnSpy: MockInstance
let logSpy: MockInstance

/** Loads a pristine watcher module — fresh `streamOpen`/`loggedOpen`/retry loop. */
async function loadWatcher() {
  vi.resetModules()
  const watcher = await import('@/lib/realtime/watcher')
  watcher.__resetChangeStreamState()
  // `ensureChangeStreamWatcher` is guarded on a process-level flag so a second
  // SSE connection in one host never starts a second stream. These tests drive
  // several lifecycles in one process, so the guard has to be cleared too.
  global._decoricksChangeStreamStarted = undefined
  global._decoricksLastSignalTs = undefined
  return watcher
}

beforeEach(() => {
  vi.useFakeTimers()
  watchImpl = gatedStream
  // The watcher's own diagnostics are part of the contract being asserted, so
  // they are captured rather than drowned in vitest's stdout.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('awaitChangeStreamOpen', () => {
  it('refuses to report readiness until the stream has done its server round trip', async () => {
    /*
     * `db.watch()` returns an object without contacting the database — the
     * initial aggregate is issued by the first `next()`. Treating "an object
     * exists" as "a cursor is live" is precisely the bug: the route sent the
     * baseline, the client stopped polling, and a write landed in the gap.
     */
    const watcher = await loadWatcher()
    let settled: 'pending' | boolean = 'pending'
    const ready = watcher.awaitChangeStreamOpen(5_000).then((ok: boolean) => {
      settled = ok
      return ok
    })

    watcher.ensureChangeStreamWatcher()
    await vi.advanceTimersByTimeAsync(1_000) // the gate is still closed

    expect(settled, 'readiness was reported before tryNext() returned').toBe('pending')

    releaseTryNext()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    await expect(ready).resolves.toBe(true)
  })

  it('times out as "not ready" rather than hanging the connection', async () => {
    // A paused free-tier cluster or a buffering proxy can leave the first getMore
    // pending indefinitely. The caller's timeout must win, so the route degrades
    // to polling instead of never finishing the handshake.
    const watcher = await loadWatcher()
    let settled: 'pending' | boolean = 'pending'
    void watcher.awaitChangeStreamOpen(500).then((ok: boolean) => {
      settled = ok
    })
    watcher.ensureChangeStreamWatcher()

    await vi.advanceTimersByTimeAsync(400)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(200)
    expect(settled).toBe(false)
  })

  it('gives up permanently and answers instantly where change streams do not exist', async () => {
    /*
     * A standalone `mongod` — the usual dev laptop database — rejects change
     * streams outright. Every connection would otherwise burn its full wait on
     * a stream that can never open, so the "unsupported" verdict is latched and
     * handed to later callers without another delay.
     */
    watchImpl = () => {
      throw new Error('The server does not support change streams: not a replica set')
    }
    const watcher = await loadWatcher()

    watcher.ensureChangeStreamWatcher()
    await vi.advanceTimersByTimeAsync(0)

    const started = Date.now()
    await expect(watcher.awaitChangeStreamOpen(5_000)).resolves.toBe(false)
    expect(Date.now() - started, 'gave up, yet the caller still waited for the timeout').toBe(0)
    expect(warnSpy).toHaveBeenCalledTimes(1) // once per process, not per connection
  })

  it('re-announces every module when a dropped stream comes back', async () => {
    /*
     * The watcher holds no resume token, so events from the dead window are gone.
     * Without a resync the outage is invisible: each tab's heartbeat keeps its
     * chip reading "Live" while the data behind it stays stale forever. A
     * per-module signal is dataless, permission-filtered at the route, and
     * idempotent — it costs one GET and repaints the same rows.
     */
    const watcher = await loadWatcher()
    const { realtimeBus } = await import('@/lib/realtime/bus')
    const { COLLECTION_MODULES } = await import('@/lib/realtime/types')

    const published: SyncModule[] = []
    const unsubscribe = realtimeBus.subscribe((s) => published.push(s.module))

    // One read, then the cluster kills the cursor.
    let reads = 0
    const streamOnceThenDie = (): FakeStream => ({
      tryNext: eagerTryNext,
      [Symbol.asyncIterator]: () => ({
        next: () => {
          reads += 1
          if (reads === 1) return Promise.reject(new Error('cursor killed by the cluster'))
          return new Promise<IteratorResult<ChangeStreamDocument>>(() => undefined) // parked again
        },
      }),
    })
    watchImpl = streamOnceThenDie

    watcher.ensureChangeStreamWatcher()
    await vi.advanceTimersByTimeAsync(0)
    expect(published, 'a stream that merely opened must not shout').toHaveLength(0)

    await vi.advanceTimersByTimeAsync(0) // the rejection is absorbed by the loop
    expect(published, 'nothing may be published while the stream is down').toHaveLength(0)

    // Backoff waits 2 s before the retry; the reopened stream is what fires.
    watchImpl = eagerStream
    await vi.advanceTimersByTimeAsync(2_000)

    const modules = [...new Set(Object.values(COLLECTION_MODULES) as SyncModule[])].sort()
    expect(published.sort(), 'every module must be re-read after a watcher outage').toEqual(modules)
    // One line per process: a stream flapping every few seconds must not flood
    // stdout, so "which database is this host watching?" stays answerable in a
    // production log instead of buried under repeats.
    const opens = logSpy.mock.calls.filter(([line]) => String(line).includes('change stream open'))
    expect(opens).toHaveLength(1)
    unsubscribe()
  })
})
