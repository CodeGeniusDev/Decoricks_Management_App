/**
 * Phase 3 synchronisation: an archive must reach the other device.
 *
 * The brief's acceptance criterion is that "archive and restore changes
 * propagate correctly" across sessions without a page refresh. Mechanically,
 * that hinges on one lookup table entry — `chatChannels` maps to the `chat`
 * sync module — and on the change-stream handler being the thing that reads it.
 * A mapping constant alone is not evidence; a signal arriving on the bus when a
 * document moves is.
 *
 * So this drives the REAL watcher against a fake change stream and observes the
 * process bus, which is exactly the seam between "Mongo wrote a row" and "every
 * open SSE connection was told to re-fetch its chat data".
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { RealtimeSignal } from '../types'
import { realtimeBus } from '../bus'
// `vi.mock` below is hoisted above the imports, so the watcher's `getDatabase()`
// is already the fake by the time this module body runs.
import { ensureChangeStreamWatcher } from '../watcher'

type LooseChange = { ns?: { coll?: string }; clusterTime?: { t: number; i?: number } }

let queue: LooseChange[] = []
let wake: (() => void) | null = null

function emit(change: LooseChange): void {
  queue.push(change)
  wake?.()
  wake = null
}

/** Never-ending generator: yields queued events, otherwise stays parked. */
async function* fakeStream(): AsyncGenerator<LooseChange> {
  for (;;) {
    while (queue.length) yield queue.shift()!
    await new Promise<void>((resolve) => {
      wake = resolve
    })
  }
}

/**
 * The shape the driver actually hands back from `db.watch()`: a cursor with a
 * `tryNext()` (which is what the readiness handshake awaits — the initial
 * aggregate returns an empty batch, so it answers `null` and proves the round
 * trip) and the async iterator `for await` consumes afterwards. A bare
 * generator satisfied the old fire-and-forget watcher but not this one.
 */
const fakeChangeStream = () => ({
  tryNext: async (): Promise<LooseChange | null> => (queue.length ? queue.shift()! : null),
  [Symbol.asyncIterator]: () => fakeStream(),
})

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => ({
    databaseName: 'decoricks_test',
    watch: () => fakeChangeStream(),
  })),
}))

/** Lets the watcher's `for await` loop drain the events pushed so far. */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

const signals: RealtimeSignal[] = []
let unsubscribe: (() => void) | null = null

beforeAll(() => {
  // The watcher guards itself against a second stream per process; reset that
  // latch so this file starts its own loop against the mocked database.
  global._decoricksChangeStreamStarted = undefined
  unsubscribe = realtimeBus.subscribe((s) => signals.push(s))
  ensureChangeStreamWatcher()
})

afterAll(() => {
  unsubscribe?.()
  global._decoricksChangeStreamStarted = undefined
})

describe('Phase 3 change-stream propagation', () => {
  it('a channel write (archive/restore) publishes a dataless chat signal', async () => {
    const before = signals.length
    emit({ ns: { coll: 'chatChannels' }, clusterTime: { t: 1_700_000_000 } })
    await settle()

    const fresh = signals.slice(before)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].module).toBe('chat')
    // Phase 5 revised this expectation. The signal used to carry the raw
    // cluster token as epoch-ms; `nextSignalTs` in `../watcher` now publishes
    // `max(appClockMs(), clusterTime)`, because the polling cursor a client
    // adopts its baseline from is built of application-clock `updatedAt` values.
    // A stale or foreign-domain cluster token must never drag a signal BELOW
    // that baseline — that suppression was the second root cause of live frames
    // never firing. So the claim here is a floor, not an equality; the strict
    // monotonicity guarantee is covered per-module in `watcher.test.ts`.
    expect(fresh[0].ts).toBeGreaterThanOrEqual(1_700_000_000_000)
    expect(Number.isSafeInteger(fresh[0].ts)).toBe(true)
    // The signal says only "chat moved" — no document, no channel name, no body.
    expect(JSON.stringify(fresh[0])).not.toContain('chatChannels')
  })

  it('a message write publishes the same chat module as a channel write', async () => {
    const before = signals.filter((s) => s.module === 'chat').length
    emit({ ns: { coll: 'messages' }, clusterTime: { t: 1_700_000_001 } })
    await settle()
    expect(signals.filter((s) => s.module === 'chat').length).toBe(before + 1)
  })

  it('a burst of chat writes is one signal bumped, so clients fetch once', async () => {
    const before = signals.length
    emit({ ns: { coll: 'chatChannels' }, clusterTime: { t: 1_700_000_010 } })
    emit({ ns: { coll: 'messages' }, clusterTime: { t: 1_700_000_011 } })
    await settle()

    const burst = signals.slice(before)
    expect(burst.length).toBeGreaterThan(1)
    // Same module at the buffer tail → the id does not advance. Two deliveries,
    // one frame: a reconnecting client replays a single refetch, not a backlog.
    expect(new Set(burst.map((s) => s.id)).size).toBe(1)
    // And the timestamp never moves backwards, whichever order they arrived in.
    // It is not equal to the second cluster token any more — see the note in
    // test 1: the app-clock domain wins when the cluster token is behind it.
    const marks = burst.map((s) => s.ts)
    expect(marks.every((t, i) => i === 0 || t >= marks[i - 1])).toBe(true)
    expect(marks[marks.length - 1]).toBeGreaterThanOrEqual(1_700_000_011_000)
  })

  it('leaves collections the chat module does not own alone', async () => {
    const before = signals.length
    // A financial write must not wake chat subscribers, and an audit row —
    // written by every archive — must not wake anything at all.
    // `transactions` is the real finance collection name; the mapping used to
    // read `ledger`, which no change stream ever reports (see Phase 5 §3).
    emit({ ns: { coll: 'transactions' }, clusterTime: { t: 1_700_000_020 } })
    emit({ ns: { coll: 'auditLog' }, clusterTime: { t: 1_700_000_021 } })
    emit({ clusterTime: { t: 1_700_000_022 } })
    await settle()

    const fresh = signals.slice(before)
    expect(fresh.map((s) => s.module)).not.toContain('chat')
  })
})
