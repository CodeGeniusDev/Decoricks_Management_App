import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeStreamDocument } from 'mongodb'
import { realtimeBus } from '@/lib/realtime/bus'
import type { RealtimeSignal } from '@/lib/realtime/types'

/*
 * Watching `@/lib/mongodb` keeps the driver out of this suite entirely: the
 * watcher only reaches for it inside `runLoop`, which `ensureChangeStreamWatcher`
 * starts and this file never calls. Mocking it makes that intent explicit and
 * guards against a future edit that touches the connection at import time.
 */
vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => {
    throw new Error('a unit test must not open a database connection')
  }),
}))

const { handleChange } = await import('@/lib/realtime/watcher')

/** Shape a collection-scoped change document down to what `handleChange` reads. */
const change = (coll: string, clusterTime: { t: number; i?: number }): ChangeStreamDocument =>
  ({ ns: { db: 'decoricks_test', coll }, clusterTime }) as unknown as ChangeStreamDocument

/**
 * A cluster second twelve hours ahead of the process clock. `clusterTime` is the
 * dominant term then, so the published values are exact and the assertions do
 * not depend on where the host's clock or timezone happens to sit — the
 * `appClockMs()` floor only takes over when the cluster clock is behind.
 *
 * Twelve hours, not one: `appClockMs()` deliberately reports the pinned
 * Asia/Karachi domain, which sits +5h in front of the true instant on a UTC host
 * (`TZ=UTC`, which is what the Playwright gate and any serverless platform run
 * under). A margin smaller than that offset would be overtaken by the floor and
 * the exact-value assertion below would start depending on the machine running
 * the suite.
 */
const SECOND = Math.floor(Date.now() / 1000) + 12 * 3600

describe('change-stream signal timestamps', () => {
  let seen: RealtimeSignal[] = []
  let unsubscribe: (() => void) | undefined

  beforeEach(() => {
    // The monotonicity floor lives on `globalThis` because the bus it feeds is a
    // process singleton. Reset it so each case starts from "nothing published yet".
    global._decoricksLastSignalTs = undefined
    seen = []
    unsubscribe?.()
    unsubscribe = realtimeBus.subscribe((signal) => seen.push(signal))
  })

  it('advances for every write, even several inside the same cluster second', () => {
    // `clusterTime` has ONE-SECOND resolution, so this is exactly what three
    // writes in as many milliseconds look like to the watcher. The coordinator
    // fires listeners only on a strict `ts > prev`, so three identical values
    // mean one refresh and two silently discarded changes — the bug that made
    // the Phase 11 archive step fail: the archived product stayed on the other
    // device's list until a reload.
    handleChange(change('stock', { t: SECOND }))
    handleChange(change('stockMovements', { t: SECOND }))
    handleChange(change('products', { t: SECOND }))

    expect(seen.map((s) => s.module)).toEqual(['inventory', 'inventory', 'inventory'])
    const timestamps = seen.map((s) => s.ts)
    // Relational on purpose: the bus coalesces a same-module tail by bumping it
    // in place, so what the watcher guarantees is that each write moves the
    // mark, not that it starts at a particular millisecond.
    expect(timestamps[1], 'same-second writes produced a duplicate ts').toBeGreaterThan(
      timestamps[0]
    )
    expect(timestamps[2], 'same-second writes produced a duplicate ts').toBeGreaterThan(
      timestamps[1]
    )
    expect(
      timestamps[2] - timestamps[0],
      'the monotonicity drifted more than one ms per write'
    ).toBe(2)
  })

  it('keeps the monotonicity floor per module, not global', () => {
    handleChange(change('products', { t: SECOND }))
    handleChange(change('products', { t: SECOND }))
    handleChange(change('messages', { t: SECOND }))

    // Two modules' cursors are independent high-water marks, so an inventory
    // burst must not push the chat signal forward into milliseconds the chat
    // module never occupied — the polling cursor computes chat from real
    // `updatedAt` values and the two carriers have to stay comparable.
    expect(seen.map((s) => s.module)).toEqual(['inventory', 'inventory', 'chat'])
    expect(seen[2].ts).toBe(SECOND * 1000)
  })

  it('publishes nothing for a collection no module subscribes to', () => {
    handleChange(change('auditLog', { t: SECOND }))
    handleChange(change('users', { t: SECOND }))
    expect(seen).toHaveLength(0)
  })

  it('stays above the timestamp domain the polling cursor is built from', async () => {
    // The client's high-water mark comes from `updatedAt`, stamped by
    // `getKarachiDate()`. A signal below it can never fire, so a change stream
    // that reports a stale or foreign clock must not drag the signal down with
    // it — this is the case a 1970s cluster token stands in for.
    const { getKarachiDate } = await import('@/lib/date')
    const stampTakenEarlier = getKarachiDate().getTime()
    handleChange(change('products', { t: 1_000 }))
    expect(seen[0].ts).toBeGreaterThanOrEqual(stampTakenEarlier)
  })

  it('still fires on a host whose clock is not Asia/Karachi', async () => {
    /*
     * The Phase 5 §3 production failure, held as a contract. Netlify and every
     * other serverless platform run processes in UTC, where `getKarachiDate()`
     * returns a true instant shifted +5h — so the records' own `updatedAt`
     * (and therefore the cursor baseline every tab adopts) sits five hours in
     * front of the database's cluster time. Deriving the signal from
     * `clusterTime` alone put every live frame below that baseline; the shipped
     * bundle suppressed all four inventory changes and the page only converged
     * on reload. Restoring `appClockMs()` to the pre-fix expression fails here.
     */
    const previousTZ = process.env.TZ
    process.env.TZ = 'UTC'
    try {
      const { getKarachiDate } = await import('@/lib/date')
      const baseline = getKarachiDate().getTime()
      handleChange(change('products', { t: Math.floor(Date.now() / 1000) }))
      expect(seen[0].ts, 'live signal sat below the baseline a UTC host produces').toBeGreaterThan(
        baseline - 1
      )
    } finally {
      // Node re-reads `process.env.TZ` on every date operation, so leaving it
      // mutated would shift the clock for the rest of this worker's suite.
      if (previousTZ === undefined) delete process.env.TZ
      else process.env.TZ = previousTZ
      global._decoricksLastSignalTs = undefined
    }
  })

  it('ignores events without a namespace instead of throwing', () => {
    // DDL events (dropDatabase, invalidate) have no `ns.coll`. A throw here
    // would kill the `for await` loop and take the stream down with it.
    expect(() =>
      handleChange({ operationType: 'dropDatabase' } as unknown as ChangeStreamDocument)
    ).not.toThrow()
    expect(seen).toHaveLength(0)
  })
})
