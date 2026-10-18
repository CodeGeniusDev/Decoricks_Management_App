/**
 * Phase 9 — Step 3 offline queue unit tests.
 *
 * The queue's guarantees are structural, so they are testable without a
 * browser: `state.ts` is pure (no Dexie, no DOM, no fetch) and `engine.ts`
 * takes its store and its POST as injected dependencies. These tests lock:
 *
 *   • THE STATE MACHINE — only the §6.2 edges exist; a `synced` row is a
 *     dead end and nothing can jump back into it.
 *   • BACKOFF — attempt N waits base × 2^(N-1) capped (§6.3), and only
 *     due rows are drainable; conflict/permanent-failed wait for the user.
 *   • IDEMPOTENT REPLAY — the key is minted at enqueue and NEVER
 *     regenerated: a row crashed in `syncing` is re-sent with the same
 *     key and the 200-replay path flips it to `synced` exactly once (§7).
 *   • RETRY-BUDGET RULES — a 401 session parks the row as `pending`
 *     without burning an attempt; the 5th transient failure reports
 *     `sync_failure` to the engine callback EXACTLY ONCE and stops.
 *
 * The UI summarizer is asserted against the same rows so the Sync screen,
 * the banner and the header chip can never disagree (§11).
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_ATTEMPTS,
  BASE_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  SYNCED_RETENTION_MS,
  applySyncOutcome,
  backoffDelayMs,
  canTransition,
  classifySyncResponse,
  entryForManualRetry,
  isDrainable,
  isExpiredSynced,
  networkFailureOutcome,
  shouldReportFailure,
} from '@/lib/offline/state'
import { createSyncEngine } from '@/lib/offline/engine'
import { createMemoryStore } from '@/lib/offline/store'
import { summarizeQueue } from '@/lib/offline/state-view'
import {
  META_LAST_SYNCED_AT,
  type FinanceCreatePayload,
  type QueueEntry,
} from '@/lib/offline/types'

/* ---------------------------------- helpers ---------------------------------- */

const T0 = 1_700_000_000_000

const financePayload = (key: string): FinanceCreatePayload => ({
  type: 'income',
  amount: 15_000_00,
  date: '2026-10-10',
  accountId: 'acct-1',
  category: 'client_payment',
  note: 'test entry',
  idempotencyKey: key,
})

/** A fresh row exactly as `enqueueCreate` would persist it. */
const entry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  id: crypto.randomUUID(),
  userId: 'user-1',
  operation: 'create_finance',
  payload: financePayload('key-' + crypto.randomUUID().slice(0, 8)),
  idempotencyKey: 'stable-key',
  status: 'pending',
  attempts: 0,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
})

/* -------------------------------- state machine ------------------------------- */

describe('offline queue state machine (§6.2)', () => {
  it('allows only the designed edges', () => {
    expect(canTransition('pending', 'syncing')).toBe(true)
    // Crash mid-send: the row sits in `syncing` and the drain replays it.
    expect(canTransition('syncing', 'synced')).toBe(true)
    expect(canTransition('syncing', 'failed')).toBe(true)
    expect(canTransition('syncing', 'conflict')).toBe(true)
    expect(canTransition('syncing', 'pending')).toBe(true) // 401 session park
    expect(canTransition('failed', 'syncing')).toBe(true) // manual retry / due backoff
    expect(canTransition('failed', 'conflict')).toBe(true)
    expect(canTransition('conflict', 'syncing')).toBe(true)
    expect(canTransition('conflict', 'pending')).toBe(true)
  })

  it('treats `synced` as a dead end — nothing ever leaves it', () => {
    for (const to of ['pending', 'syncing', 'synced', 'failed', 'conflict'] as const) {
      expect(canTransition('synced', to)).toBe(false)
    }
  })

  it('refuses the illegal shortcuts', () => {
    expect(canTransition('pending', 'synced')).toBe(false) // never optimistic (§4)
    expect(canTransition('pending', 'conflict')).toBe(false)
    expect(canTransition('conflict', 'synced')).toBe(false)
    expect(canTransition('failed', 'pending')).toBe(false) // retry goes through entryForManualRetry
  })
})

