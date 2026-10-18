import type { SyncModule } from '@/lib/sync/types'
import type { RealtimeSignal } from './types'

/**
 * A tiny in-process pub/sub with a bounded replay window.
 *
 * Two jobs:
 *   1. Fan a published signal out to every live SSE connection in this process.
 *   2. Answer "give me everything after id N" for a reconnecting client, so a
 *      dropped connection that comes back within the buffer window misses no
 *      signal and the client's `Last-Event-ID` resume is exact.
 *
 * The id is a per-process monotonic counter, not a Mongo token. It only has to
 * be comparable and gap-free within a single process's buffer; across a restart
 * the buffer is empty, so `replayAfter` reports a gap and the client does one
 * full poll to reconcile — which the coordinator already knows how to do.
 *
 * Signals are de-duplicated *per module* against the buffer tail: if module X
 * already has a pending signal at the newest id, publishing X again just bumps
 * its timestamp rather than appending a second frame. A burst of writes to one
 * module therefore costs one refetch, not N, and never reorders.
 */

export class RealtimeBus {
  private seq = 0
  /** Oldest → newest. `buffer[0]` is the oldest retained signal. */
  private buffer: RealtimeSignal[] = []
  private listeners = new Set<(signal: RealtimeSignal) => void>()

  constructor(private readonly maxBuffer = 256) {}

  /** Highest issued id, as a string. `0` before the first publish. */
  latestId(): string {
    return String(this.seq)
  }

  publish(module: SyncModule, ts: number, userId?: string): RealtimeSignal {
    const last = this.buffer[this.buffer.length - 1]
    // Same module (and same user, for the user-scoped `notifications` stream)
    // still newest → advance its ts in place, do not grow the tail. Two users'
    // notifications must never collapse into one bumped signal, so the user id
    // is part of the coalescing key for that module.
    if (last && last.module === module && last.userId === userId) {
      const bumped: RealtimeSignal = { ...last, ts: Math.max(last.ts, ts) }
      this.buffer[this.buffer.length - 1] = bumped
      this.emit(bumped)
      return bumped
    }
    const signal: RealtimeSignal = { id: String(++this.seq), module, ts, userId }
    this.buffer.push(signal)
    if (this.buffer.length > this.maxBuffer) this.buffer.shift()
    this.emit(signal)
    return signal
  }

  subscribe(listener: (signal: RealtimeSignal) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Signals strictly after `lastId`. `gap` is true when we cannot produce a
   * continuous run from `lastId` to now — either the client resumed from an id
   * this process never issued (a restart) or the intervening signals were
   * already evicted. A gap means the caller must do one full reconcile, which
   * the coordinator does via a normal poll.
   */
  replayAfter(lastId: string): { signals: RealtimeSignal[]; gap: boolean } {
    const n = Number(lastId)
    // No / malformed resume token: nothing to replay, just stream live next.
    if (!lastId || Number.isNaN(n)) return { signals: [], gap: false }
    // An id ahead of anything we've issued belongs to a previous process.
    if (n > this.seq) return { signals: [], gap: true }

    const oldestId = this.buffer.length ? Number(this.buffer[0].id) : this.seq + 1
    // Anything strictly before the oldest retained signal may have been evicted.
    if (n < oldestId - 1) return { signals: [], gap: this.seq > this.buffer.length }

    const signals = this.buffer.filter((s) => Number(s.id) > n)
    return { signals, gap: false }
  }

  private emit(signal: RealtimeSignal): void {
    for (const listener of this.listeners) {
      try {
        listener(signal)
      } catch {
        // One broken subscriber must never stop the fan-out to the others.
      }
    }
  }
}

/**
 * Process singleton. Guarded on `globalThis` so Next's dev hot-reload reuses
 * one bus (and one id sequence) rather than spawning a fresh, un-resumable one
 * on every edit.
 */
declare global {
  // eslint-disable-next-line no-var
  var _decoricksRealtimeBus: RealtimeBus | undefined
}

export const realtimeBus: RealtimeBus =
  global._decoricksRealtimeBus ?? (global._decoricksRealtimeBus = new RealtimeBus())
