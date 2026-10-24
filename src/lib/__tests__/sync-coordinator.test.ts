import { describe, it, expect, vi } from 'vitest'
import { SyncCoordinator } from '@/lib/sync/coordinator'
import type { SyncCursor, SyncModule, SyncTransport } from '@/lib/sync/types'

/**
 * The coordinator's behaviour is what makes realtime *correct* rather than just
 * present: fire only on a genuine advance, only to the right module, exactly one
 * shared transport, clean teardown — and never swallow the first snapshot, which
 * is the case that can silently strand a cross-device write.
 *
 * We drive it with a fake transport so the fan-out semantics are tested without
 * timers or network — the transport is injectable precisely for this.
 */

function makeFakeTransport() {
  let onCursor: ((cursor: SyncCursor) => void) | null = null
  const transport: SyncTransport = {
    start: (cb) => {
      onCursor = cb
    },
    stop: () => {
      onCursor = null
    },
  }
  return {
    transport,
    // Emit a snapshot the way the real polling transport would.
    emit: (cursor: SyncCursor) => onCursor?.(cursor),
    get started() {
      return onCursor !== null
    },
  }
}

const makeCoordinator = () => {
  const fake = makeFakeTransport()
  const coordinator = new SyncCoordinator(() => fake.transport)
  return { coordinator, fake }
}