/* ----------------------------------- backoff ---------------------------------- */

describe('backoff and drain eligibility (§6.3)', () => {
  it('doubles from the base delay and caps', () => {
    expect(backoffDelayMs(1)).toBe(BASE_RETRY_DELAY_MS) // 5s
    expect(backoffDelayMs(2)).toBe(10_000)
    expect(backoffDelayMs(3)).toBe(20_000)
    expect(backoffDelayMs(4)).toBe(40_000)
    expect(backoffDelayMs(5)).toBe(80_000)
    // Attempts beyond the budget are clamped, so the cap can never be passed.
    expect(backoffDelayMs(12)).toBe(backoffDelayMs(MAX_ATTEMPTS))
    expect(backoffDelayMs(12)).toBeLessThanOrEqual(MAX_RETRY_DELAY_MS)
    // Clamped inputs behave like attempt 1, not like a negative delay.
    expect(backoffDelayMs(0)).toBe(BASE_RETRY_DELAY_MS)
  })

  it('drain eligibility per §6.2', () => {
    expect(isDrainable(entry(), T0)).toBe(true) // pending
    expect(isDrainable(entry({ status: 'syncing' }), T0)).toBe(true) // crash replay
    expect(
      isDrainable(
        entry({ status: 'failed', attempts: 2, autoRetry: true, nextRetryAt: T0 - 1 }),
        T0
      )
    ).toBe(true) // due
    expect(
      isDrainable(
        entry({ status: 'failed', attempts: 2, autoRetry: true, nextRetryAt: T0 + 60_000 }),
        T0
      )
    ).toBe(false) // not yet
    expect(
      isDrainable(entry({ status: 'failed', attempts: MAX_ATTEMPTS, autoRetry: false }), T0)
    ).toBe(false) // budget exhausted — waits for the user
    expect(isDrainable(entry({ status: 'failed', attempts: 1, autoRetry: false }), T0)).toBe(false) // validation-style failure
    expect(isDrainable(entry({ status: 'conflict', autoRetry: false }), T0)).toBe(false)
    expect(isDrainable(entry({ status: 'synced', syncedAt: T0 }), T0)).toBe(false)
  })

  it('purges synced rows only after the display grace window (§4)', () => {
    expect(isExpiredSynced(entry({ status: 'synced', syncedAt: T0 }), T0)).toBe(false)
    expect(
      isExpiredSynced(entry({ status: 'synced', syncedAt: T0 }), T0 + SYNCED_RETENTION_MS)
    ).toBe(true)
    // A failed row is NEVER time-purged — only explicit user action removes it.
    expect(isExpiredSynced(entry({ status: 'failed' }), T0 + 10 * SYNCED_RETENTION_MS)).toBe(false)
  })
})

/* ------------------------------- outcome mapping ------------------------------ */

