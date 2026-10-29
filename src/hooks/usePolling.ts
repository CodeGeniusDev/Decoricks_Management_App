'use client'

import { useCallback, useEffect, useRef } from 'react'
import { recoveryDelayMs, STALE_AFTER_MS, STALE_CHECK_MS } from '@/lib/dashboard/read-recovery'

/**
 * Keeps a page's data self-healing, without a data library.
 *
 * Small manual-refresh helper matching the codebase's fetch-not-cache style
 * (see `useFinanceData`). No new dependency, no SWR/React-Query.
 *
 * Fires the refresh callback when:
 *   - the tab becomes visible again (document.visibilitychange),
 *   - the browser window regains focus (`focus`),
 *   - the network comes back online (`online`),
 *   - on a fixed polling interval, when one is configured (off by default),
 *   - when the last attempt is older than `staleMs` (default 3 min) and the tab
 *     is visible — the freshness floor, explained below,
 *   - and, while `error` is set, on the recovery ladder in `read-recovery.ts`:
 *     2s, 4s, 8s, 16s, then every 30s for as long as the page is broken.
 *
 * Refetches are throttled — a burst of focus + visibility + online events at
 * wake-from-sleep results in one call, not three.
 *
 * THE TWO CLAUSES THAT WERE ADDED, AND WHY. The live-connection report was a
 * dashboard stuck on "updated 12:39 am" hours later, and the same shape exists
 * on every page that refreshes only when the realtime layer tells it to: a
 * stream that stays *open* while delivering nothing leaves a page looking
 * healthy and being stale, and a page whose fetch failed shows an error screen
 * forever because nothing schedules another attempt. So:
 *
 *   - **The interval is not the floor.** `staleMs` is checked on its own timer,
 *     so "no signal has arrived" can never mean "no read will happen".
 *   - **Recovery never terminates.** The ladder saturates at
 *     `MAX_RECOVERY_DELAY_MS`; it does not stop. Passing the page's own `error`
 *     state is what makes it failure-aware without the fetcher having to report
 *     anything, which is why no page had to be rewritten to use it.
 *
 * `paused` is checked at every tick, including inside the recovery loop. Pass it
 * while a drag is in flight or a drawer is open and needs stable data; the effect
 * re-arms automatically when the flag flips back to false.
 */
export interface UsePollingOptions {
  /** Milliseconds between polls. Zero (default) disables interval polling. */
  intervalMs?: number
  /** Minimum milliseconds between any two refreshes. Defaults to 1500. */
  throttleMs?: number
  /** When true, nothing fires. Perfect for a modal, drawer or active drag. */
  paused?: boolean
  /**
   * The page's current error message, if any. While it is set the recovery
   * ladder takes over; clearing it is what resets the ladder.
   */
  error?: string | null
  /**
   * Freshness floor. A read is forced once this much time has passed since the
   * last attempt, whatever the health flags say. Defaults to `STALE_AFTER_MS`.
   */
  staleMs?: number
}