describe('SyncCoordinator', () => {
  /*
   * The first snapshot for a module is newer than whatever the page has on
   * screen: the mount fetch that painted the rows is issued by the same effect
   * that subscribes here, while the snapshot is taken after the connect round
   * trip. A write landing between the two is folded into that first value, so it
   * can never arrive as an advance — and the same frame also stops the polling
   * fallback, so swallowing it strands the change for the rest of the session.
   * Reproduced end to end in Phase 5 §3 (see `handleCursor`).
   */
  it('revalidates a subscribed module on its first snapshot instead of swallowing it', () => {
    const { coordinator, fake } = makeCoordinator()
    const listener = vi.fn()
    coordinator.subscribe('tasks', listener)

    fake.emit({ tasks: 1000 })
    expect(listener).toHaveBeenCalledTimes(1)

    // Once, not on every repeat of the same snapshot.
    fake.emit({ tasks: 1000 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('costs nothing for a module nobody is subscribed to', () => {
    const { coordinator, fake } = makeCoordinator()
    const tasks = vi.fn()
    coordinator.subscribe('tasks', tasks)

    expect(() => fake.emit({ tasks: 1000, chat: 1000, finance: 1000 })).not.toThrow()
    expect(tasks).toHaveBeenCalledTimes(1) // only the module with a listener

    // …and the unlistened modules are still baselined, so a later mount of one
    // of them must not revalidate for a change that predates it.
    const chat = vi.fn()
    coordinator.subscribe('chat', chat)
    fake.emit({ chat: 1000 })
    expect(chat).not.toHaveBeenCalled()
  })

  it('revalidates when a module timestamp changes in either direction', () => {
    const { coordinator, fake } = makeCoordinator()
    const listener = vi.fn()
    coordinator.subscribe('tasks', listener)

    fake.emit({ tasks: 1000 }) // first snapshot → the one revalidation
    expect(listener).toHaveBeenCalledTimes(1)

    fake.emit({ tasks: 1000 }) // equal — ignored
    expect(listener).toHaveBeenCalledTimes(1)

    // A decrease is a change, not a stale read. When the newest record in a
    // module is deleted or archived away, the maximum `updatedAt` the poll sees
    // moves backwards; under the earlier `ts > prev` rule that went unnoticed and
    // the deleted row stayed on the other session's screen.
    fake.emit({ tasks: 900 }) // decrease → revalidate
    expect(listener).toHaveBeenCalledTimes(2)

    fake.emit({ tasks: 1500 }) // genuine advance
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('fans out only to the module that changed', () => {
    const { coordinator, fake } = makeCoordinator()
    const tasks = vi.fn()
    const chat = vi.fn()
    coordinator.subscribe('tasks', tasks)
    coordinator.subscribe('chat', chat)

    fake.emit({ tasks: 100, chat: 100 }) // first snapshots
    tasks.mockClear()
    chat.mockClear()

    fake.emit({ tasks: 200 }) // only tasks advanced
    expect(tasks).toHaveBeenCalledTimes(1)
    expect(chat).not.toHaveBeenCalled()
  })

  it('keeps a single shared transport across many subscribers and stops it when the last unsubscribes', () => {
    const { coordinator, fake } = makeCoordinator()
    const startSpy = vi.spyOn(fake.transport, 'start')

    const unsubA = coordinator.subscribe('tasks', vi.fn())
    const unsubB = coordinator.subscribe('chat', vi.fn())
    expect(startSpy).toHaveBeenCalledTimes(1) // one transport, not one per subscriber
    expect(fake.started).toBe(true)

    unsubA()
    expect(fake.started).toBe(true) // still one subscriber left
    unsubB()
    expect(fake.started).toBe(false) // last one gone → transport torn down
  })

  it('retains the cursor across unsubscribe/resubscribe so a change in the gap is not missed', () => {
    const { coordinator, fake } = makeCoordinator()

    const first = vi.fn()
    const unsub = coordinator.subscribe('tasks', first)
    fake.emit({ tasks: 1000 }) // first snapshot at 1000
    unsub()

    fake.emit({ tasks: 2000 }) // change lands while nobody is subscribed

    const again = vi.fn()
    coordinator.subscribe('tasks', again)
    // The re-subscriber's first snapshot is compared against the retained 1000,
    // so a newer cursor must fire — this is the anti-"re-baseline and miss it" guard.
    fake.emit({ tasks: 2000 })
    expect(again).toHaveBeenCalledTimes(1)
  })

  it('one throwing listener must not break fan-out to the others', () => {
    const { coordinator, fake } = makeCoordinator()
    coordinator.subscribe('tasks', () => {
      throw new Error('bad listener')
    })
    const healthy = vi.fn()
    coordinator.subscribe('tasks', healthy)

    expect(() => fake.emit({ tasks: 1 })).not.toThrow() // first snapshot
    healthy.mockClear()
    expect(() => fake.emit({ tasks: 2 })).not.toThrow() // genuine advance
    expect(healthy).toHaveBeenCalledTimes(1)
  })

  /*
   * The rule above costs a request every document load unless the subscriber can
   * show it has *already* read the module after the newest write inside it. These
   * tests pin the proof down: it must fire on anything the proof cannot cover,
   * including by one millisecond and by a single second of clock/handler skew.
   *
   * `settleRead(serverTime, durationMs)` records where a read must have *begun*
   * (envelope completion minus the observed round trip), so the tests pass
   * `durationMs` explicitly wherever that shift is the point.
   */
  it('does not revalidate a subscriber that read the module after its newest write', () => {
    const { coordinator, fake } = makeCoordinator()
    const fn = vi.fn()
    const { settleRead } = coordinator.register('finance', fn)

    // Read completed at 50_000; the newest write in the module is 40_000, more
    // than the skew guard older. The rows on screen already contain it.
    settleRead(50_000)
    fake.emit({ finance: 40_000 })
    expect(fn).not.toHaveBeenCalled()

    // The baseline was still adopted, so a later change must be seen normally.
    fake.emit({ finance: 60_000 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('still revalidates the Phase 5 case: a write that landed after our read', () => {
    const { coordinator, fake } = makeCoordinator()
    const fn = vi.fn()
    const { settleRead } = coordinator.register('inventory', fn)

    // 11:09:12.383 served the row, 11:09:12.592 committed the write — in epoch ms
    // offsets, our read is *older* than the newest write, so nothing may be swallowed.
    settleRead(12_383)
    fake.emit({ inventory: 12_592 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('treats a write inside the skew guard as unseen', () => {
    // The envelope is stamped when the handler *finishes*, so a write moments
    // before it cannot be proven to have been included. 25_000 - 2_000 = 23_000,
    // which does not cover 24_000 → revalidate.
    const inside = makeCoordinator()
    const insideFn = vi.fn()
    inside.coordinator.register('tasks', insideFn).settleRead(25_000)
    inside.fake.emit({ tasks: 24_000 })
    expect(insideFn).toHaveBeenCalledTimes(1)

    // Exactly outside the guard on a fresh coordinator: 23_000 <= 25_000 - 2_000
    // → the read provably postdates the write, so nothing is re-fetched.
    const outside = makeCoordinator()
    const outsideFn = vi.fn()
    outside.coordinator.register('tasks', outsideFn).settleRead(25_000)
    outside.fake.emit({ tasks: 23_000 })
    expect(outsideFn).not.toHaveBeenCalled()
  })

  it('moves the proof back by the observed round trip, not by the completion', () => {
    const { coordinator, fake } = makeCoordinator()
    const fn = vi.fn()
    const { settleRead } = coordinator.register('tasks', fn)

    // Completed at 50_000 after a 10_000 ms wait, so the read can have begun no
    // later than 40_000. The guard puts the effective proof at 38_000: a write at
    // 39_000 could have been committed while this query was running, and treating
    // it as seen is how a colleague's change gets lost for the rest of a session.
    settleRead(50_000, 10_000)
    fake.emit({ tasks: 39_000 })
    expect(fn).toHaveBeenCalledTimes(1)

    // The same proof does cover a write older than the read's earliest start.
    fn.mockClear()
    const second = makeCoordinator()
    const secondFn = vi.fn()
    second.coordinator.register('tasks', secondFn).settleRead(50_000, 10_000)
    second.fake.emit({ tasks: 37_000 })
    expect(secondFn).not.toHaveBeenCalled()
  })

  it('judges the proof per subscriber, never per module', () => {
    const { coordinator, fake } = makeCoordinator()
    const table = vi.fn()
    const figures = vi.fn()
    const tableSub = coordinator.register('finance', table)
    coordinator.register('finance', figures)

    // The table has read the ledger; the overview figures have not read anything
    // yet. One shared module mark would let the table's freshness silence the
    // figures too, so the two must be decided separately.
    tableSub.settleRead(90_000)
    fake.emit({ finance: 40_000 })

    expect(table).not.toHaveBeenCalled()
    expect(figures).toHaveBeenCalledTimes(1)
  })

  it('a mark made after unsubscribing is dropped, not remembered', () => {
    const { coordinator, fake } = makeCoordinator()
    const fn = vi.fn()
    const sub = coordinator.register('chat', fn)
    sub.dispose()
    sub.settleRead(90_000)

    const again = vi.fn()
    coordinator.register('chat', again)
    fake.emit({ chat: 40_000 })
    expect(again).toHaveBeenCalledTimes(1)
  })

  it('an unparseable server timestamp never suppresses a revalidation', () => {
    const { coordinator, fake } = makeCoordinator()
    const fn = vi.fn()
    const { settleRead } = coordinator.register('sales', fn)

    settleRead(NaN)
    settleRead(null)
    settleRead(undefined)
    settleRead('40000' as unknown as number)
    fake.emit({ sales: 1 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  /*
   * The duplicate wave measured on the production build was a signal landing
   * *during* a read: nothing on screen was stale yet, but the listener fired and
   * put a second identical request beside the first. A signal that arrives while
   * a read is outstanding is therefore held and judged with the evidence that
   * read produces — holding is a deferral, never a suppression.
   */
  it('holds a first snapshot that lands during a read and drops it if the read answers it', () => {
    const { coordinator, fake } = makeCoordinator()
    const fn = vi.fn()
    const sub = coordinator.register('finance', fn)

    sub.beginRead()
    fake.emit({ finance: 40_000 })
    // Not yet: the read in flight may already contain that write.
    expect(fn).not.toHaveBeenCalled()

    // It completed at 50_000 having started by 48_000, which postdates 40_000
    // comfortably — so the held baseline describes rows already on screen.
    sub.settleRead(50_000, 2_000)
    expect(fn).not.toHaveBeenCalled()

    // The baseline was adopted, so a genuine advance still gets through.
    fake.emit({ finance: 60_000 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('delivers a held snapshot when the read that held it proves nothing', () => {
    const { coordinator, fake } = makeCoordinator()
    const fn = vi.fn()
    const sub = coordinator.register('finance', fn)

    sub.beginRead()
    fake.emit({ finance: 40_000 })
    expect(fn).not.toHaveBeenCalled()

    // Aborted/failed reads release the hold with no evidence, so the signal must
    // still fire — this is the path that must never lose a change.
    sub.abandonRead()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('always delivers a held genuine advance, however fresh the read is', () => {
    const { coordinator, fake } = makeCoordinator()
    const fn = vi.fn()
    const sub = coordinator.register('finance', fn)

    sub.beginRead()
    sub.settleRead(100_000) // proof far in the future of everything below
    fake.emit({ finance: 1 }) // first snapshot, swallowed by the proof

    // An advance is a write newer than the cursor, so no proof about a *past*
    // read can cover it. Held or not, it must be delivered.
    sub.beginRead()
    fake.emit({ finance: 5_000 })
    expect(fn).not.toHaveBeenCalled() // held while the read is outstanding
    sub.settleRead(6_000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('counts each outstanding read, so overlapping reads cannot release the hold early', () => {
    const { coordinator, fake } = makeCoordinator()
    const fn = vi.fn()
    const sub = coordinator.register('tasks', fn)

    sub.beginRead()
    sub.beginRead()
    fake.emit({ tasks: 40_000 })

    // One of the two answered, and late: the other is still outstanding, so the
    // hold stays on pure counting, before any evidence is consulted.
    sub.settleRead(50_000)
    expect(fn).not.toHaveBeenCalled()

    // The second read is abandoned with no proof. The evidence the first one
    // supplied still stands, and it covers this snapshot — so it is dropped.
    sub.abandonRead()
    expect(fn).not.toHaveBeenCalled()

    // Same shape with no proof anywhere: the held signal is delivered, because a
    // read that proved nothing cannot be claimed to have contained the write.
    const other = makeCoordinator()
    const otherFn = vi.fn()
    const otherSub = other.coordinator.register('tasks', otherFn)
    otherSub.beginRead()
    otherSub.beginRead()
    other.fake.emit({ tasks: 40_000 })
    otherSub.settleRead(null)
    expect(otherFn).not.toHaveBeenCalled()
    otherSub.abandonRead()
    expect(otherFn).toHaveBeenCalledTimes(1)
  })

  it('supports every sync module', () => {
    const { coordinator, fake } = makeCoordinator()
    const modules: SyncModule[] = ['tasks', 'chat', 'sales', 'inventory', 'finance']
    const spies = modules.map((m) => {
      const fn = vi.fn()
      coordinator.subscribe(m, fn)
      return { m, fn }
    })

    fake.emit(Object.fromEntries(modules.map((m) => [m, 1])) as SyncCursor) // first snapshots
    spies.forEach((s) => s.fn.mockClear())

    fake.emit(Object.fromEntries(modules.map((m) => [m, 2])) as SyncCursor)
    spies.forEach((s) => expect(s.fn).toHaveBeenCalledTimes(1))
  })
})