describe('outcome classification and state application (§6.5)', () => {
  it('maps every HTTP answer to its named outcome', () => {
    expect(classifySyncResponse(201, null).kind).toBe('created')
    expect(classifySyncResponse(200, null).kind).toBe('replayed')
    expect(classifySyncResponse(401, null).kind).toBe('session')
    expect(classifySyncResponse(403, { message: 'nope' }).kind).toBe('permission')
    expect(classifySyncResponse(409, { message: 'locked' }).kind).toBe('business-conflict')
    expect(classifySyncResponse(400, { message: 'bad' }).kind).toBe('validation')
    expect(classifySyncResponse(503, null).kind).toBe('transient')
    expect(networkFailureOutcome().kind).toBe('transient')
    expect(networkFailureOutcome().reachedServer).toBe(false)
  })

  it('synced only on a definite created/replayed answer, with a clean row', () => {
    const dirty = entry({
      status: 'syncing',
      attempts: 2,
      errorMessage: 'earlier blip',
      nextRetryAt: T0 + 5000,
      autoRetry: true,
    })
    for (const kind of ['created', 'replayed'] as const) {
      const after = applySyncOutcome(dirty, { kind, reachedServer: true }, T0 + 1)
      expect(after.status).toBe('synced')
      expect(after.syncedAt).toBe(T0 + 1)
      expect(after.errorMessage).toBeUndefined()
      expect(after.nextRetryAt).toBeUndefined()
      expect(after.reachedServer).toBe(true)
    }
  })

  it('a 401 parks the row as pending WITHOUT burning retry budget (§7)', () => {
    const before = entry({ status: 'syncing', attempts: 2, autoRetry: true })
    const after = applySyncOutcome(
      before,
      { kind: 'session', message: 'Session expired', reachedServer: true },
      T0
    )
    expect(after.status).toBe('pending')
    expect(after.attempts).toBe(2) // untouched — logging in must not consume attempts
    expect(after.nextRetryAt).toBeUndefined()
    expect(isDrainable(after, T0)).toBe(true) // drains again right after login
  })

  it('permission/conflict/validation stop auto-retry — they need the user', () => {
    const conflict = applySyncOutcome(
      entry({ status: 'syncing' }),
      { kind: 'permission', message: 'revoked', reachedServer: true },
      T0
    )
    expect(conflict.status).toBe('conflict')
    expect(conflict.autoRetry).toBe(false)
    expect(conflict.errorMessage).toBe('revoked')

    const business = applySyncOutcome(
      entry({ status: 'syncing' }),
      {
        kind: 'business-conflict',
        message: 'lock',
        data: { lockedUntil: 'x' },
        reachedServer: true,
      },
      T0
    )
    expect(business.status).toBe('conflict')
    expect(business.conflictData).toEqual({ lockedUntil: 'x' })

    const invalid = applySyncOutcome(
      entry({ status: 'syncing' }),
      { kind: 'validation', message: 'bad date', reachedServer: true },
      T0
    )
    expect(invalid.status).toBe('failed')
    expect(invalid.autoRetry).toBe(false)
    expect(isDrainable(invalid, T0 + 10 ** 9)).toBe(false)
  })

  it('transient failures back off, and the budget exhaustion flips to permanent', () => {
    let row = entry({ status: 'syncing' })
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const before = row
      row = applySyncOutcome(row, { kind: 'transient', message: 'net', reachedServer: false }, T0)
      expect(row.status).toBe('failed')
      expect(row.attempts).toBe(attempt)
      expect(row.autoRetry).toBe(true)
      expect(row.nextRetryAt).toBe(T0 + backoffDelayMs(attempt))
      expect(shouldReportFailure(before, row)).toBe(false) // not yet exhausted
    }
    // The 5th transient failure: permanent `failed`, exactly-once report armed.
    const before = row
    row = applySyncOutcome(row, networkFailureOutcome(), T0)
    expect(row.attempts).toBe(MAX_ATTEMPTS)
    expect(row.autoRetry).toBe(false)
    expect(row.nextRetryAt).toBeUndefined()
    expect(shouldReportFailure(before, row)).toBe(true)
    // …and never again once the flag is persisted on the row.
    expect(shouldReportFailure({ ...row, failureReported: true }, row)).toBe(false)
  })

  it('reachedServer is sticky once any response came back (§7 audit gate)', () => {
    const touched = applySyncOutcome(entry(), classifySyncResponse(500, null), T0)
    expect(touched.reachedServer).toBe(true)
    const later = applySyncOutcome(touched, networkFailureOutcome(), T0)
    expect(later.reachedServer).toBe(true)
  })

  it('manual retry resets the budget and re-queues the row (§7)', () => {
    const stuck = entry({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      autoRetry: false,
      errorMessage: 'gave up',
      nextRetryAt: T0 - 1,
    })
    const retried = entryForManualRetry(stuck, T0)
    expect(retried.status).toBe('pending')
    expect(retried.attempts).toBe(0)
    expect(retried.autoRetry).toBeUndefined()
    expect(retried.nextRetryAt).toBeUndefined()
    expect(retried.errorMessage).toBeUndefined()
    expect(isDrainable(retried, T0)).toBe(true)
  })
})

