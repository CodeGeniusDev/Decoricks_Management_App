'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { useRealtimeSync, useConnectionState } from '@/lib/sync/useRealtime'
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
      const seq = ++requestSeq.current
      if (!background) setLoading(true)
      try {
        const res = await apiFetch(
          `/api/dashboard?${rangeQuery}`,
          background ? { headers: { 'x-session-background': '1' } } : {}
        )
        const body = (await res.json()) as {
          success: boolean
          data?: DashboardMetrics
          error?: { message?: string }
        }
        if (seq !== requestSeq.current) return // a newer request won
        if (!res.ok || !body.success) {
          throw new Error(body.error?.message ?? `Request failed (${res.status})`)
        }
        setData(body.data ?? null)
        setError(null)
      } catch (err) {
        if (seq !== requestSeq.current) return
        // A background failure keeps the last good numbers; only the first paint
        // is allowed to flip the whole board into an error state.
        if (!background) {
          setError(err instanceof Error ? err.message : 'Failed to load the dashboard')
        }
      } finally {
        if (seq === requestSeq.current && !background) setLoading(false)
      }
    },
    [rangeQuery]
  )

  // (Re)load whenever the applied range changes. A period switch is a user action
  // (foreground, shows skeleton); this effect itself is the single trigger, so no
  // widget fires its own fetch.
  useEffect(() => {
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeQuery])

  const refreshBackground = useCallback(() => load(true), [load])

  // Phase 7 cross-device events — refresh quietly only when a real module changed.
  useRealtimeSync('finance', refreshBackground)
  useRealtimeSync('sales', refreshBackground)
  useRealtimeSync('inventory', refreshBackground)
  useRealtimeSync('tasks', refreshBackground)

  // Polling fallback: keep converging when the socket isn't live. The interval
  // tightens while connected-but-polling and relaxes when fully offline, so we
  // never hammer the server through an outage.
  const { state: connection } = useConnectionState()
  useEffect(() => {
    if (connection === 'live') return
    const ms = connection === 'reconnecting' ? POLL_MS : POLL_MS_FALLBACK
    const id = setInterval(() => void load(true), ms)
    return () => clearInterval(id)
  }, [connection, load])

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
