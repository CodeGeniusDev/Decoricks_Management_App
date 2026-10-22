'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { useRealtimeSync, useConnectionState } from '@/lib/sync/useRealtime'
import type { RealtimeReadTracker } from '@/lib/sync/useRealtime'
import type { DashboardMetrics } from '@/lib/metrics/dashboard-metrics'

/**
 * The central dashboard's data layer (METRICS.md §I).
 *
 * One aggregate read of `/api/dashboard`, which the server authorises per-widget
 * and composes from the existing engines. The whole point of the single endpoint
 * is that every widget's numbers come from ONE reconciled snapshot, so there are
 * no double-fetches and no inter-widget races.
 *
 * Refresh model:
 *   - first load          → skeleton (`loading` true only until the first payload)
 *   - Phase 7 event       → silent background refetch; old numbers stay painted and
 *                           are swapped in place, so scroll position and any open
 *                           "Show calculation" panel are preserved — no flicker.
 *   - polling fallback    → when the realtime transport is not live (or on a
 *                           slower `polling` mode) we re-check on an interval so
 *                           the dashboard still converges without a socket.
 *
 * A background refresh that fails does NOT blank the screen: it keeps the last
 * good snapshot and only surfaces the error on the initial load, matching the
 * "one failing widget never breaks the page" rule (the page-level error is
 * rendered by each widget from this shared state).
 */

export type DashboardPeriod = 'day' | 'week' | 'month' | 'custom'

const POLL_MS = 60_000
const POLL_MS_FALLBACK = 90_000

export interface DashboardState {
  data: DashboardMetrics | null
  loading: boolean
  error: string | null
  period: DashboardPeriod
  customFrom: string
  customTo: string
  setPeriod: (p: DashboardPeriod) => void
  setCustomRange: (from: string, to: string) => void
  refresh: () => void
  /** The applied query string, for deep-linking click-through ranges. */
  rangeQuery: string
}

