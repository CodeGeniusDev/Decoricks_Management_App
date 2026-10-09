import { z } from 'zod'
import { cookies } from 'next/headers'
import { getDatabase } from '@/lib/mongodb'
import { getSessionCollection, getUserCollection, requiresPasswordChange } from '@/lib/models/User'
import { successResponse, validationError, errorResponse } from '@/lib/api-response'
import { getRequestMeta, handleRouteError } from '@/lib/http'
import { requireAuth } from '@/lib/authorization'
import { hashPassword, validatePasswordStrength, verifyPassword } from '@/lib/auth/password'
import { SESSION_COOKIE, clearSessionCookies, createSession, hashToken, writeSessionCookies } from '@/lib/auth/session'
import { recordAuditEntry } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * Password change. Two flows share one endpoint:
 *   - self-service: `currentPassword` + `newPassword`
 *   - bootstrap: a Founder reset the password, so `mustChangePassword` is set
 *     and there is no known current password; `resetToken` is not used because
 *     the session itself already proves identity (SPEC §10.1.1 Threat 3 relies
 *     on "require old password for sensitive actions").
 *
 * On success every other session for the user is destroyed and `sessionVersion`
 * is bumped, which is what makes a password change revoke live sessions
 * everywhere (SPEC §10.1.2 Threat 4).
 */

const changeSchema = z
  .object({
    currentPassword: z.string().max(200).optional().default(''),
    newPassword: z.string().min(1, 'New password is required').max(200),
    confirmPassword: z.string().min(1, 'Confirm your new password').max(200),
  })
  .strict()

export async function POST(request: Request) {
  try {
    const meta = await getRequestMeta()
    const auth = await requireAuth()

    const parsed = changeSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError('Invalid password change', parsed.error.flatten().fieldErrors)
    }

    const { currentPassword, newPassword, confirmPassword } = parsed.data

    if (newPassword !== confirmPassword) {
      return validationError('New passwords do not match')
    }

    // SPEC §10.1.1 Threat 1: minimum length with complexity.
    const strength = validatePasswordStrength(newPassword)
    if (!strength.valid) {
      return validationError('Password does not meet the security policy', strength.errors)
    }

    const forcedChange = requiresPasswordChange(auth.user)

    if (!forcedChange) {
      const matches = await verifyPassword(currentPassword, auth.user.passwordHash)
      if (!matches) {
        const db = await getDatabase()
        await recordAuditEntry(db, {
          userId: auth.user._id,
          userEmail: auth.user.email,
          action: 'change_password_failed',
          entityType: 'user',
          entityId: auth.user._id,
          details: 'Current password did not match',
          outcome: 'failure',
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        })
        return errorResponse('Current password is incorrect', 400, 'INVALID_CURRENT_PASSWORD')
      }
    }

    if (newPassword === currentPassword && currentPassword) {
      return validationError('New password must be different from the current one')
    }

    const db = await getDatabase()
    const users = getUserCollection(db)
    const sessions = getSessionCollection(db)

    const passwordHash = await hashPassword(newPassword)
    const store = await cookies()
    const currentToken = store.get(SESSION_COOKIE)?.value

    // Bump first, then drop the other sessions. The current one is preserved so
    // the user is not logged out of the tab they just used.
    await users.updateOne(
      { _id: auth.user._id },
      {
        $set: {
          passwordHash,
          mustChangePassword: false,
          updatedAt: new Date(),
        },
        $unset: { passwordResetAt: '' },
        $inc: { sessionVersion: 1 },
      }
    )

    const updatedUser = await users.findOne({ _id: auth.user._id })
    if (!updatedUser) return errorResponse('User not found after update', 500)

    // Keep only the session making this request.
    const keepTokenHash = currentToken ? hashToken(currentToken) : null
    await sessions.deleteMany(
      keepTokenHash
        ? { userId: auth.user._id, tokenHash: { $ne: keepTokenHash } }
        : { userId: auth.user._id }
    )

    if (updatedUser.sessionVersion !== auth.session.sessionVersion) {
      // The current session predates the bump, so re-issue it rather than
      // forcing an immediate re-login.
      const session = await createSession(db, updatedUser, meta)
      await clearSessionCookies()
      await writeSessionCookies(session.tokenHash, session.csrfToken)
    }

    await recordAuditEntry(db, {
      userId: auth.user._id,
      userEmail: auth.user.email,
      action: 'change_password',
      entityType: 'user',
      entityId: auth.user._id,
      details: forcedChange ? 'Completed forced password change' : 'Changed own password',
      outcome: 'success',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse({ changed: true, mustChangePassword: false })
  } catch (error) {
    return handleRouteError(error)
  }
}
