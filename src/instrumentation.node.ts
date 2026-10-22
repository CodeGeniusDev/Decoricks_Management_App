import { getKarachiDate } from './lib/date'

/**
 * Server-only instrumentation for Node runtime.
 */
export async function register(): Promise<void> {
  pinKarachiClock()
  warnIfClockIsNotKarachi()

  if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'development') return
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  try {
    const { getDatabase } = await import('./lib/mongodb')
    const { ensureAuthIndexes } = await import('./lib/models/User')
    const db = await getDatabase()
    await ensureAuthIndexes(db)
  } catch (error) {
    console.error('[instrumentation] failed to ensure auth indexes', error)
  }
}

/**
 * The application's whole date layer is written against an Asia/Karachi process.
 *
 * `src/lib/date.ts` stamps records with `getKarachiDate()`, which reads the
 * process clock through the Karachi convention and hands the resulting *string*
 * back to `new Date()` — so the instant it produces is only correct when the
 * process itself runs in Asia/Karachi, and `getStartOfDay()`/`getEndOfDay()`/
 * `getStartOfWeek()` build their boundaries with local `new Date(y, m, d)`
 * constructors for the same reason. `docs/METRICS.md` §0.2 states the contract:
 * store UTC instants, bucket on the Karachi civil calendar.
 *
 * A serverless platform gives every container a UTC clock. Left alone, the app
 * then stores every timestamp five hours in front of the instant it happened,
 * which Phase 5 §3 measured directly: `updatedAt` 1792594007000 for a write the
 * database filed at 1792576011000. Two of its consumers degrade silently — every
 * displayed timestamp reads 5h ahead, and cross-device sync dies, because the
 * realtime cursor is built from those shifted stamps while the change stream's
 * `clusterTime` is a true instant, so every live signal sits below the baseline
 * the client adopted and the `ts > prev` rule suppresses it. (Verified: all four
 * inventory changes were dropped in a shipped bundle running under `TZ=UTC`.)
 *
 * An explicit `TZ` from the deployment always wins, so this is a floor, not an
 * override, and Node re-reads `process.env.TZ` on every date operation.
 */
function pinKarachiClock(): void {
  if (process.env.TZ) return
  process.env.TZ = 'Asia/Karachi'
}

/**
 * Beyond this the civil-day boundaries the finance layer derives are in a
 * different day than the instant they describe, so the check is not pedantry
 * about nanoseconds.
 */
const CLOCK_TOLERANCE_MS = 60_000

/**
 * Warn out loud when the process is not on the clock the date layer assumes.
 *
 * `pinKarachiClock()` deliberately refuses to override an explicit `TZ`, which
 * is the right contract for a test runner that wants a fixed zone — but it also
 * means a platform that pins `TZ=UTC` (or any zone that is not literally named
 * `Asia/Karachi`) silently shifts every timestamp the application stores.
 * Measured in Phase 5 §7, on this working tree, three host zones:
 *
 *   TZ=Asia/Karachi  drift -0.000h   (correct)
 *   TZ=UTC           drift +5.000h
 *   TZ=Asia/Lahore   drift +5.000h   ← the trap: same +05:00 OFFSET, wrong name.
 *                                     `getKarachiDate()` renders Karachi wall
 *                                     time and re-parses it in the process zone,
 *                                     so the zone identifier has to match, not
 *                                     the number of hours.
 *
 * Left alone, that shift is invisible: logins work, pages render, sync stays
 * consistent with itself, and only the ledger is quietly five hours ahead —
 * moving the `getStartOfDay()`/`getEndOfDay()` boundaries that decide which
 * financial day a transaction just before midnight belongs to. A warning at boot
 * turns a data-correctness hazard into a visible misconfiguration, and it costs
 * nothing on a correctly configured host (drift 0, silent).
 */
export function warnIfClockIsNotKarachi(): void {
  const driftMs = getKarachiDate().getTime() - Date.now()
  if (Math.abs(driftMs) <= CLOCK_TOLERANCE_MS) return
  console.warn(
    `[instrumentation] process clock is not on Asia/Karachi: getKarachiDate() is ` +
      `${(driftMs / 3_600_000).toFixed(2)}h away from the true instant, so stored ` +
      `timestamps and Karachi civil-day boundaries are shifted. Set TZ=Asia/Karachi ` +
      `(an equivalent offset under another zone name is not enough), or unset TZ so ` +
      `the boot-time pin applies. Current TZ=${JSON.stringify(process.env.TZ ?? '<unset>')}.`
  )
}
