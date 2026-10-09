import { z } from 'zod'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getRoleCollection, isValidObjectId } from '@/lib/models/User'
import { successResponse, validationError, notFoundError } from '@/lib/api-response'
import { getRequestMeta, handleRouteError } from '@/lib/http'
import { invalidateRoleCache, requireFounder } from '@/lib/authorization'
import {
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  SCOPED_LAHORE_STOCK_PERMISSION,
  SCOPED_SALES_FULL_EDIT,
} from '@/lib/roles'
import { recordAuditEntry } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * Permission edits are Founder-only (SPEC §4.2 "Users" row, §4.3 "Permissions
 * are stored in the roles collection").
 *
 * Every write calls `invalidateRoleCache()` synchronously *before* returning,
 * so the change is in force on the very next request rather than whenever the
 * in-memory cache happens to expire (SPEC §4.3 asks for a cache; the
 * "revocable immediately" requirement needs the invalidation to be explicit).
 */

type RouteContext = { params: Promise<{ id: string }> }

const KNOWN_MODULES = [
  ...PERMISSION_MODULES,
  SCOPED_LAHORE_STOCK_PERMISSION,
  SCOPED_SALES_FULL_EDIT,
]

const updatePermissionsSchema = z
  .object({
    permissions: z.record(
      z.enum(KNOWN_MODULES as [string, ...string[]]),
      z.record(z.enum(PERMISSION_ACTIONS as unknown as [string, ...string[]]), z.boolean())
    ),
  })
  .strict()

export async function PUT(request: Request, context: RouteContext) {
  try {
    const meta = await getRequestMeta()
    const { id } = await context.params

    const parsed = updatePermissionsSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError('Invalid permissions payload', parsed.error.flatten().fieldErrors)
    }

    const auth = await requireFounder({ entityId: id, ipAddress: meta.ipAddress, userAgent: meta.userAgent })

    if (!isValidObjectId(id)) return notFoundError('Role not found')

    const db = await getDatabase()
    const roles = getRoleCollection(db)
    const existing = await roles.findOne({ _id: new ObjectId(id) })
    if (!existing) return notFoundError('Role not found')

    // The Founder's role is not editable: it is the root of the trust model, and
    // allowing it to be narrowed would let a Partner lock the Founder out.
    if (existing.name === 'founder') {
      return validationError('The Founder role permissions cannot be changed')
    }

    const before = existing.permissions
    const after = { ...before, ...parsed.data.permissions }

    await roles.updateOne({ _id: existing._id }, { $set: { permissions: after, updatedAt: new Date() } })

    // Immediate revocation.
    invalidateRoleCache()

    await recordAuditEntry(db, {
      userId: auth.user._id,
      userEmail: auth.user.email,
      action: 'update_permissions',
      entityType: 'role',
      entityId: existing._id,
      oldValue: before,
      newValue: after,
      details: `Updated permissions for ${existing.displayName}`,
      outcome: 'success',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse({
      role: {
        _id: existing._id?.toString(),
        name: existing.name,
        displayName: existing.displayName,
        permissions: after,
        updatedAt: new Date(),
      },
    })
  } catch (error) {
    return handleRouteError(error)
  }
}