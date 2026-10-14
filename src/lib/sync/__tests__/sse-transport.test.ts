/**
 * SSE transport tests (Phase 7).
 *
 * Covers the transport-level guarantees the brief asks for that are testable
 * without a browser: automatic polling fallback, the reconnect backoff ladder,
 * and status transitions. We inject a fake `EventSource` / `window` / `navigator`
 * and mock the polling transport + connection store so the state machine is the
 * only thing under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const pollingStart = vi.fn()
const pollingStop = vi.fn()

vi.mock('@/lib/sync/transport', () => ({
  createPollingTransport: () => ({ start: pollingStart, stop: pollingStop }),
}))

const setConnection = vi.fn()
const markSeen = vi.fn()
vi.mock('@/lib/sync/connection', () => ({
  setConnection: (...a: unknown[]) => setConnection(...a),
  markSeen: (...a: unknown[]) => markSeen(...a),
}))

import { createSseTransport } from '@/lib/sync/sse-transport'
import type { SyncCursor } from '@/lib/sync/types'

/* ------------------------------ fake browser ----------------------------- */

class FakeEventSource {
  static CLOSED = 2
  static CONNECTING = 0
  static OPEN = 1

  /** Every constructed instance, in order, so a test can count re-opens. */
  static instances: FakeEventSource[] = []

  readyState = FakeEventSource.CONNECTING
  closed = false
  handlers: Record<string, (event: { data: string }) => void> = {}
  onerror: (() => void) | null = null

  constructor(
    public url: string,
    public init?: unknown
  ) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, cb: (event: { data: string }) => void): void {
    this.handlers[type] = cb
  }

  close(): void {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }

  /* test drivers */
  fireCursor(cursor: SyncCursor): void {
    this.readyState = FakeEventSource.OPEN
    this.handlers.cursor?.({ data: JSON.stringify(cursor) })
  }
  fireChange(module: string, ts: number): void {
    this.readyState = FakeEventSource.OPEN
    this.handlers.change?.({ data: JSON.stringify({ module, ts }) })
  }
  fireClosedError(): void {
    this.readyState = FakeEventSource.CLOSED
    this.onerror?.()
  }
}

const latest = (): FakeEventSource =>
  FakeEventSource.instances[FakeEventSource.instances.length - 1]

/* Node 22 defines `navigator` as a getter-only global, so a plain assignment
 * throws; defineProperty (and its inverse) installs and restores cleanly. */
const defineGlobal = (name: string, value: unknown): void => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}
const deleteGlobal = (name: string): void => {
  delete (globalThis as Record<string, unknown>)[name]
}

beforeEach(() => {
  FakeEventSource.instances = []
  pollingStart.mockClear()
  pollingStop.mockClear()
  setConnection.mockClear()
  markSeen.mockClear()

  vi.useFakeTimers()
  const listeners: Record<string, () => void> = {}
  defineGlobal('window', {
    addEventListener: (type: string, cb: () => void) => {
      listeners[type] = cb
    },
    removeEventListener: () => {},
  })
  defineGlobal('navigator', { onLine: true })
  defineGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  vi.useRealTimers()
  deleteGlobal('window')
  deleteGlobal('navigator')
  deleteGlobal('EventSource')
})

describe('createSseTransport', () => {
  it('opens a stream and reports connecting → live on the first real signal', () => {
    const onCursor = vi.fn()
    const t = createSseTransport()
    t.start(onCursor)

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(setConnection).toHaveBeenCalledWith('connecting', 'sse')

    latest().fireCursor({ chat: 10 })
    expect(setConnection).toHaveBeenCalledWith('live', 'sse')
    expect(onCursor).toHaveBeenCalledWith({ chat: 10 })
    t.stop()
  })

  it('monotonically merges per-module cursors and never lets one go backwards', () => {
    const onCursor = vi.fn()
    const t = createSseTransport()
    t.start(onCursor)

    latest().fireCursor({ chat: 100, tasks: 50 })
    latest().fireChange('chat', 80) // older chat value — must not regress
    const last = onCursor.mock.calls[onCursor.mock.calls.length - 1][0] as SyncCursor
    expect(last.chat).toBe(100)
    expect(last.tasks).toBe(50)
    t.stop()
  })

  it('falls back to polling when a live signal never lands within the handshake window', () => {
    const t = createSseTransport({ handshakeTimeoutMs: 1000 })
    t.start(vi.fn())

    expect(pollingStart).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(pollingStart).toHaveBeenCalledTimes(1) // watchdog opened the polling carrier
    t.stop()
  })

  it('a live signal stands the polling carrier back down', () => {
    const t = createSseTransport({ handshakeTimeoutMs: 1000 })
    t.start(vi.fn())
    vi.advanceTimersByTime(1000) // polling engaged
    pollingStop.mockClear()

    latest().fireChange('chat', 1) // real event → SSE is authoritative again
    expect(pollingStop).toHaveBeenCalledTimes(1)
    expect(setConnection).toHaveBeenLastCalledWith('live', 'sse')
    t.stop()
  })

  it('re-opens a hard-closed stream on an exponential backoff ladder', () => {
    const t = createSseTransport()
    t.start(vi.fn())
    expect(FakeEventSource.instances).toHaveLength(1)

    // First hard failure → schedule a reopen at the 3s base.
    latest().fireClosedError()
    expect(pollingStart).toHaveBeenCalled() // poll carries updates meanwhile
    vi.advanceTimersByTime(3000)
    expect(FakeEventSource.instances).toHaveLength(2)

    // Second failure → the delay doubles to 6s, not a flat retry.
    latest().fireClosedError()
    vi.advanceTimersByTime(3000)
    expect(FakeEventSource.instances).toHaveLength(2) // too early for the 6s timer
    vi.advanceTimersByTime(3000)
    expect(FakeEventSource.instances).toHaveLength(3)
    t.stop()
  })

  it('resets the backoff ladder once a stream goes live again', () => {
    const t = createSseTransport()
    t.start(vi.fn())

    latest().fireClosedError()
    vi.advanceTimersByTime(3000) // reopen → instance 2
    latest().fireCursor({ chat: 1 }) // live again, attempts reset to 0

    latest().fireClosedError()
    // After a reset the next reopen is back at the 3s base, not 6s.
    vi.advanceTimersByTime(3000)
    expect(FakeEventSource.instances).toHaveLength(3)
    t.stop()
  })

  it('tears everything down on stop — closes the stream, stops polling, clears timers', () => {
    const t = createSseTransport({ handshakeTimeoutMs: 1000 })
    t.start(vi.fn())
    vi.advanceTimersByTime(1000) // watchdog engages the polling carrier
    const es = latest()

    t.stop()
    expect(es.closed).toBe(true)
    expect(pollingStop).toHaveBeenCalled()
    expect(setConnection).toHaveBeenLastCalledWith('offline', 'polling')

    // A pending timer must not resurrect polling after we stopped.
    pollingStart.mockClear()
    vi.advanceTimersByTime(5000)
    expect(pollingStart).not.toHaveBeenCalled()
  })
})
