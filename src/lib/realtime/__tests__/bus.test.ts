/**
 * Realtime bus unit tests (Phase 7).
 *
 * The bus is the server's source of truth for two guarantees the brief names
 * explicitly — event ORDERING and RESUME-FROM-LAST-EVENT — so they are tested
 * here directly, without a socket or a database. Everything is a pure,
 * synchronous, in-process object.
 */
import { describe, it, expect, vi } from 'vitest'
import { RealtimeBus } from '@/lib/realtime/bus'

describe('RealtimeBus ordering', () => {
  it('assigns strictly monotonic ids and keeps the buffer oldest → newest', () => {
    const bus = new RealtimeBus()
    const a = bus.publish('chat', 100)
    const b = bus.publish('tasks', 200)
    const c = bus.publish('finance', 300)

    expect([a.id, b.id, c.id]).toEqual(['1', '2', '3'])
    expect(bus.latestId()).toBe('3')
    expect(a.module).toBe('chat')
    expect(b.module).toBe('tasks')
  })

  it('coalesces a same-module burst at the tail into one signal (no dupes, no reorder)', () => {
    const bus = new RealtimeBus()
    const first = bus.publish('tasks', 100)
    // A second `tasks` write while it is still the newest advances its ts
    // in place rather than appending a second frame — one refetch, not two.
    const bumped = bus.publish('tasks', 250)

    expect(bumped.id).toBe(first.id) // same id, not a new one
    expect(bumped.ts).toBe(250) // newest ts wins
    expect(bus.latestId()).toBe('1') // the tail was never grew the sequence

    // A different module interleaved DOES get its own id and does not disturb it.
    const other = bus.publish('chat', 300)
    expect(other.id).toBe('2')
  })

  it('never lets an older ts move the tail backwards', () => {
    const bus = new RealtimeBus()
    bus.publish('tasks', 500)
    const stale = bus.publish('tasks', 100) // out-of-order, older timestamp
    expect(stale.ts).toBe(500) // Math.max keeps the high-water mark
  })

  it('fans a published signal out to every subscriber and survives a throwing one', () => {
    const bus = new RealtimeBus()
    const bad = vi.fn(() => {
      throw new Error('bad listener')
    })
    const good = vi.fn()
    bus.subscribe(bad)
    const unsub = bus.subscribe(good)

    const signal = bus.publish('chat', 42)
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledWith(signal)

    unsub()
    bus.publish('chat', 43)
    expect(good).toHaveBeenCalledTimes(1) // no longer subscribed
  })
})

describe('RealtimeBus resume-from-last-event', () => {
  it('replays exactly the signals strictly after the client id, with no gap', () => {
    const bus = new RealtimeBus()
    bus.publish('chat', 1) // id 1
    bus.publish('tasks', 2) // id 2
    bus.publish('finance', 3) // id 3

    const { signals, gap } = bus.replayAfter('1')
    expect(gap).toBe(false)
    expect(signals.map((s) => s.id)).toEqual(['2', '3'])
  })

  it('a first connect (no / malformed id) replays nothing and is not a gap', () => {
    const bus = new RealtimeBus()
    bus.publish('chat', 1)
    expect(bus.replayAfter('')).toEqual({ signals: [], gap: false })
    expect(bus.replayAfter('not-a-number')).toEqual({ signals: [], gap: false })
  })

  it('an id ahead of anything issued means the process restarted → gap', () => {
    const bus = new RealtimeBus()
    bus.publish('chat', 1)
    const { signals, gap } = bus.replayAfter('99')
    expect(gap).toBe(true)
    expect(signals).toEqual([])
  })

  it('reports a gap once the requested point has aged out of the buffer', () => {
    // Buffer of 2: ids 3 and 4 evict 1 and 2.
    const bus = new RealtimeBus(2)
    bus.publish('chat', 1) // id 1 (evicted)
    bus.publish('tasks', 2) // id 2 (evicted)
    bus.publish('finance', 3) // id 3
    bus.publish('sales', 4) // id 4

    // Client resumes from id 1, but 1 and 2 are gone → cannot produce a
    // continuous run, so it must reconcile via one poll instead.
    const { signals, gap } = bus.replayAfter('1')
    expect(gap).toBe(true)
    expect(signals).toEqual([])
  })

  it('resuming from the exact evicted boundary replays the retained tail with no gap', () => {
    const bus = new RealtimeBus(2)
    bus.publish('chat', 1) // evicted later
    bus.publish('tasks', 2) // oldest retained
    bus.publish('finance', 3) // newest retained

    // id 2 is the oldest retained; strictly-after-2 is exactly [3]. Continuous.
    const { signals, gap } = bus.replayAfter('2')
    expect(gap).toBe(false)
    expect(signals.map((s) => s.id)).toEqual(['3'])
  })
})
