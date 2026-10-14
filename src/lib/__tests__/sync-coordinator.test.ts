import { describe, it, expect, vi } from 'vitest'
import { SyncCoordinator } from '@/lib/sync/coordinator'
import type { SyncCursor, SyncModule, SyncTransport } from '@/lib/sync/types'

/**
 * The coordinator's behaviour is what makes realtime *correct* rather than just
 * present: fire only on a genuine advance, only to the right module, exactly one
 * shared transport, clean teardown, and no spurious refresh on a first snapshot.
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
  it('adopts a never-seen module silently as a baseline (no refresh on first snapshot)', () => {
    const { coordinator, fake } = makeCoordinator()
    const listener = vi.fn()
    coordinator.subscribe('tasks', listener)

    fake.emit({ tasks: 1000 })
    expect(listener).not.toHaveBeenCalled()
  })

  it('fires only when a module timestamp actually advances', () => {
    const { coordinator, fake } = makeCoordinator()
    const listener = vi.fn()
    coordinator.subscribe('tasks', listener)

    fake.emit({ tasks: 1000 }) // baseline
    fake.emit({ tasks: 900 }) // stale/older — ignored
    fake.emit({ tasks: 1000 }) // equal — ignored
    expect(listener).not.toHaveBeenCalled()

    fake.emit({ tasks: 1500 }) // genuine advance
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('fans out only to the module that changed', () => {
    const { coordinator, fake } = makeCoordinator()
    const tasks = vi.fn()
    const chat = vi.fn()
    coordinator.subscribe('tasks', tasks)
    coordinator.subscribe('chat', chat)

    fake.emit({ tasks: 100, chat: 100 }) // baselines
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
    fake.emit({ tasks: 1000 }) // baseline at 1000
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

    fake.emit({ tasks: 1 }) // baseline
    expect(() => fake.emit({ tasks: 2 })).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
  })

  it('supports every sync module', () => {
    const { coordinator, fake } = makeCoordinator()
    const modules: SyncModule[] = ['tasks', 'chat', 'sales', 'inventory', 'finance']
    const spies = modules.map((m) => {
      const fn = vi.fn()
      coordinator.subscribe(m, fn)
      return { m, fn }
    })

    fake.emit(Object.fromEntries(modules.map((m) => [m, 1])) as SyncCursor) // baselines
    spies.forEach((s) => s.fn.mockClear())

    fake.emit(Object.fromEntries(modules.map((m) => [m, 2])) as SyncCursor)
    spies.forEach((s) => expect(s.fn).toHaveBeenCalledTimes(1))
  })
})