export function usePolling(
  refresh: () => void | Promise<unknown>,
  options: UsePollingOptions = {}
): void {
  const {
    intervalMs = 0,
    throttleMs = 1500,
    paused = false,
    error = null,
    staleMs = STALE_AFTER_MS,
  } = options

  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  const lastFired = useRef(Date.now())
  const pausedRef = useRef(paused)
  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  /*
   * Declared before the recovery effect on purpose: effects run in declaration
   * order within a commit, so the loop reads the outcome of the previous attempt
   * rather than the `null` a fetcher sets on itself the instant it starts.
   */
  const errorRef = useRef(error)
  useEffect(() => {
    errorRef.current = error
  }, [error])

  /** Which rung of the recovery ladder the current error episode has reached. */
  const errorStreak = useRef(0)

  const fire = useCallback(() => {
    if (pausedRef.current) return
    // A hidden tab produces no visible staleness, so the cheapest correct
    // behaviour is to skip the tick and let the visibilitychange handler below
    // fetch the moment the user is back. Without this guard a background tab
    // polls forever for an audience of none (browsers throttle it, but they do
    // not stop it).
    if (typeof document !== 'undefined' && document.hidden) return
    const now = Date.now()
    if (now - lastFired.current < throttleMs) return
    lastFired.current = now
    void refreshRef.current()
  }, [throttleMs])

  // Interval (opt-in).
  useEffect(() => {
    if (intervalMs <= 0) return
    const id = window.setInterval(fire, intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, fire])

  /*
   * The freshness floor. Independent of `intervalMs`, because the whole point is
   * that a page which has decided it does not need polling — realtime is
   * "live", nothing has changed, no signal has arrived — still cannot go quiet
   * for hours. Checked on a short timer so the floor is accurate to well under a
   * minute without turning into a poll of its own.
   */
  useEffect(() => {
    if (staleMs <= 0) return
    const id = window.setInterval(() => {
      if (Date.now() - lastFired.current < staleMs) return
      fire()
    }, STALE_CHECK_MS)
    return () => window.clearInterval(id)
  }, [staleMs, fire])

  /*
   * Recovery while the page is showing an error. Every fetcher on these pages
   * swallows its own failure into `setError`, so before this the error screen
   * was terminal: nothing else would ever try again unless a realtime signal, a
   * focus or a browser `online` event happened to arrive. The brief's rule is
   * that a page must recover on its own, so while an error is on screen attempts
   * continue on the ladder in `read-recovery.ts` — 2s, 4s, 8s, 16s, then every
   * 30s — and, deliberately, with no end.
   *
   * The rung lives in `errorStreak`, a ref that the effect's cleanup deliberately
   * does not reset, and that is what keeps this from becoming a hammer. These
   * fetchers clear their own error message the instant an attempt starts, so
   * `error` flickers to null for the duration of every request: an effect keyed
   * on that value is torn down and rebuilt once per attempt, and a ladder that
   * restarted with it would sit at rung 1 — two seconds — forever, firing at a
   * server that is already down. Carrying the rung across the rebuild makes the
   * ramp real: each attempt advances it, so the pace falls to the 30s ceiling and
   * stays there while the failure persists.
   *
   * When the rebuild does not happen — a loader that leaves its message on screen
   * while retrying — the awaited branch below is the one that runs, reading
   * `errorRef` after the attempt has settled so a genuine success stops the loop
   * and resets the ladder instead of waiting for the effect to notice.
   */
  useEffect(() => {
    if (!error) return
    let cancelled = false
    let id = 0

    const attempt = async () => {
      // Paused or hidden: re-arm at the same rung rather than spending a request
      // nobody can see. This is the clause that keeps "never give up" from
      // becoming "never stop hammering".
      if (pausedRef.current || (typeof document !== 'undefined' && document.hidden)) {
        arm(recoveryDelayMs(errorStreak.current))
        return
      }
      errorStreak.current += 1
      lastFired.current = Date.now()
      try {
        await refreshRef.current()
      } catch {
        // The page owns its error state; a rejection here only means the attempt
        // did not clear it, which the next line reads correctly.
      }
      if (cancelled) return
      if (!errorRef.current) {
        errorStreak.current = 0
        return
      }
      arm(recoveryDelayMs(errorStreak.current))
    }

    const arm = (delay: number) => {
      id = window.setTimeout(() => void attempt(), delay)
    }

    arm(recoveryDelayMs(errorStreak.current))
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
    // `error` only. A chained loop must not be rebuilt on every re-render, or
    // the pending timeout would be cancelled and re-armed at the same rung
    // however many times the page happens to paint.
  }, [error])

  // Event-driven refreshes: focus, tab-visible, network-back-online.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fire()
    }
    const onFocus = () => fire()
    const onOnline = () => fire()

    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [fire])
}
