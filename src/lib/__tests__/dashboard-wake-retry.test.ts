import { describe, it, expect } from 'vitest'

import {
  runWakeRetry,
  wakeSchedule,
  isWakeWorthy,
  WAKE_BASE_MS,
  WAKE_FACTOR,
  WAKE_WINDOW_MS,
  WAKE_WORTHY,
  type WakePhase,
} from '@/lib/dashboard/wake-retry'
import {
  MAX_ATTEMPTS,
  applySyncOutcome,
  classifySyncResponse,
  isDrainable,
  networkFailureOutcome,
  shouldReportFailure,
} from '@/lib/offline/state'
import type { QueueEntry } from '@/lib/offline/types'

/**
 * Cold-start recovery, tested as a pure state machine.
 *
 * The report this exists for: opening the deployed app after the free Render
 * instance had slept showed "Couldn't load the dashboard / Failed to fetch" and a
 * header chip reading **Offline** — on a phone with a full signal bar. It
 * recovered by itself a few seconds later, which is the whole point: the server
 * was booting, and the UI described that as two failures that had not happened.
 *
 * So the contract under test is not "did it retry" — retrying is easy. It is
 * **which of the three sentences the user is allowed to read, and when**:
 *
 *   still waiting  → `waking`, and no error
 *   no network     → `offline`, and only when the browser actually said so
 *   genuinely over → `failed`, with the classified message
 *
 * Every case that must NOT say offline is a case where an earlier implementation
 * did, which is why they are here rather than being folded into one test.
 *
 * No DOM, no fake timers: `sleep`, `now` and the attempt itself are injected, so
 * a 90-second window runs in microseconds and the clock advances exactly where a
 * test says it should. That is the same reason `snapshot-fetch` is a plain
 * function — `vitest.config.ts` is `environment: 'node'`.
 */

interface Outcome {
  ok: boolean
  kind: string
  message: string
  offline?: boolean
  aborted?: boolean
  /** Carry-through payload so a test can tell which success it is looking at. */
  value?: number
}

const succeeded = (n: number): Outcome => ({ ok: true, kind: 'ok', message: '', value: n })
const failed = (kind: string, message = `msg:${kind}`, extra: Partial<Outcome> = {}): Outcome => ({
  ok: false,
  kind,
  message,
  ...extra,
})

const classify = (o: Outcome) => ({
  ok: o.ok,
  kind: o.kind,
  message: o.message,
  offline: o.offline === true,
  aborted: o.aborted === true,
})

/** How long a single attempt burns on the wire in these tests. */
const ATTEMPT_MS = 5

/**
 * A harness with a hand-wound clock. Every attempt costs `ATTEMPT_MS` rather than
 * nothing, because a window bound is untestable otherwise: a zero-cost attempt
 * makes "the loop must stop at 90s of wall clock" indistinguishable from "the loop
 * must stop after 7 tries", which are two different promises.
 */
const harness = (options: { windowMs?: number } = {}) => {
  let clock = 0
  const sleeps: number[] = []
  const phases: WakePhase[] = []
  const attempts: number[] = []

  return {
    phases,
    sleeps,
    attempts,
    get now() {
      return clock
    },
    advance: (ms: number) => {
      clock += ms
    },
    /**
     * `supersededAfter` is the number of attempts the caller is willing to see
     * before it switches range and replaces this read — checked before each pause
     * and again after each attempt, exactly as the loop documents.
     */
    run: (results: Outcome[], opts: { supersededAfter?: number } = {}) => {
      let i = 0
      return runWakeRetry(
        async () => {
          attempts.push(clock)
          const result = results[Math.min(i, results.length - 1)]
          i += 1
          clock += ATTEMPT_MS
          return result
        },
        {
          classify,
          superseded: () => opts.supersededAfter !== undefined && i >= opts.supersededAfter,
          sleep: async (ms: number) => {
            sleeps.push(ms)
            clock += ms
          },
          now: () => clock,
          windowMs: options.windowMs,
          onPhase: (p: WakePhase) => phases.push(p),
        }
      )
    },
  }
}

