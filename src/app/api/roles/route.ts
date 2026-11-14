import { z } from 'zod'
import { successResponse, validationError, errorResponse } from '@/lib/api-response'
import { handleRouteError, getRequestMeta } from '@/lib/http'
import { authorize, requireFounder } from '@/lib/authorization'
import { getRoleCollection, getUserCollection } from '@/lib/models/User'
import { getDatabase } from '@/lib/mongodb'
import { recordAuditEntry } from '@/lib/audit'
import { adminRateLimiter } from '@/lib/rate-limit'
import {
  PERMISSION_MODULES,
  PERMISSION_ACTIONS,
  ALL_PERMISSION_ACTIONS,
  SCOPED_LAHORE_STOCK_PERMISSION,
  SCOPED_SALES_FULL_EDIT,
} from '@/lib/roles'

export const dynamic = 'force-dynamic'

/**
 * Role documents as seeded from SPEC Appendix A. Viewing requires `users.view`
 * (Founder only per §4.2), which the permissions matrix screen depends on.
 *
 * Custom roles can be created by the Founder via POST to enable non-partner
 * team members (e.g., staff) with least-privilege access.
 */

const KNOWN_MODULES = [
  ...PERMISSION_MODULES,
  SCOPED_LAHORE_STOCK_PERMISSION,
  SCOPED_SALES_FULL_EDIT,
]

const createRoleSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Role name is required')
      .max(50, 'Role name must be 50 characters or less')
      .regex(
        /^[a-z0-9_]+$/,
        'Role name must contain only lowercase letters, numbers, and underscores'
      )
      .refine((val) => val !== 'founder', 'Cannot create a role named "founder"'),
    displayName: z
      .string()
      .min(1, 'Display name is required')
      .max(100, 'Display name must be 100 characters or less'),
    permissions: z.record(
      z.enum(KNOWN_MODULES as [string, ...string[]]),
      z.record(z.enum(ALL_PERMISSION_ACTIONS as unknown as [string, ...string[]]), z.boolean())
    ),
  })
  .strict()

/**
 * Least-privilege template for custom roles (e.g., "Staff"):
 * - view-only on dashboard, tasks, and chat
 * - no finance, budgets, distributions, inventory writes, settings, users, or audit-log privileges
 */
function buildLeastPrivilegeTemplate(): Record<string, Record<string, boolean>> {
  const permissions: Record<string, Record<string, boolean>> = {}

  // Dashboard (mapped to 'finance' for view access to dashboard widgets)
  permissions.finance = { view: true, create: false, edit: false, delete: false, approve: false }

  // Tasks: view only
  permissions.tasks = { view: true, create: false, edit: false, delete: false }

  // Chat: view and create (can read and send messages)
  permissions.chat = { view: true, create: true, edit: false, delete: false }

  // All other modules: no access
  PERMISSION_MODULES.forEach((module) => {
    if (!permissions[module]) {
      const actions = PERMISSION_MODULES.includes(module as never) ? PERMISSION_ACTIONS : ['view']
      permissions[module] = {}
      actions.forEach((action) => {
        permissions[module][action] = false
      })
    }
  })

  // Scoped permissions: default to false for custom roles
  permissions[SCOPED_LAHORE_STOCK_PERMISSION] = { create: false }
  permissions[SCOPED_SALES_FULL_EDIT] = { create: false }

  return permissions
}

export async function GET() {
  try {
    await authorize('users', 'view')

    const db = await getDatabase()
    const roles = await getRoleCollection(db).find({}).sort({ name: 1 }).toArray()

    return successResponse({
      roles: roles.map((role) => ({
        _id: role._id?.toString(),
        name: role.name,
        displayName: role.displayName,
        permissions: role.permissions,
        updatedAt: role.updatedAt,
      })),
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function POST(request: Request) {
  try {
    const meta = await getRequestMeta()
    const ipKey = meta.ipAddress ? `ip:${meta.ipAddress}` : null
    if (ipKey) {
      const rl = adminRateLimiter.consume(ipKey)
      if (!rl.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil(rl.retryAfterMs / 1000))
        return errorResponse(
          `Too many requests. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`,
          429,
          'RATE_LIMITED'
        )
      }
    }

    const parsed = createRoleSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError('Invalid role payload', parsed.error.flatten().fieldErrors)
    }

    const auth = await requireFounder({
      entityId: parsed.data.name,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    const db = await getDatabase()
    const roles = getRoleCollection(db)

    // Check for duplicate role name
    const existing = await roles.findOne({ name: parsed.data.name })
    if (existing) {
      return validationError('A role with this name already exists')
    }

    const now = new Date()
    const newRole = {
      name: parsed.data.name,
      displayName: parsed.data.displayName,
      permissions: parsed.data.permissions,
      createdAt: now,
      updatedAt: now,
    }

    const result = await roles.insertOne(newRole)

    await recordAuditEntry(db, {
      userId: auth.user._id,
      userEmail: auth.user.email,
      action: 'create_role',
      entityType: 'role',
      entityId: result.insertedId,
      newValue: newRole,
      details: `Created role: ${newRole.displayName}`,
      outcome: 'success',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse({
      role: {
        _id: result.insertedId.toString(),
        name: newRole.name,
        displayName: newRole.displayName,
        permissions: newRole.permissions,
        updatedAt: newRole.updatedAt,
      },
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