export function useDashboard(): DashboardState {
  const [data, setData] = useState<DashboardMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<DashboardPeriod>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  // Guards against an in-flight background refresh resolving after a newer one,
  // which would paint a stale snapshot on top of a fresh one.
  const requestSeq = useRef(0)
  // Phase 4 §9: one background refresh at a time, plus the time the last payload
  // landed. Together they make the polling fallback both quiet and self-healing.
  const bgInFlight = useRef(false)
  const lastFetchedAt = useRef(0)

  /*
   * The four subscriptions and the read they govern are wired as *one* pipeline:
   * a signal only bumps `syncTick`, and the effect below turns the tick into a
   * background re-read. That shape is what lets `load` announce its read to the
   * coordinator (`begin`) before the request goes out — the earlier version kept
   * the trackers in a ref filled by an effect, so the mount read was never
   * announced, and the baseline that follows it was indistinguishable from a
   * change: a second, identical `/api/dashboard` on every dashboard load.
   */
  const [syncTick, setSyncTick] = useState(0)
  const onSyncSignal = useCallback(() => setSyncTick((t) => t + 1), [])
  const markFinance = useRealtimeSync('finance', onSyncSignal)
  const markSales = useRealtimeSync('sales', onSyncSignal)
  const markInventory = useRealtimeSync('inventory', onSyncSignal)
  const markTasks = useRealtimeSync('tasks', onSyncSignal)

  /*
   * One dashboard response is simultaneously a read of all four modules — it is
   * the only thing any of these subscriptions re-fetches — so one proof is
   * recorded against each. Stable identities, safe to list in `load`'s deps.
   */
  const trackers = useMemo<RealtimeReadTracker[]>(
    () => [markFinance, markSales, markInventory, markTasks],
    [markFinance, markSales, markInventory, markTasks]
  )

  const rangeQuery = useMemo(() => {
    const params = new URLSearchParams()
    if (period === 'custom') {
      if (customFrom) params.set('from', customFrom)
      if (customTo) params.set('to', customTo)
      params.set('period', 'custom')
    } else {
      params.set('period', period)
    }
    return params.toString()
  }, [period, customFrom, customTo])

  const load = useCallback(
    async (background: boolean) => {
      // A slow dashboard call must not be piled on top of itself: while a
      // background refresh is in flight, further background triggers are dropped.
      // Foreground loads (first paint, period switch, manual refresh) are never
      // dropped — they invalidate the pending background one via `requestSeq`.
      if (background && bgInFlight.current) return
      const seq = ++requestSeq.current
      if (background) bgInFlight.current = true
      if (!background) setLoading(true)
      const startedAt = Date.now()
      // Announced before it goes out, so a signal arriving during the round trip
      // is held for this read to answer instead of starting a second identical
      // snapshot beside it.
      for (const tracker of trackers) tracker.begin()
      try {
        const res = await apiFetch(
          `/api/dashboard?${rangeQuery}`,
          background ? { headers: { 'x-session-background': '1' } } : {}
        )
        const body = (await res.json()) as {
          success: boolean
          data?: DashboardMetrics
          timestamp?: string
          error?: { message?: string }
        }
        if (seq !== requestSeq.current) {
          // Superseded before it landed: these numbers are discarded, so they
          // prove nothing about what is on screen and must not be recorded as
          // freshness. The read was announced, though, and an announcement that
          // is never released would hold every later signal for this tab.
          for (const tracker of trackers) tracker.abandon()
          return
        }
        const serverTime = body.timestamp ? Date.parse(body.timestamp) : null
        const durationMs = Date.now() - startedAt
        if (!res.ok || !body.success) {
          throw new Error(body.error?.message ?? `Request failed (${res.status})`)
        }
        setData(body.data ?? null)
        setError(null)
        lastFetchedAt.current = Date.now()
        // The server's own instant for the snapshot now on screen, plus how long
        // the client waited for it: together they say where this read must have
        // begun, which is what lets each of the four subscriptions decide that a
        // baseline is describing rows it already holds. An unparseable stamp
        // becomes `null`, which `settleRead` refuses to record as proof.
        for (const tracker of trackers) tracker.settle(serverTime, durationMs)
      } catch (err) {
        for (const tracker of trackers) tracker.abandon()
        if (seq !== requestSeq.current) return
        // A background failure keeps the last good numbers; only the first paint
        // is allowed to flip the whole board into an error state.
        if (!background) {
          setError(err instanceof Error ? err.message : 'Failed to load the dashboard')
        }
      } finally {
        // Cleared unconditionally for background calls: a foreground load that
        // superseded this one (and therefore wins `requestSeq`) must still release
        // the flag, or the polling fallback would stay disabled for the rest of
        // the session. Only one background call can be in flight at a time, so it
        // is safe for the single in-flight call to clear it.
        if (background) bgInFlight.current = false
        if (seq === requestSeq.current && !background) setLoading(false)
      }
    },
    [rangeQuery, trackers]
  )

  // (Re)load whenever the applied range changes. A period switch is a user action
  // (foreground, shows skeleton); this effect itself is the single trigger, so no
  // widget fires its own fetch.
  useEffect(() => {
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeQuery])

  /*
   * A remote change re-reads the snapshot in place (`background`), keeping the
   * numbers on screen painted rather than blanking them (Phase 6 §3.1, §5.2).
   * Kept out of the effect above on purpose.
   */
  useEffect(() => {
    if (syncTick === 0) return
    void load(true)
  }, [syncTick, load])

  // Polling fallback: keep converging when the socket isn't live. The interval
  // tightens while connected-but-polling and relaxes when fully offline, so we
  // never hammer the server through an outage.
  //
  // `document.hidden` is checked *at the tick*, not by tearing the interval down
  // on visibilitychange: a hidden tab produces no visible staleness, so the cheapest
  // correct behaviour is to skip those ticks and let the reconcile effect below fetch
  // once the user is back. Before this guard the dashboard kept issuing a snapshot
  // request every 60-90s in a background tab — the one module in the app whose
  // fallback polling ignored visibility (the sync transport and `usePolling` both
  // respect it).
  const { state: connection } = useConnectionState()
  useEffect(() => {
    if (connection === 'live') return
    const ms = connection === 'reconnecting' ? POLL_MS : POLL_MS_FALLBACK
    const id = setInterval(() => {
      if (document.hidden) return
      void load(true)
    }, ms)
    return () => clearInterval(id)
  }, [connection, load])

  // Reconcile when the tab is shown again or the network comes back, instead of
  // waiting for the next tick of a timer that was paused meanwhile. Throttled by
  // the same interval so a wake-from-sleep burst (visibility + focus + online)
  // costs one request.
  useEffect(() => {
    const maybeCatchUp = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastFetchedAt.current < POLL_MS) return
      void load(true)
    }
    document.addEventListener('visibilitychange', maybeCatchUp)
    window.addEventListener('online', maybeCatchUp)
    return () => {
      document.removeEventListener('visibilitychange', maybeCatchUp)
      window.removeEventListener('online', maybeCatchUp)
    }
  }, [load])

  const setCustomRange = useCallback((from: string, to: string) => {
    setCustomFrom(from)
    setCustomTo(to)
  }, [])

  const manualRefresh = useCallback(() => void load(false), [load])

  return {
    data,
    loading,
    error,
    period,
    customFrom,
    customTo,
    setPeriod,
    setCustomRange,
    refresh: manualRefresh,
    rangeQuery,
  }
}
