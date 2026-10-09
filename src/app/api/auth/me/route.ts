import { z } from 'zod'
import { getDatabase } from '@/lib/mongodb'
import { getUserCollection, userToJSON, requiresPasswordChange } from '@/lib/models/User'
import { successResponse, validationError, notFoundError } from '@/lib/api-response'
import { getRequestMeta, handleRouteError } from '@/lib/http'
import { requireAuth } from '@/lib/authorization'
import { recordAuditEntry } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * Current session identity. The client calls this on load to decide whether to
 * render the app, the login screen, or force a password change.
 */
export async function GET() {
  try {
    const auth = await requireAuth()

    return successResponse({
      user: userToJSON(auth.user),
      mustChangePassword: requiresPasswordChange(auth.user),
      session: {
        expiresAt: auth.session.expiresAt,
        csrfToken: auth.session.csrfToken,
      },
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

/** Update own profile. SPEC §3.1.1 grants no self-service role field. */
const profileSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(120),
  })
  // SPEC §10.2.3 Test 8 (mass assignment): reject `role`, `isActive`, etc.
  // outright rather than silently ignoring them.
  .strict()

export async function PATCH(request: Request) {
  try {
    const meta = await getRequestMeta()
    const auth = await requireAuth()

    const parsed = profileSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError('Invalid profile update', parsed.error.flatten().fieldErrors)
    }

    const db = await getDatabase()
    const users = getUserCollection(db)

    await users.updateOne(
      { _id: auth.user._id },
      { $set: { name: parsed.data.name, updatedAt: new Date() } }
    )

    const updated = await users.findOne({ _id: auth.user._id })
    if (!updated) return notFoundError('User not found after update')

    await recordAuditEntry(db, {
      userId: auth.user._id,
      userEmail: auth.user.email,
      action: 'update_profile',
      entityType: 'user',
      entityId: auth.user._id,
      oldValue: { name: auth.user.name },
      newValue: { name: updated.name },
      details: 'Updated own profile',
      outcome: 'success',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse({ user: userToJSON(updated) })
  } catch (error) {
    return handleRouteError(error)
  }
}