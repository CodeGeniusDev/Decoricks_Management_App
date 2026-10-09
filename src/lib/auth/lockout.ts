import type { Db } from 'mongodb'
import { getEnv } from '@/lib/env'
import { getLoginAttemptCollection } from '@/lib/models/User'

/**
 * Account lockout per SPEC.md §10.2.1 Test 2, which is authoritative over the
 * conflicting "after 10 failed attempts" line in §10.1.1 Threat 1:
 *
 *   1. Attempt login with wrong password 5 times
 *   2. Attempt 6th login
 *   Expected: account locked for 15 minutes
 *
 * The window is a sliding 15 minutes: only attempts inside the window count,
 * so a user who stops trying long enough is not locked forever.
 */

export interface LockoutStatus {
  locked: boolean
  failedAttempts: number
  lockedUntil: Date | null
  /** Remaining whole minutes, for user-facing messaging. */
  retryAfterMinutes: number
}

const WINDOW_MS = () => getEnv().LOGIN_WINDOW_MINUTES * 60 * 1000
const MAX_ATTEMPTS = () => getEnv().LOGIN_MAX_ATTEMPTS
const LOCKOUT_MS = () => getEnv().LOCKOUT_MINUTES * 60 * 1000

export const normalizeIdentifier = (email: unknown): string =>
  typeof email === 'string' ? email.trim().toLowerCase() : ''

export const recordLoginAttempt = async (
  db: Db,
  identifier: string,
  successful: boolean,
  meta: { ipAddress?: string; userAgent?: string } = {}
): Promise<void> => {
  await getLoginAttemptCollection(db).insertOne({
    identifier: normalizeIdentifier(identifier),
    successful,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    createdAt: new Date(),
  })
}

/**
 * A lockout is in force while `LOGIN_MAX_ATTEMPTS` failures exist inside the
 * window and the newest of them is still inside the lockout period. Recording
 * failures against an unknown email still burns attempts, which stops an
 * attacker from probing account existence by watching the lockout appear only
 * for real users.
 */
export const getLockoutStatus = async (db: Db, identifier: string): Promise<LockoutStatus> => {
  const now = Date.now()
  const windowStart = new Date(now - WINDOW_MS())

  const recentFailures = await getLoginAttemptCollection(db)
    .find({
      identifier: normalizeIdentifier(identifier),
      successful: false,
      createdAt: { $gte: windowStart },
    })
    .sort({ createdAt: -1 })
    .limit(MAX_ATTEMPTS())
    .toArray()

  if (recentFailures.length < MAX_ATTEMPTS()) {
    return {
      locked: false,
      failedAttempts: recentFailures.length,
      lockedUntil: null,
      retryAfterMinutes: 0,
    }
  }

  const newest = recentFailures[0].createdAt.getTime()
  const lockedUntilMs = newest + LOCKOUT_MS()

  if (lockedUntilMs <= now) {
    return {
      locked: false,
      failedAttempts: recentFailures.length,
      lockedUntil: null,
      retryAfterMinutes: 0,
    }
  }

  return {
    locked: true,
    failedAttempts: recentFailures.length,
    lockedUntil: new Date(lockedUntilMs),
    retryAfterMinutes: Math.max(1, Math.ceil((lockedUntilMs - now) / 60000)),
  }
}

/** Clears the failure history after a successful login. */
export const clearLoginAttempts = async (db: Db, identifier: string): Promise<void> => {
  await getLoginAttemptCollection(db).deleteMany({ identifier: normalizeIdentifier(identifier) })
}

export const purgeExpiredLoginAttempts = async (db: Db): Promise<number> => {
  const cutoff = new Date(Date.now() - WINDOW_MS() - LOCKOUT_MS())
  const result = await getLoginAttemptCollection(db).deleteMany({ createdAt: { $lt: cutoff } })
  return result.deletedCount ?? 0
}