/* -------------------------------------------------------------------------- */

describe('wakeSchedule — the doubling the brief asked for', () => {
  it('starts at 1s and doubles', () => {
    expect(wakeSchedule(90_000).slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000])
  })

  it('sums to exactly the window, truncating the last delay', () => {
    const delays = wakeSchedule(WAKE_WINDOW_MS)
    expect(delays.reduce((a, b) => a + b, 0)).toBe(WAKE_WINDOW_MS)
    // 1+2+4+8+16+32 = 63, so the tail is the 27s left over — not a 64s doubling
    // that would have overshot the budget by a third.
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 27_000])
  })

  it('never emits a delay that overshoots, at any window', () => {
    for (const windowMs of [1, 500, 999, 1_000, 1_500, 30_000, 90_000, 123_456]) {
      const delays = wakeSchedule(windowMs)
      expect(delays.reduce((a, b) => a + b, 0)).toBe(windowMs)
      expect(delays.every((d) => d > 0)).toBe(true)
    }
  })

  it('says "do not retry" by returning no delays rather than by special-casing', () => {
    expect(wakeSchedule(0)).toEqual([])
    expect(wakeSchedule(-5)).toEqual([])
  })
})

describe('isWakeWorthy — which failures are worth 90 seconds', () => {
  it('treats the four "the server was not ready" kinds as wake-worthy', () => {
    for (const kind of WAKE_WORTHY) expect(isWakeWorthy(kind)).toBe(true)
    expect(['timeout', 'network', 'server', 'bad-response'].every(isWakeWorthy)).toBe(true)
  })

  it('refuses to wait on a failure that waiting cannot change', () => {
    // A 401 retried for 90s is a session-expired tab issuing dozens of requests.
    for (const kind of ['unauthorized', 'forbidden', 'client', 'offline', 'aborted'])
      expect(isWakeWorthy(kind)).toBe(false)
  })

  it('is closed about unknown kinds — an unexpected value never starts a loop', () => {
    expect(isWakeWorthy('nonsense')).toBe(false)
    expect(isWakeWorthy('')).toBe(false)
  })
})

