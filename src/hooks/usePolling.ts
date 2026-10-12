'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * Small manual-refresh helper matching the codebase's fetch-not-cache style
 * (see `useFinanceData`). No new dependency, no SWR/React-Query.
 *
 * Fires the refresh callback when:
 *   - the tab becomes visible again (document.visibilitychange),
 *   - the browser window regains focus (`focus`),
 *   - the network comes back online (`online`),
 *   - and optionally on a fixed polling interval (off by default).
 *
 * Refetches are throttled — a burst of focus + visibility + online events at
 * wake-from-sleep results in one call, not three.
 *
 * `paused` is checked at every tick. Pass it while a drag is in flight or a
 * drawer is open and needs stable data; the effect re-arms automatically when
 * the flag flips back to false.
 */
export interface UsePollingOptions {
  /** Milliseconds between polls. Zero (default) disables interval polling. */
  intervalMs?: number
  /** Minimum milliseconds between any two refreshes. Defaults to 1500. */
  throttleMs?: number
  /** When true, nothing fires. Perfect for a modal, drawer or active drag. */
  paused?: boolean
}

export function usePolling(
  refresh: () => void | Promise<unknown>,
  options: UsePollingOptions = {}
): void {
  const { intervalMs = 0, throttleMs = 1500, paused = false } = options

  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  const lastFired = useRef(0)
  const pausedRef = useRef(paused)
  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  const fire = useCallback(() => {
    if (pausedRef.current) return
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
