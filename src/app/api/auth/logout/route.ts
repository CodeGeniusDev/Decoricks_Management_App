import { cookies } from 'next/headers'
import { getDatabase } from '@/lib/mongodb'
import { successResponse } from '@/lib/api-response'
import { getRequestMeta, handleRouteError } from '@/lib/http'
import {
  SESSION_COOKIE,
  clearSessionCookies,
  getAuthenticatedUser,
  revokeSession,
} from '@/lib/auth/session'
import { recordAuditEntry } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    const meta = await getRequestMeta()
    const store = await cookies()
    const token = store.get(SESSION_COOKIE)?.value

    // Idempotent: signing out with no session is a success, not an error, so a
    // double-click or an already-expired cookie does not surface a failure.
    if (!token) {
      await clearSessionCookies()
      return successResponse({ signedOut: true })
    }

    const db = await getDatabase()
    const auth = await getAuthenticatedUser(db, token)

    await revokeSession(db, token)
    await clearSessionCookies()

    if (auth) {
      await recordAuditEntry(db, {
        userId: auth.user._id,
        userEmail: auth.user.email,
        action: 'logout',
        entityType: 'user',
        entityId: auth.user._id,
        details: 'Signed out',
        outcome: 'success',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
    }

    return successResponse({ signedOut: true })
  } catch (error) {
    return handleRouteError(error)
  }
}
