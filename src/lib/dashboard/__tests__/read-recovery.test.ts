/**
 * The recovery schedule the live-connection report was about (brief item 1c).
 *
 * Two properties are pinned, because they are the two ways a retry schedule can
 * be wrong in opposite directions: a ladder that keeps shortening turns into a
 * request storm against a server that is already down, and a ladder that
 * terminates is a page that stops recovering — which is exactly what left the
 * dashboard reading "updated 12:39 am" hours later.
 */
import { describe, it, expect } from 'vitest'
import {
  isStale,
  MAX_RECOVERY_DELAY_MS,
  MIN_RECOVERY_DELAY_MS,
  recoveryDelayMs,
  STALE_AFTER_MS,
} from '@/lib/dashboard/read-recovery'

describe('recoveryDelayMs', () => {
  it('ramps from a short first retry', () => {
    expect(recoveryDelayMs(1)).toBe(2_000)
    expect(recoveryDelayMs(2)).toBe(4_000)
    expect(recoveryDelayMs(3)).toBe(8_000)
  })

  it('never exceeds the brief’s ~30 second cap, however long the outage lasts', () => {
    for (let attempt = 1; attempt <= 200; attempt++) {
      expect(recoveryDelayMs(attempt), `attempt ${attempt}`).toBeLessThanOrEqual(
        MAX_RECOVERY_DELAY_MS
      )
    }
    expect(MAX_RECOVERY_DELAY_MS).toBe(30_000)
  })

  it('is monotonic: a longer streak never waits less than a shorter one', () => {
    for (let attempt = 1; attempt < 60; attempt++) {
      expect(recoveryDelayMs(attempt + 1)).toBeGreaterThanOrEqual(recoveryDelayMs(attempt))
    }
  })

  it('saturates instead of terminating — there is no attempt count that stops trying', () => {
    // The distinction the whole fix turns on. A schedule with a last attempt is a
    // give-up condition wearing a backoff as a disguise.
    expect(recoveryDelayMs(6)).toBe(MAX_RECOVERY_DELAY_MS)
    expect(recoveryDelayMs(7)).toBe(MAX_RECOVERY_DELAY_MS)
    expect(recoveryDelayMs(50)).toBe(MAX_RECOVERY_DELAY_MS)
    expect(recoveryDelayMs(5_000)).toBe(MAX_RECOVERY_DELAY_MS)
  })

  it('reads nonsense input the way a caller means it instead of throwing', () => {
    // Callers are React effects computing a timer delay; a schedule that refuses
    // to compute is a page that stops recovering.
    expect(recoveryDelayMs(0)).toBe(MIN_RECOVERY_DELAY_MS)
    expect(recoveryDelayMs(-3)).toBe(MIN_RECOVERY_DELAY_MS)
    expect(recoveryDelayMs(NaN)).toBe(MIN_RECOVERY_DELAY_MS)
    // A streak that overflowed is the OPPOSITE of "no failures yet": it must not
    // land on the short rung, which is the request storm this cap exists to stop.
    expect(recoveryDelayMs(Infinity)).toBe(MAX_RECOVERY_DELAY_MS)
    expect(recoveryDelayMs(-Infinity)).toBe(MIN_RECOVERY_DELAY_MS)
  })
})

describe('isStale', () => {
  it('calls a payload older than the bound stale, and a fresh one current', () => {
    const now = 1_000_000
    expect(isStale(now, now - STALE_AFTER_MS)).toBe(true)
    expect(isStale(now, now - STALE_AFTER_MS + 1)).toBe(false)
    expect(isStale(now, now)).toBe(false)
  })

  it('treats "never read" as stale', () => {
    expect(isStale(1_000_000, 0)).toBe(true)
  })

  it('the bound is the few minutes the brief asks for, not hours', () => {
    // The reported state was a page whose own author could not tell it was stale,
    // so the threshold has to be short enough to be worth calling a floor.
    expect(STALE_AFTER_MS).toBeLessThanOrEqual(5 * 60_000)
  })
})
