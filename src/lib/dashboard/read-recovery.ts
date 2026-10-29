/**
 * The rules that decide when a failed or ageing read must be attempted again.
 *
 * WHY THIS EXISTS. The reported symptom was a dashboard that said "updated
 * 12:39 am" many hours later, on a phone with signal, and never moved. Each
 * retry path in the app had its own give-up condition: `useDashboard` stopped
 * retrying when the 90-second cold-start window closed, its polling timer was
 * switched off entirely whenever the store claimed `live` — so a stream that was
 * connected but silent produced NO timer at all — and the report pages retried
 * only when a realtime signal happened to arrive. Nothing in the app kept
 * trying indefinitely.
 *
 * Two invariants, and they are the brief's words:
 *
 *   **Never give up for good.** A backoff ladder whose ceiling is a delay is
 *   still a schedule, not a stop condition. `recoveryDelayMs` saturates; it does
 *   not terminate.
 *   **Cap the delay at about 30 seconds.** Without a floor the ladder would
 *   reach ten minutes by attempt 10, which is indistinguishable from broken.
 *   With a ceiling the worst case is a page that converges half a minute after
 *   the server comes back on its own, with no user action.
 *
 * `STALE_AFTER_MS` is the freshness floor, and it exists for the case no event
 * covers: everything *thinks* it is fine. A socket can stay open while the
 * server behind it stops delivering, a `live` claim can outlive the data it was
 * earned by, and a tab left open overnight receives no focus and no
 * visibility-change worth calling anything. If the numbers on screen are older
 * than this while the tab is visible, they are re-read — regardless of what any
 * health flag says.
 *
 * Pure and parameterised on `now` / attempt count because the suite runs these
 * modules in node with no DOM (`vitest.config.ts`), and the interesting part of
 * a schedule is the arithmetic, not the timer.
 */

/** First retry waits two seconds: long enough to skip a transient blip. */
export const MIN_RECOVERY_DELAY_MS = 2_000

/** The brief's cap. Past this the ladder is flat, not finished. */
export const MAX_RECOVERY_DELAY_MS = 30_000

/** A few minutes, per the brief: the point at which quiet data is re-read anyway. */
export const STALE_AFTER_MS = 3 * 60_000

/** How often the staleness floor is checked. */
export const STALE_CHECK_MS = 15_000

/**
 * Delay before the next attempt after `consecutiveFailures` failures.
 *
 * 2s, 4s, 8s, 16s, 30s, 30s, 30s… Never throws and always returns a usable
 * delay, because the callers are React effects computing a timer value and a
 * schedule that refuses to compute is a page that stops recovering — the exact
 * failure mode this file exists to prevent. Nonsense is read the way the callers
 * mean it: `NaN`, zero and negatives mean "no failures yet" so the answer is the
 * short rung, while `Infinity` means "this streak has overflowed" so the answer
 * is the ceiling. Mapping +Infinity to the floor would be the dangerous one — a
 * counter that wrapped or was computed from an unknown elapsed time would fire at
 * a server that is already down every two seconds, forever.
 */
export const recoveryDelayMs = (consecutiveFailures: number): number => {
  if (Number.isNaN(consecutiveFailures) || !(consecutiveFailures > 0)) return MIN_RECOVERY_DELAY_MS
  if (!Number.isFinite(consecutiveFailures)) return MAX_RECOVERY_DELAY_MS
  const ladder = MIN_RECOVERY_DELAY_MS * 2 ** (Math.floor(consecutiveFailures) - 1)
  return Math.min(MAX_RECOVERY_DELAY_MS, ladder)
}

/**
 * Whether a payload read at `lastSuccessAt` must be re-read now.
 *
 * `0` means "never succeeded", which is stale by definition — but callers that
 * own a first paint should not treat this as an instruction to double-fetch;
 * `useDashboard` guards its watchdog on having a first result.
 */
export const isStale = (now: number, lastSuccessAt: number, staleMs = STALE_AFTER_MS): boolean =>
  now - lastSuccessAt >= staleMs