describe('runWakeRetry — the three sentences and when each is allowed', () => {
  it('a read that succeeds first time spends no budget and says nothing', async () => {
    const h = harness()
    const result = await h.run([succeeded(1)])
    expect(result).toEqual(succeeded(1))
    expect(h.sleeps).toEqual([])
    expect(h.phases).toEqual([])
    expect(h.attempts).toHaveLength(1)
  })

  it('a network failure while online is WAITING, not an error', async () => {
    // This is the reported bug in one line: `fetch()` rejecting because the
    // instance is booting must produce `waking`, and must not produce `failed`.
    const h = harness({ windowMs: 90_000 })
    const result = await h.run([failed('network'), succeeded(2)])
    expect(result).toEqual(succeeded(2))
    expect(h.phases[0]).toEqual({
      status: 'waking',
      attempt: 1,
      retryInMs: 1_000,
      elapsedMs: expect.any(Number),
    })
    expect(h.phases.some((p) => p.status === 'failed')).toBe(false)
    expect(h.sleeps[0]).toBe(1_000)
  })

  it('recovers when the server comes up partway through the schedule', async () => {
    const h = harness({ windowMs: 90_000 })
    const result = await h.run([
      failed('network'),
      failed('timeout'),
      failed('server'),
      succeeded(4),
    ])
    expect(result).toEqual(succeeded(4))
    expect(h.sleeps).toEqual([1_000, 2_000, 4_000])
    // The loop reports `idle` on recovery so the caller can drop the notice,
    // rather than leaving the UI to guess that a later success implies one.
    expect(h.phases.at(-1)).toEqual({ status: 'idle' })
  })

  it('a browser that reports no connectivity is believed, and costs one request', async () => {
    // The ONLY path allowed to say offline. Zero retries is the point: burning a
    // 90s window dialling a network that is gone is worse than the original bug.
    const h = harness({ windowMs: 90_000 })
    const result = await h.run([failed('offline', "You're offline.", { offline: true })])
    expect(h.phases).toEqual([{ status: 'offline' }])
    expect(h.sleeps).toEqual([])
    expect(h.attempts).toHaveLength(1)
    expect(result.kind).toBe('offline')
  })

  it('stops the window the moment connectivity drops mid-retry', async () => {
    const h = harness({ windowMs: 90_000 })
    await h.run([failed('network'), failed('network'), failed('offline', '', { offline: true })])
    expect(h.phases.at(-1)).toEqual({ status: 'offline' })
    // Two pauses spent, not the whole schedule — it quit as soon as it knew.
    expect(h.sleeps).toEqual([1_000, 2_000])
  })

  it('does not wait on a 401, and reports its message immediately', async () => {
    const h = harness({ windowMs: 90_000 })
    const result = await h.run([failed('unauthorized', 'Your session has ended.')])
    expect(h.sleeps).toEqual([])
    expect(h.attempts).toHaveLength(1)
    expect(h.phases).toEqual([
      {
        status: 'failed',
        message: 'Your session has ended.',
        kind: 'unauthorized',
        spentMs: ATTEMPT_MS,
      },
    ])
    expect(result.kind).toBe('unauthorized')
  })

  it('reports failure with the last message once the window is genuinely out', async () => {
    const h = harness({ windowMs: 7_000 })
    const result = await h.run([failed('network', "Couldn't reach the server.")])
    expect(result.kind).toBe('network')
    // The notice is gone by now: the error card is what the user reads next, and
    // a banner promising "retrying…" above "Couldn't load the dashboard" is two
    // statements that cannot both be true.
    expect(h.phases.at(-1)).toEqual({
      status: 'failed',
      message: "Couldn't reach the server.",
      kind: 'network',
      spentMs: h.now,
    })
    // The window is consumed as wall clock — pauses *and* attempts together — so
    // the only thing past it is the attempt already on the wire when the tail
    // finished. That is the overrun the file header promises: one attempt, not a
    // whole leftover schedule.
    expect(h.now).toBeGreaterThanOrEqual(7_000)
    expect(h.now).toBeLessThanOrEqual(7_000 + ATTEMPT_MS)
    // The final pause was truncated to fit (the naive doubling wanted 4000).
    expect(h.sleeps.at(-1)).toBeLessThan(4_000)
  })

  it('honours the window as WALL-CLOCK, not as a count of pauses', async () => {
    /*
     * The bug this case exists to prevent. A precomputed delay list bounds only
     * the sleeping; each attempt in `snapshot-fetch` can spend its own 20s
     * timeout on top. Seven pauses of a 90s schedule plus seven timeouts is a
     * three-minute wait advertised as ninety seconds — which is a longer, worse
     * version of the thing being fixed.
     */
    const TIMEOUT_MS = 20_000
    const h = harness({ windowMs: 90_000 })
    const slow: Outcome[] = []
    let tries = 0
    const result = await runWakeRetry(
      async () => {
        h.advance(TIMEOUT_MS)
        tries += 1
        slow.push(failed('timeout'))
        return slow[slow.length - 1]
      },
      {
        classify,
        superseded: () => false,
        sleep: async (ms: number) => {
          h.sleeps.push(ms)
          h.advance(ms)
        },
        now: () => h.now,
        windowMs: 90_000,
        onPhase: (p) => h.phases.push(p),
      }
    )
    expect(result.kind).toBe('timeout')
    // A precomputed [1,2,4,8,16,32,27] list would have slept 90s on top of five
    // 20s timeouts. Growing each pause from the LIVE remainder instead, the
    // sleeping is only what is left over — and the last one is truncated to it.
    expect(h.sleeps).toEqual([1_000, 2_000, 4_000, 3_000])
    // Five attempts, not seven: the loop quits on the clock.
    expect(tries).toBe(5)
    // The deadline is reached and crossed by exactly one in-flight attempt — the
    // bound the file header promises — rather than by a leftover schedule.
    expect(h.now).toBeGreaterThanOrEqual(90_000)
    expect(h.now).toBeLessThanOrEqual(90_000 + TIMEOUT_MS)
    expect(h.phases.at(-1)?.status).toBe('failed')
    expect(h.phases.at(-1)).toMatchObject({ spentMs: h.now })
  })

  it('a zero window retries nothing at all', async () => {
    const h = harness({ windowMs: 0 })
    await h.run([failed('network')])
    expect(h.sleeps).toEqual([])
    expect(h.attempts).toHaveLength(1)
    expect(h.phases[0].status).toBe('failed')
  })

  it('stops before the next pause when the caller has already moved on', async () => {
    // A period switch mid-backoff: the old loop must not spend another request.
    const h = harness({ windowMs: 90_000 })
    await h.run([failed('network'), succeeded(9)], { supersededAfter: 1 })
    expect(h.attempts).toHaveLength(1)
    expect(h.sleeps).toEqual([])
    // Leaving silently: the new read owns the screen now, so no `failed` phase
    // would be shown and no notice would be cleared by this loop.
    expect(h.phases).toEqual([])
  })

  it('treats an aborted read as silence, not as a failure to report', async () => {
    const h = harness({ windowMs: 90_000 })
    await h.run([failed('aborted', '', { aborted: true })])
    expect(h.phases).toEqual([])
    expect(h.sleeps).toEqual([])
  })

  it('stops the loop when a wake-worthy run is interrupted by a kind waiting cannot fix', async () => {
    // Server booting (network) then rejecting the range (client). Continuing to
    // poll a request the server actively refuses is a bug, not a recovery.
    const h = harness({ windowMs: 90_000 })
    const result = await h.run([failed('network'), failed('client', 'Bad range.')])
    expect(result.kind).toBe('client')
    expect(h.sleeps).toEqual([1_000])
    expect(h.phases.at(-1)).toEqual({
      status: 'failed',
      message: 'Bad range.',
      kind: 'client',
      spentMs: h.now,
    })
  })
})

