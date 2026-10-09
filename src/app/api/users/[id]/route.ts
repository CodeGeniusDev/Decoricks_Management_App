import { z } from 'zod'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import {
  getSessionCollection,
  getUserCollection,
  isValidObjectId,
  userToJSON,
} from '@/lib/models/User'
import {
  successResponse,
  validationError,
  errorResponse,
  notFoundError,
} from '@/lib/api-response'
import { getRequestMeta, handleRouteError } from '@/lib/http'
import { requireFounder } from '@/lib/authorization'
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password'
import { ROLE_NAMES } from '@/lib/roles'
import { recordAuditEntry } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * SPEC §4.3: role assignment may only be modified by the Founder. Each mutation
 * below therefore starts with `requireFounder`.
 *
 * Deactivation and password reset both bump `sessionVersion` and delete the
 * target's sessions, which is what makes an already-issued cookie stop working
 * on the very next request instead of lingering until its 30-minute expiry.
 */

type RouteContext = { params: Promise<{ id: string }> }

const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: z.enum(ROLE_NAMES as [string, ...string[]]).optional(),
    partnerId: z.string().trim().max(60).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

const resetPasswordSchema = z
  .object({
    password: z.string().min(1).max(200),
  })
  .strict()

const loadUser = async (id: string) => {
  if (!isValidObjectId(id)) return null
  const db = await getDatabase()
  const user = await getUserCollection(db).findOne({ _id: new ObjectId(id) })
  return user ? { db, user } : null
}

export async function GET(request: Request, context: RouteContext) {
  try {
    // SPEC §4.3 makes Users Founder-only. This read was the one ungated path in
    // the new API: middleware only checks that a session cookie *exists*, so any
    // signed-in Partner could enumerate user records by id. A missing id would
    // have returned 404 rather than 403, which also confirmed the route existed.
    const meta = await getRequestMeta()
    const { id } = await context.params
    await requireFounder({
      entityId: id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    const found = await loadUser(id)
    if (!found) return notFoundError('User not found')

    return successResponse({ user: userToJSON(found.user) })
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const meta = await getRequestMeta()
    const { id } = await context.params

    const parsed = updateUserSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError('Invalid update', parsed.error.flatten().fieldErrors)
    }
    const changes = parsed.data
    if (Object.keys(changes).length === 0) {
      return validationError('No changes supplied')
    }

    const auth = await requireFounder({ entityId: id, ipAddress: meta.ipAddress, userAgent: meta.userAgent })

    const found = await loadUser(id)
    if (!found) return notFoundError('User not found')
    const { db, user } = found

    // Guard rails: the app must not be able to lock its last Founder out.
    if (user.role === 'founder') {
      if (changes.role && changes.role !== 'founder') {
        return errorResponse('The Founder role cannot be downgraded', 400, 'FOUNDER_PROTECTED')
      }
      if (changes.isActive === false) {
        return errorResponse('The Founder account cannot be deactivated', 400, 'FOUNDER_PROTECTED')
      }
    }

    // A Partner must not be able to escalate by editing themselves; that case is
    // already blocked by requireFounder, but a Founder editing their own role is
    // also refused for clarity.
    if (user._id?.equals(auth.user._id as never) && changes.role && changes.role !== user.role) {
      return errorResponse('You cannot change your own role', 400, 'SELF_ROLE_CHANGE')
    }

    const now = new Date()
    const update: Record<string, unknown> = { updatedAt: now }

    if (changes.name !== undefined) update.name = changes.name
    if (changes.role !== undefined) update.role = changes.role
    if (changes.partnerId !== undefined) update.partnerId = changes.partnerId ?? undefined
    if (changes.isActive !== undefined) update.isActive = changes.isActive

    // Deactivating or re-roling a user must invalidate their live sessions.
    const revokesSessions =
      changes.isActive === false ||
      (changes.role !== undefined && changes.role !== user.role)

    if (revokesSessions) {
      update.sessionVersion = (user.sessionVersion ?? 1) + 1
    }

    await getUserCollection(db).updateOne({ _id: user._id }, { $set: update })

    if (revokesSessions) {
      await getSessionCollection(db).deleteMany({ userId: user._id })
    }

    const updated = await getUserCollection(db).findOne({ _id: user._id })
    if (!updated) return notFoundError('User not found after update')

    await recordAuditEntry(db, {
      userId: auth.user._id,
      userEmail: auth.user.email,
      action: changes.isActive === false ? 'deactivate_user' : changes.isActive === true ? 'reactivate_user' : 'update_user',
      entityType: 'user',
      entityId: user._id,
      oldValue: {
        name: user.name,
        role: user.role,
        partnerId: user.partnerId,
        isActive: user.isActive,
      },
      newValue: {
        name: updated.name,
        role: updated.role,
        partnerId: updated.partnerId,
        isActive: updated.isActive,
      },
      details: revokesSessions
        ? `Updated ${updated.email}; active sessions revoked`
        : `Updated ${updated.email}`,
      outcome: 'success',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse({ user: userToJSON(updated) })
  } catch (error) {
    return handleRouteError(error)
  }
}

/**
 * Founder-initiated password reset. The target is forced to change it on next
 * login and every existing session is destroyed immediately.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const meta = await getRequestMeta()
    const { id } = await context.params

    const parsed = resetPasswordSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError('Invalid password reset', parsed.error.flatten().fieldErrors)
    }

    const strength = validatePasswordStrength(parsed.data.password)
    if (!strength.valid) {
      return validationError('Password does not meet the security policy', strength.errors)
    }

    const auth = await requireFounder({ entityId: id, ipAddress: meta.ipAddress, userAgent: meta.userAgent })

    const found = await loadUser(id)
    if (!found) return notFoundError('User not found')
    const { db, user } = found

    const now = new Date()
    await getUserCollection(db).updateOne(
      { _id: user._id },
      {
        $set: {
          passwordHash: await hashPassword(parsed.data.password),
          mustChangePassword: true,
          passwordResetAt: now,
          updatedAt: now,
        },
        // `$inc` takes a delta, not an absolute value. Passing
        // `(currentVersion + 1)` here would make the stored version jump to
        // `2 * current + 1` on every reset.
        $inc: { sessionVersion: 1 },
      }
    )
    await getSessionCollection(db).deleteMany({ userId: user._id })

    await recordAuditEntry(db, {
      userId: auth.user._id,
      userEmail: auth.user.email,
      action: 'reset_password',
      entityType: 'user',
      entityId: user._id,
      details: `Reset password for ${user.email}; all sessions revoked`,
      outcome: 'success',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse({ reset: true })
  } catch (error) {
    return handleRouteError(error)
  }
}
