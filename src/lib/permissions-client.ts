import type { PermissionSet } from '@/lib/models/User'
import {
  LAHORE_STOCK_ROLES,
  PERMISSION_MODULES,
  ROLE_NAMES,
  SALES_FULL_EDIT_ROLES,
  SCOPED_LAHORE_STOCK_PERMISSION,
  SCOPED_SALES_FULL_EDIT,
  isFounderRole,
  type PermissionModule,
} from '@/lib/roles'

/**
 * Client-side permission check.
 *
 * ⚠️ This is a *display* helper only — it decides what to show, never what to
 * allow. SPEC §4.3 and §10.1.2 Threat 4 are explicit that permissions are
 * enforced on the server, and hiding a nav item is not a security control. Every
 * route the user could reach by typing the URL is still checked server-side.
 *
 * It exists so a Partner who cannot manage users does not see a Users screen
 * that would only ever 403.
 *
 * The arguments are `(role, module, action)` rather than a fetched role
 * document so nav rendering needs no extra fetch on every page load. Where a
 * stored role has been customised, pass its `permissions` to stay accurate.
 */

export interface NavPermissionSource {
  role: string
  permissions?: PermissionSet
}

export const can = (
  source: NavPermissionSource,
  module: string,
  action: string
): boolean => {
  // The Founder is the root of the trust model and always passes.
  if (isFounderRole(source.role)) return true

  if (source.permissions) {
    const modulePermissions = source.permissions[module]
    if (!modulePermissions) return false
    return modulePermissions[action] === true
  }

  // Fall back to the SPEC defaults when no stored matrix was supplied.
  return SPEC_DEFAULT_MATRIX[source.role]?.[module]?.[action] === true
}

/** SPEC Appendix A, flattened for direct lookup. */
const SPEC_DEFAULT_MATRIX: Record<string, Record<string, Record<string, boolean>>> =
  Object.fromEntries(
    ROLE_NAMES.map((role) => [
      role,
      role === 'founder'
        ? Object.fromEntries(
            PERMISSION_MODULES.map((module) => [
              module,
              {
                view: true,
                create: true,
                edit: true,
                delete: true,
                approve: true,
              },
            ])
          )
        : role === 'partner_hasnat'
          ? {
              finance: { view: true, create: false, edit: false, delete: false, approve: false },
              budget: { view: true, create: false, edit: false, delete: false, approve: false },
              inventory: { view: true, create: false, edit: false, delete: false },
              sales: { view: true, create: true, edit: true, delete: false },
              tasks: { view: true, create: true, edit: true, delete: true },
              chat: { view: true, create: true, edit: true, delete: true },
              suppliers: { view: true, create: false, edit: false, delete: false },
              settings: { view: false, create: false, edit: false, delete: false },
              users: { view: false, create: false, edit: false, delete: false },
            }
          : {
              finance: { view: true, create: false, edit: false, delete: false, approve: false },
              budget: { view: true, create: false, edit: false, delete: false, approve: false },
              inventory: { view: true, create: false, edit: false, delete: false },
              sales: { view: true, create: false, edit: false, delete: false },
              tasks: { view: true, create: true, edit: true, delete: true },
              chat: { view: true, create: true, edit: true, delete: true },
              suppliers: { view: true, create: false, edit: false, delete: false },
              settings: { view: false, create: false, edit: false, delete: false },
              users: { view: false, create: false, edit: false, delete: false },
            },
    ])
  )

/**
 * Route → module/action pairs guarding it. Drives nav visibility for screens
 * that have no dedicated settings sub-page.
 */
export const ROUTE_PERMISSIONS: Record<string, { module: PermissionModule; action: string }[]> = {
  '/': [
    { module: 'finance', action: 'view' },
    { module: 'inventory', action: 'view' },
    { module: 'sales', action: 'view' },
    { module: 'tasks', action: 'view' },
  ],
  '/finance': [{ module: 'finance', action: 'view' }],
  '/budgets': [{ module: 'budget', action: 'view' }],
  '/inventory': [{ module: 'inventory', action: 'view' }],
  '/sales': [{ module: 'sales', action: 'view' }],
  '/tasks': [{ module: 'tasks', action: 'view' }],
  '/chat': [{ module: 'chat', action: 'view' }],
  '/suppliers': [{ module: 'suppliers', action: 'view' }],
  '/weekly-summary': [{ module: 'finance', action: 'view' }],
  // SPEC §4.2 Settings and Users rows are Founder-only.
  '/settings': [{ module: 'settings', action: 'view' }],
}

/** Every check for a route must pass. */
export const canAccessRoute = (
  source: NavPermissionSource,
  pathname: string
): boolean => {
  const requirements = ROUTE_PERMISSIONS[normaliseRoute(pathname)]
  if (!requirements) return true // no declared requirement, e.g. /profile
  return requirements.every((req) => can(source, req.module, req.action))
}

const normaliseRoute = (pathname: string): string => {
  if (pathname === '/') return '/'
  const withoutQuery = pathname.split('?')[0].replace(/\/+$/, '')
  return withoutQuery || '/'
}

export const isFounder = (role?: string): boolean => isFounderRole(role)

/** Re-exported so the settings screens show the same scoped grants the API checks. */
export { LAHORE_STOCK_ROLES, SALES_FULL_EDIT_ROLES, SCOPED_LAHORE_STOCK_PERMISSION, SCOPED_SALES_FULL_EDIT }