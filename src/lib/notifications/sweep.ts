import type { Db } from 'mongodb'
import { ObjectId } from 'mongodb'
import { getColumnCollection, getTaskDocCollection } from '@/lib/models/Tasks'
import { buildStockSummary } from '@/lib/stock-summary'
import { notifyLowStock, notifyTaskDueSoon, notifyTaskOverdue } from './events'

/**
 * Phase 9 lazy time-sweep (design §2.8).
 *
 * THE PROBLEM: a free host has no cron and its serverless process sleeps between
 * requests, so nothing runs on a timer to notice that a task crossed its due date
 * or that stock drifted low. There is no background daemon to stand up.
 *
 * THE APPROACH: piggyback the time-based detection onto requests that already
 * happen — opening the notification bell, loading the dashboard. Each qualifying
 * read calls `maybeRunNotificationSweep`, which at most once per interval kicks a
 * throttled, in-process sweep. It is a *lazy* sweep, not a scheduler: detection
 * happens on the next bit of real traffic, never on a wall-clock.
 *
 * WHAT HAPPENS WHILE THE SERVER SLEEPS (stated honestly): nothing. No overdue or
 * low-stock notification is generated while zero requests arrive — there is no
 * process to run the check and no cron to wake one. The moment the first request
 * lands, the sweep runs and every already-crossed event fires. Because each emit
 * is DEDUPED (overdue per Karachi-day, due-soon once per task, low-stock per
 * product-day) and permission/pref-gated, a catch-up after a quiet night produces
 * exactly one alert per event, never a backlog of duplicates. State-based events
 * (a stock write, an expense) are unaffected — they fire on their own write route.
 *
 * It NEVER re-implements business rules: "overdue / due-soon" reuse the exact
 * Phase 6 predicate (open, dated, not in a board's done column) and low stock
 * reuses the Phase 5 `buildStockSummary`. This module only decides WHEN to look.
 */

/** A task is "due soon" if it is due within this window from now. */
export const DUE_SOON_WINDOW_MS = 48 * 60 * 60 * 1000 // 2 days

/** Minimum spacing between sweeps so the piggyback never hammers the database. */
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes

export interface SweepResult {
  overdue: number
  dueSoon: number
  lowStock: number
}

let lastRunAt = 0
let inFlight: Promise<SweepResult> | null = null

/**
 * Force a full sweep regardless of the throttle. Used by the sweep's own tests
 * and (indirectly) by `maybeRunNotificationSweep`. Returns counts of NEW
 * notifications actually created (dedupe-suppressed events count zero).
 */
export async function runNotificationSweep(db: Db): Promise<SweepResult> {
  lastRunAt = Date.now()
  const now = new Date()

  // Phase 6 "done": a task only counts as outstanding while it sits OUTSIDE its
  // board's done column. We resolve the done columns once and exclude them.
  const doneColumns = await getColumnCollection(db)
    .find({ isDoneColumn: true } as never)
    .project<{ _id: ObjectId }>({ _id: 1 })
    .toArray()
  const doneColumnIds = doneColumns.map((c) => c._id)

  const soonCutoff = new Date(now.getTime() + DUE_SOON_WINDOW_MS)

  // Open, dated tasks not already in a done column — the same filter the board's
  // "overdue" view uses. Small for a 4-partner app, so a single indexed scan is
  // cheaper than maintaining a separate due-date projection.
  const candidates = await getTaskDocCollection(db)
    .find({
      isArchived: false,
      dueDate: { $ne: null },
      columnId: { $nin: doneColumnIds },
    } as never)
    .toArray()

  let overdue = 0
  let dueSoon = 0
  for (const task of candidates) {
    if (!task.dueDate || !task._id) continue
    const assigneeIds = task.assigneeIds.map((id) => id.toString())
    // An unassigned card has nobody to nudge; we never broadcast task reminders
    // to the whole org, and the emit layer would drop them anyway.
    if (assigneeIds.length === 0) continue

    if (task.dueDate < now) {
      overdue += await notifyTaskOverdue(db, {
        taskId: task._id.toString(),
        title: task.title,
        assigneeIds,
        dueDate: task.dueDate,
      })
    } else if (task.dueDate <= soonCutoff) {
      dueSoon += await notifyTaskDueSoon(db, {
        taskId: task._id.toString(),
        title: task.title,
        assigneeIds,
        dueDate: task.dueDate,
      })
    }
  }

  // Low-stock catalogue backstop: covers products that only the periodic view
  // would catch (e.g. stock that dropped via a route we did not hand-wire). The
  // per-product-per-day dedupe makes this near-free on repeat runs.
  let lowStock = 0
  try {
    const summary = await buildStockSummary(db)
    lowStock = await notifyLowStock(db, summary.items)
  } catch (error) {
    console.error('[sweep] low-stock backstop failed:', error)
  }

  return { overdue, dueSoon, lowStock }
}

/**
 * Throttled, awaitable entry point for request handlers. Returns a promise that
 * RESOLVES AS SOON AS the sweep is complete (or immediately if one is not due),
 * so the bell's first read after a quiet period already includes caught-up
 * notifications instead of rendering, then re-rendering — no double-paint. It
 * shares one in-flight sweep across concurrent callers and never rejects: a
 * failure is logged and the awaiting read simply proceeds without new rows.
 */
export function maybeRunNotificationSweep(db: Db): Promise<void> {
  if (inFlight) return inFlight.then(() => undefined)
  if (Date.now() - lastRunAt < SWEEP_INTERVAL_MS) return Promise.resolve()

  inFlight = runNotificationSweep(db)
    .catch((error) => {
      console.error('[sweep] notification sweep failed:', error)
      return { overdue: 0, dueSoon: 0, lowStock: 0 } as SweepResult
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight.then(() => undefined)
}

/** Test seam: reset the throttle so a suite can force repeated sweeps. */
export const __resetSweepForTests = (): void => {
  lastRunAt = 0
  inFlight = null
}
