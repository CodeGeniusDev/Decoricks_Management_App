'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { fetchDashboardSnapshot } from '@/lib/dashboard/snapshot-fetch'
import { runWakeRetry, type WakePhase } from '@/lib/dashboard/wake-retry'
import {
  isStale,
  recoveryDelayMs,
  STALE_AFTER_MS,
  STALE_CHECK_MS,
} from '@/lib/dashboard/read-recovery'
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
 *   - while the store says `live` → a staleness watchdog, NOT silence. A stream
 *                           can stay open while delivering nothing, and a timer
 *                           switched off by a health flag is how this board ended
 *                           up displaying "updated 12:39 am" hours later.
 *   - after a failure     → the backoff ladder in `read-recovery.ts`: 2s, 4s, 8s,
 *                           16s, then every 30s, with no attempt limit. `focus`,
 *                           `visibilitychange` and `online` also reconcile.
 *
 * The last two lines are the whole point of `lastUpdated` and `stale` being part
 * of this hook's contract: a page that keeps trying must also be able to say,
 * truthfully, how old what it is showing actually is.
 *
 * A background refresh that fails does NOT blank the screen: it keeps the last
 * good snapshot and only surfaces the error on the initial load, matching the
 * "one failing widget never breaks the page" rule (the page-level error is
 * rendered by each widget from this shared state).
 *
 * The read itself is delegated to `snapshot-fetch`, which owns the timeout, the
 * single retry, the failure classification and the safe message. This hook keeps
 * the *policy* — when to read, what supersedes what, which refresh is silent —
 * and no longer touches `Response` or `err.message` at all. That split exists
 * because a transient network failure used to reach the screen verbatim: see
 * `src/lib/dashboard/snapshot-fetch.ts`.
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
  /**
   * Non-null while a user-initiated read is being retried against a server that
   * has not answered — a sleeping Render instance. `error` stays null for the
   * whole of this, which is the point: nothing has gone wrong yet, the machine is
   * still booting, and "Couldn't load the dashboard" was a lie about a transient
   * wait. The retry schedule and its 90-second budget live in
   * `wake-retry.ts`.
   */
  waking: { attempt: number; retryInMs: number; elapsedMs: number } | null
  /**
   * When the numbers currently on screen last landed, as a client timestamp.
   * Advanced ONLY by a successful read, which is what makes the "updated …" line
   * on the page honest: it can never claim a fresher instant than the payload it
   * is describing, so a failed refresh leaves it showing the age of the stale
   * snapshot rather than the time of the attempt that failed.
   */
  lastUpdated: number | null
  /**
   * `lastUpdated` is older than `STALE_AFTER_MS` while this tab has been visible,
   * i.e. the board on screen is behind the server and cannot be trusted to be
   * current. The page pairs it with the retry schedule so "updated 12:39 am" is
   * never shown as if it were fresh.
   */
  stale: boolean
}

