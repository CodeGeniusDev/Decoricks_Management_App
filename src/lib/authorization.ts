import { ObjectId } from 'mongodb'
import type { Db } from 'mongodb'
import { headers } from 'next/headers'
import { getDatabase, withMongoRetry } from '@/lib/mongodb'
import { recordAuditEntry } from '@/lib/audit'
import { getAuthenticatedUser, type AuthenticatedUser } from '@/lib/auth/session'
import {
  getRoleCollection,
  requiresPasswordChange,
  type PermissionAction,
  type PermissionModule,
  type Role,
} from '@/lib/models/User'
// Re-exported for existing call sites; the values themselves live in `roles.ts`
// so client components can import them without dragging in mongodb.
export {
  LAHORE_STOCK_ROLES,
  SALES_FULL_EDIT_ROLES,
  SCOPED_LAHORE_STOCK_PERMISSION,
  SCOPED_SALES_FULL_EDIT,
} from '@/lib/roles'

import {
  isFounderRole,
  LAHORE_STOCK_ROLES,
  SALES_FULL_EDIT_ROLES,
  SCOPED_LAHORE_STOCK_PERMISSION,
  SCOPED_SALES_FULL_EDIT,
} from '@/lib/roles'

/**
 * The single server-side authorization gate.
 *
 * Every API route and every server action resolves permissions through this
 * module — SPEC §4.3 ("All permission checks are enforced on the server") and
 * §10.1.2 Threat 4 ("No client-side permission enforcement"). There is no
 * second code path: a route that does not call `authorize` cannot read the
 * permission matrix at all.
 *
 * Hiding nav items in the client is a convenience only. It is never a
 * substitute for this check.
 */

export class AuthenticationError extends Error {
  readonly status = 401
  constructor(message = 'Authentication required') {
    super(message)
    this.name = 'AuthenticationError'
  }
}

export class AuthorizationError extends Error {
  readonly status = 403
  constructor(
    readonly module: string,
    readonly action: string,
    message = 'You do not have permission to perform this action'
  ) {
    super(message)
    this.name = 'AuthorizationError'
  }
}

/**
 * SPEC §10.1.1 / Phase 2 forced-password-change requirement.
 *
 * A user who is still on a temporary password (newly created, or reset by a
 * Founder) must not be able to use the app until they set their own. The client
 * redirects them to /change-password, but that is only a convenience — a direct
 * API call would otherwise sail through, so every module/permission check below
 * refuses until the flag is cleared.
 *
 * Deliberately *not* added to `requireAuth`: the change-password endpoint itself
 * needs an authenticated caller, and gating it would make the forced change
 * impossible to complete.
 */
export class PasswordChangeRequiredError extends Error {
  readonly status = 403
  constructor(message = 'You must change your password before continuing') {
    super(message)
    this.name = 'PasswordChangeRequiredError'
  }
}

const assertPasswordChanged = (auth: AuthenticatedUser): void => {
  if (requiresPasswordChange(auth.user)) throw new PasswordChangeRequiredError()
}

export interface AuthorizationResult extends AuthenticatedUser {
  role: Role
  permissions: Record<string, Record<string, boolean>>
}

export interface AuthorizeOptions {
  /** Object the action targets; recorded when access is denied. */
  entityId?: string | ObjectId | null
  ipAddress?: string
  userAgent?: string
  /**
   * Skip the denied-attempt audit write. Only for composite checks that emit
   * their own single audit entry (see `authorizeAllViews`).
   */
  suppressAudit?: boolean
}

/**
 * SPEC §3.1.19 records `ipAddress` and `userAgent` on every audit entry,
 * including denied attempts. Reading them here means each call site stays a
 * one-liner (`await authorize('finance', 'create')`) and cannot forget them.
 */
const resolveMeta = async (
  options: AuthorizeOptions
): Promise<{ ipAddress?: string; userAgent?: string }> => {
  if (options.ipAddress !== undefined && options.userAgent !== undefined) {
    return { ipAddress: options.ipAddress, userAgent: options.userAgent }
  }

  try {
    const h = await headers()
    const forwarded = h.get('x-forwarded-for')
    return {
      ipAddress:
        options.ipAddress ?? forwarded?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? undefined,
      userAgent: options.userAgent ?? h.get('user-agent') ?? undefined,
    }
  } catch {
    // Outside a request scope (e.g. a background job); not fatal.
    return { ipAddress: options.ipAddress, userAgent: options.userAgent }
  }
}

/**
 * SPEC §4.3 asks for an in-memory role cache. A naive cache would let a Founder
 * toggle a permission and have it take effect only after a restart, breaking
 * the "revocable, effective on the next request" requirement.
 *
 * So every role write calls `invalidateRoleCache()` synchronously, which makes
 * revocation immediate for writes made through this app. The short TTL is only
 * a safety net for the multi-instance case (Vercel serverless, SPEC §8.1),
 * where an instance that did not perform the write would otherwise serve a
 * stale matrix until restart.
 */