describe('the schedule constants are the ones the brief named', () => {
  it('1s base, doubling, 90s window', () => {
    expect(WAKE_BASE_MS).toBe(1_000)
    expect(WAKE_FACTOR).toBe(2)
    expect(WAKE_WINDOW_MS).toBe(90_000)
  })

  it('is exported so a UI can promise the same number the loop will keep', () => {
    expect(wakeSchedule()).toEqual(wakeSchedule(WAKE_WINDOW_MS))
  })
})

/*
 * The other half of the same ten seconds.
 *
 * A cold Render instance does not only fail the dashboard read — it fails every
 * queued write the user is carrying, and those live in a *different* state machine
 * (`lib/offline/state.ts`, with its own backoff and a permanent-failure flip that
 * notifies the owner). The brief asks that queued entries "behave correctly through
 * this", which is a claim about two files that do not talk to each other, so it is
 * asserted here where both policies are visible at once.
 *
 * What it shows is that the write ladder was already cold-start-shaped: five
 * attempts spread over 75 seconds, driven by a `transient`/`reachedServer:false`
 * classification that a rejected `fetch()` produces. The row stays drainable the
 * whole way and the drain POST itself is what wakes the instance. The one thing
 * that must not happen is the read policy and the write policy disagreeing about
 * what "the server was not there" means, and both of them name the same set.
 */