/* --------------------------- engine: replay and sequencing --------------------------- */

const scriptedOutcomes = (
  script: Record<string, (body: unknown) => ReturnType<typeof classifySyncResponse>>
) => {
  const seen: Array<{ idempotencyKey: string; id: string }> = []
  const postSync = async (body: { id: string; idempotencyKey: string }) => {
    seen.push({ id: body.id, idempotencyKey: body.idempotencyKey })
    const handler = script[body.idempotencyKey]
    if (!handler) throw new Error(`unscripted key ${body.idempotencyKey}`)
    return handler(body)
  }
  return { postSync, seen }
}

describe('sync engine: crash-safe idempotent replay (§6.5, D3)', () => {
  it('replays a row crashed in `syncing` with the SAME key and the server dedupes', async () => {
    const store = createMemoryStore()
    const crashed = entry({ status: 'syncing', idempotencyKey: 'key-crash' })
    await store.put(crashed)

    const { postSync, seen } = scriptedOutcomes({
      'key-crash': () => classifySyncResponse(200, null), // replayed — server dedupe
    })
    const engine = createSyncEngine({ store, postSync, now: () => T0 })
    const result = await engine.drainOnce('user-1')

    expect(result).toMatchObject({ processed: 1, synced: 1, unresolved: 0 })
    // The key that left the device is the key minted at enqueue — unchanged.
    expect(seen[0].idempotencyKey).toBe('key-crash')
    const row = await store.get(crashed.id)
    expect(row?.status).toBe('synced')
    expect(await store.metaGet(META_LAST_SYNCED_AT)).toBe(T0)
  })

  it('the key is never regenerated across a transient failure and its replay', async () => {
    const store = createMemoryStore()
    const row = entry({ idempotencyKey: 'key-once' })
    await store.put(row)

    const keys: string[] = []
    const engine = createSyncEngine({
      store,
      now: () => T0,
      postSync: async (body) => {
        keys.push(body.idempotencyKey)
        return classifySyncResponse(keys.length === 1 ? 503 : 201, null)
      },
    })
    await engine.drainOnce('user-1') // 503 → failed with backoff
    await engine.drainOnce('user-1') // parked until due — see next assertion
    // The row is NOT due yet (backoff gate), so the second pass must not resend:
    expect(keys.length).toBe(1)
    const stored = await store.get(row.id)
    expect(stored?.status).toBe('failed')
    expect(stored?.attempts).toBe(1)

    // Once due, the manual retry path re-queues with the SAME key.
    await store.put(entryForManualRetry(stored!, T0))
    await engine.drainOnce('user-1')
    expect(keys).toEqual(['key-once', 'key-once'])
    expect((await store.get(row.id))?.status).toBe('synced')
  })

  it('processes rows sequentially in creation order for one user only', async () => {
    const store = createMemoryStore()
    const a = entry({ idempotencyKey: 'k-a', createdAt: T0 })
    const b = entry({ idempotencyKey: 'k-b', createdAt: T0 + 1 })
    const other = entry({ idempotencyKey: 'k-other', userId: 'user-2', createdAt: T0 + 2 })
    await store.put(b)
    await store.put(a)
    await store.put(other)

    const order: string[] = []
    const engine = createSyncEngine({
      store,
      now: () => T0,
      postSync: async (body) => {
        order.push(body.idempotencyKey)
        return classifySyncResponse(201, null)
      },
    })
    const result = await engine.drainOnce('user-1')
    expect(order).toEqual(['k-a', 'k-b']) // oldest first, other user untouched
    expect(result.synced).toBe(2)
    expect((await store.get(other.id))?.status).toBe('pending')
  })

  it('a 401 stops the pass, parks the current row, and leaves the rest untouched', async () => {
    const store = createMemoryStore()
    const first = entry({ idempotencyKey: 'k-1', createdAt: T0 })
    const second = entry({ idempotencyKey: 'k-2', createdAt: T0 + 1, attempts: 0 })
    await store.put(first)
    await store.put(second)

    const events: string[] = []
    const engine = createSyncEngine({
      store,
      now: () => T0,
      postSync: async (body) =>
        body.idempotencyKey === 'k-1'
          ? classifySyncResponse(401, null)
          : classifySyncResponse(201, null),
      emit: (e) => events.push(e.type),
    })

    const result = await engine.drainOnce('user-1')
    expect(result.sessionRequired).toBe(true)
    expect(result.processed).toBe(1)
    expect(events).toContain('session-required')
    expect((await store.get(first.id))?.status).toBe('pending')
    expect((await store.get(first.id))?.attempts).toBe(0)
    expect((await store.get(second.id))?.status).toBe('pending')
    expect((await store.get(second.id))?.lastAttemptAt).toBeUndefined()
    expect(await store.metaGet(META_LAST_SYNCED_AT)).toBeUndefined()
  })

  it('reports the exhausted retry budget exactly once and then stops touching the row', async () => {
    const store = createMemoryStore()
    const doomed = entry({
      idempotencyKey: 'k-doom',
      status: 'syncing',
      attempts: MAX_ATTEMPTS - 1,
      autoRetry: true,
    })
    await store.put(doomed)

    const reports: Array<{ id: string; reason: string }> = []
    const engine = createSyncEngine({
      store,
      now: () => T0,
      postSync: async () => networkFailureOutcome(),
      reportFailure: async (row, reason) => {
        reports.push({ id: row.id, reason })
      },
    })
    const result = await engine.drainOnce('user-1')
    expect(result.unresolved).toBe(1)
    expect(reports).toEqual([{ id: doomed.id, reason: 'Could not reach the server' }])
    const stored = await store.get(doomed.id)
    expect(stored?.failureReported).toBe(true)

    // The permanent-failed row is not drainable: a second pass stays silent.
    const again = await engine.drainOnce('user-1')
    expect(again.processed).toBe(0)
    expect(reports.length).toBe(1)
  })

  it('purges synced rows past the grace window and skips a re-entrant drain', async () => {
    const store = createMemoryStore()
    const oldSynced = entry({ status: 'synced', syncedAt: T0 - SYNCED_RETENTION_MS - 1 })
    await store.put(oldSynced)

    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const engine = createSyncEngine({
      store,
      now: () => T0,
      postSync: async () => {
        await gate
        return classifySyncResponse(201, null)
      },
    })
    const firstPass = engine.drainOnce('user-1')
    const concurrent = await engine.drainOnce('user-1')
    expect(concurrent.skippedReentrant).toBe(true)
    await store.put(entry({ idempotencyKey: 'k-live' }))
    release()
    await firstPass
    expect(await store.get(oldSynced.id)).toBeUndefined() // grace elapsed → purged
  })
})

/* ------------------------------- UI consistency ------------------------------- */

describe('queue summarizer shared by banner/chip/Sync screen (§11)', () => {
  it('counts each state once and needsAction is exactly failed + conflict', () => {
    const now = T0
    const rows = [
      entry({ status: 'pending' }),
      entry({ status: 'syncing' }),
      entry({ status: 'failed' }),
      entry({ status: 'conflict' }),
      entry({ status: 'synced', syncedAt: now - 60_000 }),
      entry({ status: 'synced', syncedAt: now - 25 * 60 * 60 * 1000 }),
    ]
    const stats = summarizeQueue(rows, now)
    expect(stats).toEqual({
      pending: 2, // pending + syncing — the engine will still act on these
      needsAction: 2,
      failed: 1,
      conflict: 1,
      syncedRecently: 1, // only the row inside the 24h display window
      visible: 6,
    })
    expect(stats.needsAction).toBe(stats.failed + stats.conflict)
  })
})