export function useDashboard(): DashboardState {
  const [data, setData] = useState<DashboardMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<DashboardPeriod>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [waking, setWaking] = useState<DashboardState['waking']>(null)

  // Guards against an in-flight background refresh resolving after a newer one,
  // which would paint a stale snapshot on top of a fresh one.
  const requestSeq = useRef(0)
  // Phase 4 §9: one background refresh at a time, plus the time the last payload
  // landed. Together they make the polling fallback both quiet and self-healing.
  const bgInFlight = useRef(false)
  const lastFetchedAt = useRef(0)
  /*
   * The last time a read was ATTEMPTED, successful or not, and the clock the
   * freshness watchdog measures against. Deliberately not `lastFetchedAt`: a
   * failing board must not be re-read every 15 seconds by a watchdog that
   * believes it has never tried, and the recovery ladder below already owns the
   * pace of retries against a server that is refusing requests.
   */
  const lastAttemptAt = useRef(0)
  /*
   * Recovery bookkeeping. `failures` is how many attempts have failed in a row
   * and selects the rung of the backoff ladder; `recoverId` is the single pending
   * retry, so no combination of timers, signals and events can stack retries.
   * Both exist because the reported bug was a dashboard that stopped trying: the
   * cold-start window closed after 90 seconds, the polling timer was switched off
   * by the `live` claim, and "updated 12:39 am" sat there for hours.
   */
  const failures = useRef(0)
  const recoverId = useRef<number | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [stale, setStale] = useState(false)
  /*
   * Set for the whole life of a user-initiated read, which since the cold-start
   * fix can be up to 90 seconds while it waits for a sleeping instance. Separate
   * from `bgInFlight` because it guards a different race: without it, the 60s
   * polling timer (or a realtime signal) fires `load(true)` on top of a retry
   * loop that still has most of its window left, that call bumps `requestSeq`,
   * and the loop's `superseded` check stops the very recovery it was started for.
   * The user would watch the board restart from zero once a minute.
   */
  const wakeInFlight = useRef(false)

  /*
   * Whether this component instance is still on screen. A 90-second retry loop
   * makes unmounting mid-read an ordinary event rather than a teardown edge case,
   * and an ordinary `requestSeq` check cannot see it: the counter lives in a ref
   * that nothing bumps when the router moves away, so the loop would keep dialing
   * `/api/dashboard` for a minute and a half after the dashboard was gone. It is
   * folded into the same ticket `isCurrent` returns, so every layer that already
   * respects supersession respects this too without learning about it.
   */
  const mounted = useRef(true)
  useEffect(() => {
    // Re-armed on setup, not just cleared on cleanup. Under StrictMode's
    // double-invoke the cleanup runs while the component stays mounted, and a
    // one-way flag would then be permanently false — silently disabling every
    // read for the rest of the session in development, which is precisely the
    // environment where that would be noticed as "the dashboard never loads".
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

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

  /*
   * The retry ladder, kept in a ref-backed callback so it can call the CURRENT
   * `load` (and therefore the current `rangeQuery`) without being rebuilt every
   * time the range changes — a rebuild would cancel the pending rung and restart
   * the ladder at two seconds on every period switch.
   */
  const loadRef = useRef<(background: boolean) => Promise<void>>(async () => {})
  const armRecovery = useCallback(() => {
    if (recoverId.current !== null) return
    failures.current += 1
    const delay = recoveryDelayMs(failures.current)
    recoverId.current = window.setTimeout(() => {
      recoverId.current = null
      if (!mounted.current) return
      /*
       * Nothing visible is stale, and the browser says there is no network to try.
       * Re-arm at the same rung instead of spending a request: "never give up"
       * must not become "never stop hammering". The `online` listener in the
       * reconcile effect below is what actually fires the moment a connection
       * returns, and the polling timer keeps trying while a tab is visible.
       */
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        armRecovery()
        return
      }
      if (typeof document !== 'undefined' && document.hidden) {
        armRecovery()
        return
      }
      void loadRef.current(true)
    }, delay)
  }, [])

  useEffect(() => {
    return () => {
      if (recoverId.current !== null) window.clearTimeout(recoverId.current)
    }
  }, [])

  const load = useCallback(
    async (background: boolean) => {
      // A slow dashboard call must not be piled on top of itself: while a
      // background refresh is in flight, further background triggers are dropped.
      // Foreground loads (first paint, period switch, manual refresh) are never
      // dropped — they invalidate the pending background one via `requestSeq`.
      // A foreground read inside its wake-up window also blocks background
      // triggers; see `wakeInFlight`.
      if (background && (bgInFlight.current || wakeInFlight.current)) return
      const seq = ++requestSeq.current
      lastAttemptAt.current = Date.now()
      if (background) bgInFlight.current = true
      if (!background) {
        /*
         * A read someone is actually waiting on owns the schedule: drop the
         * pending ladder rung so a manual "Try again" starts again at the short
         * rung rather than at the 30-second tail of a streak it may already have
         * escaped. Without this, pressing "Try again" once during an outage would
         * leave the next automatic attempt half a minute away.
         */
        if (recoverId.current !== null) {
          window.clearTimeout(recoverId.current)
          recoverId.current = null
        }
        failures.current = 0
        wakeInFlight.current = true
        setLoading(true)
        setWaking(null)
      }
      // Announced before it goes out, so a signal arriving during the round trip
      // is held for this read to answer instead of starting a second identical
      // snapshot beside it.
      for (const tracker of trackers) tracker.begin()

      /*
       * One attempt. Kept as a closure so the wake-up loop can call it again
       * against the SAME `seq`: every retry belongs to the same logical read, so
       * one period switch cancels all of them at once rather than only the one
       * that happened to be on the wire.
       */
      const readOnce = () =>
        fetchDashboardSnapshot<DashboardMetrics>(`/api/dashboard?${rangeQuery}`, {
          background,
          /*
           * The read's own ticket. `fetchDashboardSnapshot` consults it before
           * the first attempt and before the single retry, so a period switch
           * mid-flight stops the old read instead of letting it land on top of
           * the new one — and reports `aborted`, which is deliberately NOT an
           * error the user is told about.
           */
          isCurrent: () => mounted.current && seq === requestSeq.current,
          // Still `apiFetch`: same-origin credentials and the CSRF rules are
          // the api-client's job, and this keeps the dashboard on exactly the
          // transport every other read in the app uses.
          fetchImpl: apiFetch,
          /*
           * The failure used to be visible only as a string in the page. This
           * puts the *shape* of it in the console — kind, status, attempts,
           * elapsed — which is what distinguishes "the Render instance was
           * asleep" (`network` at ~0ms) from "the server said no" (`server`
           * with a status) when someone is trying to diagnose a report of a
           * blank dashboard. No URL, no payload, no message text.
           */
          onDiagnostics: (info) => {
            if (info.kind === 'ok') {
              if (info.attempts > 1)
                console.warn('[dashboard] snapshot recovered after retry', info)
              return
            }
            console.warn('[dashboard] snapshot read failed', info)
          },
        })

      /*
       * The view `runWakeRetry` needs. It is deliberately structural — the loop
       * imports nothing from this module's collaborators, so the difference
       * between "wait some more" and "stop and tell them" is one readable object
       * rather than a call into the fetch layer.
       *
       * `offline` is read from the CLASSIFIED kind, which `snapshot-fetch` only
       * ever sets from `navigator.onLine === false`. That is what makes the brief's
       * "do not flip to Offline unless the browser is offline" true by
       * construction: a reset, a timeout and a 503 are all wake-up candidates, and
       * none of them can reach the offline branch.
       */
      const classify = (result: Awaited<ReturnType<typeof readOnce>>) => ({
        ok: result.ok,
        kind: result.kind,
        message: result.ok ? '' : result.message,
        offline: !result.ok && result.kind === 'offline',
        aborted: result.kind === 'aborted' || !mounted.current || seq !== requestSeq.current,
      })

      try {
        /*
         * Background reads are NOT put through the wake-up window. They are on a
         * timer that will come round again in 60s, and a 90-second loop per tick
         * would overlap the next tick — the duplicate-request behaviour this hook
         * goes out of its way to prevent. Only a read someone is waiting on gets
         * the budget.
         */
        const result = background
          ? await readOnce()
          : await runWakeRetry(readOnce, {
              classify,
              superseded: () => !mounted.current || seq !== requestSeq.current,
              sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
              now: () => Date.now(),
              onPhase: (phase: WakePhase) => {
                if (phase.status === 'waking')
                  setWaking({
                    attempt: phase.attempt,
                    retryInMs: phase.retryInMs,
                    elapsedMs: phase.elapsedMs,
                  })
                else setWaking(null)
              },
            })

        // Superseded before it landed: these numbers prove nothing about what is
        // on screen and must not be recorded as freshness. The read was
        // announced, though, and an announcement that is never released would
        // hold every later signal for this tab.
        if (result.kind === 'aborted' || !mounted.current || seq !== requestSeq.current) {
          for (const tracker of trackers) tracker.abandon()
          return
        }

        if (result.ok) {
          /*
           * The server's own instant for the snapshot now on screen, plus how long
           * the client waited for it: together they say where this read must have
           * begun, which is what lets each of the four subscriptions decide that a
           * baseline is describing rows it already holds. An unparseable stamp
           * becomes `null`, which `settleRead` refuses to record as proof.
           */
          for (const tracker of trackers) tracker.settle(result.serverTime, result.durationMs)
          setData(result.data)
          setError(null)
          lastFetchedAt.current = Date.now()
          /*
           * The board on screen is this instant old, and the streak that was
           * driving the ladder is over: clear both, and drop a retry that is now
           * redundant because the numbers it was waiting for have arrived.
           */
          setLastUpdated(lastFetchedAt.current)
          setStale(false)
          failures.current = 0
          if (recoverId.current !== null) {
            window.clearTimeout(recoverId.current)
            recoverId.current = null
          }
        } else {
          for (const tracker of trackers) tracker.abandon()
          /*
           * A background failure keeps the last good numbers and says nothing;
           * only the first paint is allowed to flip the whole board into an
           * error state. `result.message` is one of the fixed strings from
           * `snapshot-fetch` (or an allowlisted server sentence) — never the
           * runtime's own words, which is how "Failed to fetch" got on screen.
           * The retry the brief asks for is already here: `ErrorState`'s
           * "Try again" calls `refresh`, which is this same function.
           */
          if (!background) setError(result.message)
          /*
           * The part of the report that was never fixed before: everything here
           * had a give-up condition. The cold-start window closes after 90 seconds
           * and the polling timer used to be switched off by a `live` claim, so a
           * board that failed once stayed failed until the user reloaded the page.
           * The ladder in `read-recovery.ts` has a ceiling on the DELAY, not on the
           * number of attempts, so the dashboard keeps trying — 2s, 4s, 8s, 16s,
           * then every 30s for as long as it takes — and recovers on its own when
           * the host answers.
           *
           * Not armed when the browser itself says it has no connection: there is
           * nothing to retry against, and the `online` listener below (plus the
           * polling timer, which keeps running while the tab is visible) is the
           * honest trigger for the moment a connection comes back.
           */
          if (result.kind !== 'offline') armRecovery()
        }
      } finally {
        // Cleared unconditionally for background calls: a foreground load that
        // superseded this one (and therefore wins `requestSeq`) must still release
        // the flag, or the polling fallback would stay disabled for the rest of
        // the session. Only one background call can be in flight at a time, so it
        // is safe for the single in-flight call to clear it.
        if (background) bgInFlight.current = false
        /*
         * `mounted` is in the guard for a reason specific to the wake loop. A
         * foreground read can now live for 90 seconds, so "the component went
         * away" is a thing that happens mid-read rather than only at teardown,
         * and a superseded-but-still-running loop must not hand its own
         * `waking: null` back to the screen that replaced it.
         */
        if (seq === requestSeq.current && !background && mounted.current) {
          setLoading(false)
          setWaking(null)
          wakeInFlight.current = false
        }
      }
    },
    [rangeQuery, trackers, armRecovery]
  )

  useEffect(() => {
    loadRef.current = load
  }, [load])

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

  /*
   * The one timer that is always running, whatever the health store claims.
   *
   * It used to begin `if (connection === 'live') return`, and that single line is
   * why "updated 12:39 am" survived for hours on a phone with signal: a stream can
   * stay OPEN while delivering nothing — the server behind it stopped emitting,
   * a proxy is buffering, the cursor never advances — and a `live` claim earned by
   * one good frame was enough to switch off every automatic refresh the dashboard
   * had. There was no timer left to notice.
   *
   * So while the store says `live` this is a WATCHDOG rather than a poll: it ticks
   * often and reads only when what is on screen has genuinely aged past
   * `STALE_AFTER_MS`, which keeps the quiet-path request rate where it was (a
   * snapshot every three minutes at most, instead of none) without trusting a
   * flag for freshness. Off `live` the interval is the ordinary fallback, at the
   * same two speeds as before.
   *
   * `document.hidden` is checked *at the tick*, not by tearing the interval down
   * on visibilitychange: a hidden tab produces no visible staleness, so the cheapest
   * correct behaviour is to skip those ticks and let the reconcile effect below fetch
   * once the user is back. Before this guard the dashboard kept issuing a snapshot
   * request every 60-90s in a background tab — the one module in the app whose
   * fallback polling ignored visibility (the sync transport and `usePolling` both
   * respect it).
   */
  const { state: connection } = useConnectionState()
  useEffect(() => {
    const watching = connection === 'live'
    const ms = watching
      ? STALE_CHECK_MS
      : connection === 'reconnecting'
        ? POLL_MS
        : POLL_MS_FALLBACK
    const id = setInterval(() => {
      if (document.hidden) return
      if (watching && !isStale(Date.now(), lastAttemptAt.current, STALE_AFTER_MS)) return
      void load(true)
    }, ms)
    return () => clearInterval(id)
  }, [connection, load])

  /*
   * The "last updated" line's other half. `lastUpdated` can only ever move
   * forward on a success, so the age it reports is the age of the numbers on
   * screen — never the age of the last attempt that failed — and this ticker is
   * what lets the page say plainly that what is painted is behind the server
   * instead of letting an hours-old timestamp read as if it were current.
   */
  useEffect(() => {
    const id = setInterval(() => {
      setStale(lastFetchedAt.current > 0 && isStale(Date.now(), lastFetchedAt.current))
    }, STALE_CHECK_MS)
    return () => clearInterval(id)
  }, [])

  /*
   * Reconcile when the tab is shown again, the window is refocused or the network
   * comes back, instead of waiting for the next tick of a timer that was paused
   * meanwhile. Throttled by the same interval so a wake-from-sleep burst
   * (visibility + focus + online) costs one request.
   *
   * `focus` is listed alongside `visibilitychange` on purpose: on a desktop
   * browser a tab that is already visible can be refocused from another window
   * without producing any visibility event at all, which is the moment a user
   * glancing back at a dashboard most expects it to be current.
   */
  useEffect(() => {
    const maybeCatchUp = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastFetchedAt.current < POLL_MS) return
      void load(true)
    }
    document.addEventListener('visibilitychange', maybeCatchUp)
    window.addEventListener('focus', maybeCatchUp)
    window.addEventListener('online', maybeCatchUp)
    return () => {
      document.removeEventListener('visibilitychange', maybeCatchUp)
      window.removeEventListener('focus', maybeCatchUp)
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
    waking,
    lastUpdated,
    stale,
  }
}