describe('the offline write queue survives the same cold start', () => {
  const T0 = 1_700_000_000_000

  /** A fresh row exactly as `enqueueCreate` would persist it. */
  const queuedRow = (): QueueEntry => ({
    id: 'row-1',
    userId: 'user-1',
    operation: 'create_finance',
    payload: {
      type: 'income',
      amount: 15_000_00,
      date: '2026-10-10',
      accountId: 'acct-1',
      category: 'client_payment',
      idempotencyKey: 'stable-key',
    },
    idempotencyKey: 'stable-key',
    status: 'pending',
    attempts: 0,
    createdAt: T0,
    updatedAt: T0,
  })

  /** Drives `applySyncOutcome` down the real ladder and reports each attempt time. */
  const ladder = (succeedOnAttempt: number) => {
    let row = queuedRow()
    const times: number[] = []
    let now = T0
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      times.push(now)
      // Eligibility is what the drain actually consults; a row that is not
      // drainable at this instant would never have been attempted at all.
      expect(isDrainable(row, now)).toBe(true)
      row = applySyncOutcome(
        row,
        i === succeedOnAttempt ? classifySyncResponse(201, null) : networkFailureOutcome(),
        now
      )
      if (row.status === 'synced') break
      now = row.nextRetryAt ?? now
    }
    return { row, times }
  }

  it('five attempts spread over 75 seconds outlast the boot the read layer waits for', () => {
    const { times } = ladder(99)
    expect(times).toEqual([T0, T0 + 5_000, T0 + 15_000, T0 + 35_000, T0 + 75_000])
    // The read layer promises up to 90s of waiting; the queue's last automatic
    // attempt is at 75s. A boot inside either budget is survived by both, and a
    // boot past BOTH is a real outage that deserves the failure notice.
    expect(times[times.length - 1] - T0).toBeGreaterThanOrEqual(60_000)
  })

  it('a server that comes up mid-ladder syncs the entry and reports nothing', () => {
    const { row } = ladder(4)
    expect(row.status).toBe('synced')
    expect(row.errorMessage).toBeUndefined()
  })

  it('the failure notice is withheld until the ladder is genuinely spent', () => {
    let row = queuedRow()
    let now = T0
    let reported = 0
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const before = row
      row = applySyncOutcome(row, networkFailureOutcome(), now)
      if (shouldReportFailure(before, row)) reported += 1
      now = row.nextRetryAt ?? now
    }
    // Exactly one, and only on the last step: `reachedServer` never became true,
    // so nothing the server said ever blamed the entry.
    expect(reported).toBe(1)
    expect(row.attempts).toBe(MAX_ATTEMPTS)
    expect(row.autoRetry).toBe(false)
  })

  it('both layers name the same kinds "the server was not there"', () => {
    // The drift check. If a wake-worthy read kind ever stopped being `transient`
    // in the queue's table, the dashboard would say "waking up" while the Sync
    // screen went permanently red over the identical event.
    expect(networkFailureOutcome().kind).toBe('transient')
    expect(networkFailureOutcome().reachedServer).toBe(false)
    expect(classifySyncResponse(503, null).kind).toBe('transient')
    expect(WAKE_WORTHY).toContain('server')
  })
})

/*
 * The seam between two files that must not drift. `snapshot-fetch` decides whether
 * ONE short retry is worth it; this file decides whether up to 90 seconds is worth
 * it. If those two sets ever disagree — say a new kind is added to one and not the
 * other — a failure would be retried by the inner policy and then refused by the
 * outer one, or the reverse, and neither is visible in the UI.
 */
describe('wake-worthiness and snapshot retryability agree on their overlap', () => {
  it('every wake-worthy kind is one snapshot-fetch will retry', async () => {
    const { isRetryableKind } = await import('@/lib/dashboard/snapshot-fetch')
    for (const kind of WAKE_WORTHY)
      expect(isRetryableKind(kind as Parameters<typeof isRetryableKind>[0])).toBe(true)
  })

  it('offline is refused by both, so no request is ever spent without a wire', async () => {
    const { isRetryableKind } = await import('@/lib/dashboard/snapshot-fetch')
    expect(isRetryableKind('offline')).toBe(false)
    expect(isWakeWorthy('offline')).toBe(false)
  })
})
