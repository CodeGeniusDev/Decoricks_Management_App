import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/mongodb'
import { getUserCollection, requiresPasswordChange } from '@/lib/models/User'
import { successResponse, validationError, errorResponse } from '@/lib/api-response'
import { getRequestMeta, handleRouteError } from '@/lib/http'
import { verifyPassword } from '@/lib/auth/password'
import { createSession, writeSessionCookies } from '@/lib/auth/session'
import {
  clearLoginAttempts,
  getLockoutStatus,
  recordLoginAttempt,
} from '@/lib/auth/lockout'
import { recordAuditEntry } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * SPEC §10.1.2 Threat 3: no public signup exists, so this is the only way in.
 * SPEC §10.2.6 Test 16 requires success and failure both be audited.
 */

const loginSchema = z.object({
  email: z.string().min(1, 'Email is required').max(254),
  // Deliberately only a length bound, not the full policy: a weak password is
  // still hashed and compared, otherwise "account exists" could be inferred
  // from which validation error came back.
  password: z.string().min(1, 'Password is required').max(200),
})

/**
 * One message for every failure mode (unknown email, wrong password, inactive
 * account) so the response cannot be used to enumerate accounts.
 */
const GENERIC_ERROR = 'Invalid email or password'

/**
 * A valid bcrypt hash (cost 12) of a value nobody knows, used only to equalise
 * timing on the unknown-account path so a response cannot be used to probe
 * which email addresses have accounts.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.7DKJ7OQmS8jnrvJ1e1zvKz0F8W1nZuW'

export async function POST(request: Request) {
  try {
    const meta = await getRequestMeta()
    const body = await request.json().catch(() => null)

    const parsed = loginSchema.safeParse(body)
    if (!parsed.success) {
      return validationError('Email and password are required', parsed.error.flatten().fieldErrors)
    }

    const email = parsed.data.email.trim().toLowerCase()
    const db = await getDatabase()
    const users = getUserCollection(db)

    // SPEC §10.2.1 Test 2: 5 failures within 15 minutes locks the account.
    const lockout = await getLockoutStatus(db, email)
    if (lockout.locked) {
      await recordLoginAttempt(db, email, false, meta)
      await recordAuditEntry(db, {
        userId: null,
        userEmail: email,
        action: 'login_locked',
        entityType: 'user',
        details: `Login blocked: account locked for ${lockout.retryAfterMinutes} more minute(s)`,
        outcome: 'denied',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
      return errorResponse(
        `Too many failed attempts. Try again in ${lockout.retryAfterMinutes} minute${lockout.retryAfterMinutes === 1 ? '' : 's'}.`,
        429,
        'ACCOUNT_LOCKED',
        { lockedUntil: lockout.lockedUntil?.toISOString() }
      )
    }

    const user = await users.findOne({ email })

    // Hash a dummy password when the account is unknown so response timing
    // cannot distinguish "no such user" from "wrong password".
    const hash = user?.passwordHash ?? DUMMY_HASH
    const passwordMatches = await verifyPassword(parsed.data.password, hash)

    if (!user || !passwordMatches || !user.isActive) {
      await recordLoginAttempt(db, email, false, meta)
      await recordAuditEntry(db, {
        userId: user?._id ?? null,
        userEmail: email,
        action: 'login_failed',
        entityType: 'user',
        entityId: user?._id ?? null,
        details: user && !user.isActive ? 'Login attempt on a deactivated account' : 'Invalid credentials',
        outcome: 'failure',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
      return errorResponse(GENERIC_ERROR, 401, 'INVALID_CREDENTIALS')
    }

    // SPEC §10.1.1 Threat 2: regenerate the session identifier on login.
    const session = await createSession(db, user, meta)
    await clearLoginAttempts(db, email)
    await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } })

    await recordAuditEntry(db, {
      userId: user._id,
      userEmail: user.email,
      action: 'login_success',
      entityType: 'user',
      entityId: user._id,
      details: 'Signed in',
      outcome: 'success',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    await writeSessionCookies(session.tokenHash, session.csrfToken)

    return successResponse({
      user: {
        _id: user._id?.toString(),
        email: user.email,
        name: user.name,
        role: user.role,
        // The client uses this to force the change-password screen.
        mustChangePassword: requiresPasswordChange(user),
      },
      mustChangePassword: requiresPasswordChange(user),
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