const ROLE_CACHE_TTL_MS = 2_000

let cachedRoles: Role[] | null = null
let cachedAt = 0

export const invalidateRoleCache = (): void => {
  cachedRoles = null
  cachedAt = 0
}

export const getRoles = async (db?: Db): Promise<Role[]> => {
  const now = Date.now()
  if (cachedRoles && now - cachedAt < ROLE_CACHE_TTL_MS) return cachedRoles

  const database = db ?? (await getDatabase())
  cachedRoles = await withMongoRetry(async () => {
    const database = db ?? (await getDatabase())
    return getRoleCollection(database).find({}).toArray()
  })
  cachedAt = now
  return cachedRoles
}

export const getRole = async (name: string, db?: Db): Promise<Role | null> =>
  (await getRoles(db)).find((role) => role.name === name) ?? null

/**
 * Resolve the caller's role and assert `module.action`.
 *
 * Throws `AuthenticationError` (401) when there is no valid session and
 * `AuthorizationError` (403) when the role lacks the grant. Denials are
 * audited per SPEC §4.3.
 */
export const authorize = async (
  module: PermissionModule,
  action: PermissionAction | string,
  options: AuthorizeOptions = {}
): Promise<AuthorizationResult> => {
  const db = await getDatabase()
  const auth = await getAuthenticatedUser(db)

  if (!auth) throw new AuthenticationError()
  assertPasswordChanged(auth)

  const role = await getRole(auth.user.role, db)
  if (!role) {
    // A user whose role document vanished must never fall through to a
    // permissive default.
    throw new AuthorizationError(module, action, 'Your account has no role assigned')
  }

  if (!hasPermission(role, module, action)) {
    if (!options.suppressAudit) {
      const meta = await resolveMeta(options)
      await recordAuditEntry(db, {
        userId: auth.user._id,
        userEmail: auth.user.email,
        action: 'permission_denied',
        entityType: module,
        entityId: options.entityId ?? null,
        details: `Attempted ${action} on ${module}`,
        newValue: { module, action },
        outcome: 'denied',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
    }
    throw new AuthorizationError(module, action)
  }

  return { ...auth, role, permissions: role.permissions }
}

/** Authentication only, for endpoints that need a caller but no module grant. */
export const requireAuth = async (): Promise<AuthenticatedUser> => {
  const db = await getDatabase()
  const auth = await getAuthenticatedUser(db)
  if (!auth) throw new AuthenticationError()
  return auth
}

/**
 * Founder gate. SPEC §4.3 ("Role assignment can only be modified by Founder")
 * and §10.2.2 Test 6. Deliberately *not* a permission check: no permission
 * grant can open it, only the founder role itself.
 */
export const requireFounder = async (
  options: AuthorizeOptions = {}
): Promise<AuthorizationResult> => {
  const db = await getDatabase()
  const auth = await getAuthenticatedUser(db)

  if (!auth) throw new AuthenticationError()
  assertPasswordChanged(auth)

  if (!isFounderRole(auth.user.role)) {
    const meta = await resolveMeta(options)
    await recordAuditEntry(db, {
      userId: auth.user._id,
      userEmail: auth.user.email,
      action: 'permission_denied',
      entityType: 'founder',
      entityId: options.entityId ?? null,
      details: 'Attempted a Founder-only operation',
      outcome: 'denied',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    throw new AuthorizationError('founder', 'manage', 'Only the Founder can perform this action')
  }

  const role = await getRole(auth.user.role, db)
  return {
    ...auth,
    role: role ?? emptyRole(auth.user.role),
    permissions: role?.permissions ?? {},
  }
}

/**
 * Aggregate endpoints (dashboard, period report) read across several modules.
 *
 * They require *every* underlying view grant rather than just one, so revoking
 * `finance.view` genuinely removes financial figures from the dashboard instead
 * of leaving them visible through the summary route. All four SPEC roles hold
 * all of these today, so this changes nothing until a Founder edits the matrix.
 *
 * The session and role are resolved once and all modules are inspected before
 * anything is thrown. An earlier version looped through `authorize()`, which
 * threw on the first missing grant — the aggregate denial audit below could
 * therefore never run, and SPEC §3.1.19 requires denied attempts to be recorded.
 */
export const authorizeAllViews = async (
  modules: PermissionModule[],
  options: AuthorizeOptions = {}
): Promise<AuthorizationResult> => {
  if (modules.length === 0) throw new AuthorizationError('dashboard', 'view')

  const db = await getDatabase()
  const auth = await getAuthenticatedUser(db)
  if (!auth) throw new AuthenticationError()
  assertPasswordChanged(auth)

  const role = await getRole(auth.user.role, db)
  if (!role) {
    throw new AuthorizationError('dashboard', 'view', 'Your account has no role assigned')
  }

  const missing = modules.filter((module) => !hasPermission(role, module, 'view'))
  if (missing.length === 0) return { ...auth, role, permissions: role.permissions }

  const meta = await resolveMeta(options)
  await recordAuditEntry(db, {
    userId: auth.user._id,
    userEmail: auth.user.email,
    action: 'permission_denied',
    entityType: 'dashboard',
    entityId: options.entityId ?? null,
    details: `Missing view permission for: ${missing.join(', ')}`,
    newValue: { missing },
    outcome: 'denied',
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  })
  throw new AuthorizationError(
    'dashboard',
    'view',
    `Missing view permission for: ${missing.join(', ')}`
  )
}

export interface ViewScopes extends AuthorizationResult {
  /**
   * The subset of the requested modules the caller may view. Every aggregate
   * screen (dashboard, reports) computes ONLY the sections whose module is
   * present here, so a Partner without `finance.view` never has a financial
   * figure assembled or serialized — server-side, not just hidden.
   */
  viewable: PermissionModule[]
}

/**
 * Per-widget authorization for aggregate screens (brief §8).
 *
 * `authorizeAllViews` is all-or-nothing: it is right for a single report that
 * legitimately needs every underlying view, but the dashboard is a mosaic of
 * independent widgets, each owned by one module. This resolves the session and
 * role once, then returns the modules the caller can actually view.
 *
 * Enforcement is still entirely server-side: a 401 with no session, a 403 (with
 * the forced-password rule) otherwise, and a genuine denial — 403 plus an audit
 * entry — when the caller holds NONE of the requested view grants (they are
 * reaching a screen they have no business reading). Partial access is not a
 * denial and is not audited, because the disallowed widgets are simply never
 * computed rather than refused; auditing every absent widget would flood the
 * log with non-events and blur the real denied-attempt signal.
 */
export const resolveViewScopes = async (
  modules: PermissionModule[],
  options: AuthorizeOptions = {}
): Promise<ViewScopes> => {
  if (modules.length === 0) throw new AuthorizationError('dashboard', 'view')

  const db = await getDatabase()
  const auth = await getAuthenticatedUser(db)
  if (!auth) throw new AuthenticationError()
  assertPasswordChanged(auth)

  const role = await getRole(auth.user.role, db)
  if (!role) {
    throw new AuthorizationError('dashboard', 'view', 'Your account has no role assigned')
  }

  const viewable = modules.filter((module) => hasPermission(role, module, 'view'))
  if (viewable.length === 0) {
    const meta = await resolveMeta(options)
    await recordAuditEntry(db, {
      userId: auth.user._id,
      userEmail: auth.user.email,
      action: 'permission_denied',
      entityType: 'dashboard',
      entityId: options.entityId ?? null,
      details: `No view permission for any of: ${modules.join(', ')}`,
      newValue: { requested: modules },
      outcome: 'denied',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    throw new AuthorizationError(
      'dashboard',
      'view',
      'You do not have permission to view any part of this screen'
    )
  }

  return { ...auth, role, permissions: role.permissions, viewable }
}

/**
 * Assert a module permission *and* a scoped grant, as one check.
 *
 * Two SPEC cells are narrower than the permission they sit next to:
 *
 *   - §4.2 Sales Edit / Partner (Hasnat) — "✅ (delivery outcomes/returns)"
 *     while `sales.edit` is also true. Rewriting customer details, pricing or
 *     order contents is therefore *not* implied by `sales.edit`.
 *   - §4.2 Inventory / Partner (Hasnat, Ali) — "❌ (except Lahore stock)",
 *     handled by `canRecordLahoreStock` rather than a scoped key.
 *
 * Call sites previously tried to express this with a suppressed `authorize()`
 * followed by a second `authorize()` call "to force a denial" — which is a no-op
 * whenever the caller already holds the base permission, i.e. exactly when it
 * matters. Use this instead; it records the denial and throws.
 */
export const authorizeScoped = async (
  module: PermissionModule,
  action: PermissionAction | string,
  scopedPermission: string,
  options: AuthorizeOptions = {}
): Promise<AuthorizationResult> => {
  const db = await getDatabase()
  const auth = await getAuthenticatedUser(db)
  if (!auth) throw new AuthenticationError()
  assertPasswordChanged(auth)

  const role = await getRole(auth.user.role, db)
  if (!role) {
    throw new AuthorizationError(module, action, 'Your account has no role assigned')
  }

  if (!hasPermission(role, module, action)) {
    const meta = await resolveMeta(options)
    await recordAuditEntry(db, {
      userId: auth.user._id,
      userEmail: auth.user.email,
      action: 'permission_denied',
      entityType: module,
      entityId: options.entityId ?? null,
      details: `Attempted ${action} on ${module}`,
      newValue: { module, action },
      outcome: 'denied',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    throw new AuthorizationError(module, action)
  }

  if (await hasScopedGrant(auth.user.role, scopedPermission, db)) {
    return { ...auth, role, permissions: role.permissions }
  }

  const meta = await resolveMeta(options)
  await recordAuditEntry(db, {
    userId: auth.user._id,
    userEmail: auth.user.email,
    action: 'permission_denied',
    entityType: module,
    entityId: options.entityId ?? null,
    details: `Attempted ${action} on ${module} without the ${scopedPermission} grant`,
    newValue: { module, action, scopedPermission },
    outcome: 'denied',
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  })
  throw new AuthorizationError(module, action, 'You do not have permission to perform this action')
}

/** Resolves a scoped grant, falling back to the SPEC defaults. */
export const hasScopedGrant = async (
  roleName: string,
  permission: string,
  db?: Db
): Promise<boolean> => {
  const role = await getRole(roleName, db)
  const stored = role?.permissions?.[permission]
  if (stored && typeof stored.create === 'boolean') return stored.create

  if (permission === SCOPED_LAHORE_STOCK_PERMISSION) return LAHORE_STOCK_ROLES[roleName] === true
  if (permission === SCOPED_SALES_FULL_EDIT) return SALES_FULL_EDIT_ROLES[roleName] === true
  return false
}

export const emptyRole = (name: string): Role => ({
  name,
  displayName: name,
  permissions: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
})

export const hasPermission = (
  role: Pick<Role, 'permissions'> | null | undefined,
  module: string,
  action: string
): boolean => {
  if (!role?.permissions) return false
  const modulePermissions = role.permissions[module]
  if (!modulePermissions) return false
  return modulePermissions[action] === true
}

/**
 * SPEC §4.2 Inventory row: "❌ (except Lahore stock)" for Hasnat and Ali.
 *
 * Modelled as its own scoped grant (`inventory.lahore_stock`) rather than by
 * widening `inventory.edit`, so a Founder can revoke the Lahore exception
 * without touching the generic inventory permission, and the generic
 * permission keeps the exact meaning the matrix gives it.
 *
 * The SPEC defaults come from `LAHORE_STOCK_ROLES` until a stored role
 * overrides them.
 */
export const canRecordLahoreStock = async (roleName: string, db?: Db): Promise<boolean> => {
  const role = await getRole(roleName, db)
  if (!role) return LAHORE_STOCK_ROLES[roleName] === true

  const scoped = role.permissions?.[SCOPED_LAHORE_STOCK_PERMISSION]
  if (scoped && typeof scoped.create === 'boolean') return scoped.create

  return LAHORE_STOCK_ROLES[roleName] === true
}

export const LAHORE_LOCATION = 'lahore'

/**
 * Gate for stock writes, used by both `/api/stock` and `/api/stock/transfer`.
 *
 * SPEC §4.2 Inventory: Hasnat and Ali hold `inventory.create` = ❌ but are
 * noted "❌ (except Lahore stock)". Full `inventory.create` authority therefore
 * allows any location, and the scoped `inventory.lahore_stock` grant allows
 * Lahore only.
 *
 * Every location in the request must be covered. The previous version tested
 * `locations.includes('lahore')`, which meant a transfer with legs
 * `lahore → sheikhupura` passed the check and let a Partner adjust Sheikhupura
 * stock — the exception became a general inventory grant. The grant is now
 * honoured only when Lahore is the *only* location being written.
 *
 * The refusal path goes through `authorize`, so it is audited and returns 403.
 */
export const authorizeStockWrite = async (
  locations: string[],
  options: AuthorizeOptions = {}
): Promise<void> => {
  const db = await getDatabase()
  const auth = await getAuthenticatedUser(db)
  if (!auth) throw new AuthenticationError()
  assertPasswordChanged(auth)

  const role = await getRole(auth.user.role, db)
  const requested = [...new Set(locations.map((l) => l.toLowerCase()))]

  if (role && hasPermission(role, 'inventory', 'create')) return

  const onlyLahore =
    requested.length > 0 && requested.every((location) => location === LAHORE_LOCATION)
  if (onlyLahore && (await canRecordLahoreStock(auth.user.role, db))) return

  const meta = await resolveMeta(options)
  await recordAuditEntry(db, {
    userId: auth.user._id,
    userEmail: auth.user.email,
    action: 'permission_denied',
    entityType: 'inventory',
    entityId: options.entityId ?? null,
    details: `Attempted a stock write for: ${requested.join(', ') || 'unknown'}`,
    newValue: { locations: requested },
    outcome: 'denied',
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  })
  throw new AuthorizationError('inventory', 'create')
}
