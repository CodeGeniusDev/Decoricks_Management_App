import type { PermissionSet } from '@/lib/models/User';
import {
  LAHORE_STOCK_ROLES,
  PERMISSION_MODULES,
  ROLE_NAMES,
  SALES_FULL_EDIT_ROLES,
  SCOPED_LAHORE_STOCK_PERMISSION,
  SCOPED_SALES_FULL_EDIT,
  isFounderRole,
  type PermissionModule,
} from '@/lib/roles';

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
  role: string;
  permissions?: PermissionSet;
}

export const can = (source: NavPermissionSource, module: string, action: string): boolean => {
  // The Founder is the root of the trust model and always passes.
  if (isFounderRole(source.role)) return true;

  if (source.permissions) {
    const modulePermissions = source.permissions[module];
    if (!modulePermissions) return false;
    return modulePermissions[action] === true;
  }

  // Fall back to the SPEC defaults when no stored matrix was supplied.
  return SPEC_DEFAULT_MATRIX[source.role]?.[module]?.[action] === true;
};

/** SPEC Appendix A, flattened for direct lookup. */
const SPEC_DEFAULT_MATRIX: Record<
  string,
  Record<string, Record<string, boolean>>
> = Object.fromEntries(
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
);

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
  '/finance/transactions': [{ module: 'finance', action: 'view' }],
  '/finance/accounts': [{ module: 'finance', action: 'view' }],
  '/finance/categories': [{ module: 'finance', action: 'view' }],
  '/budgets': [{ module: 'budget', action: 'view' }],
  // Phase 4 report screens are finance views — all roles read the numbers.
  '/profit-loss': [{ module: 'finance', action: 'view' }],
  '/cash-flow': [{ module: 'finance', action: 'view' }],
  '/distributions': [{ module: 'finance', action: 'view' }],
  '/inventory': [{ module: 'inventory', action: 'view' }],
  '/inventory/products': [{ module: 'inventory', action: 'view' }],
  '/inventory/movements': [{ module: 'inventory', action: 'view' }],
  '/inventory/purchases': [{ module: 'inventory', action: 'view' }],
  '/sales': [{ module: 'sales', action: 'view' }],
  '/sales/returns': [{ module: 'sales', action: 'view' }],
  '/tasks': [{ module: 'tasks', action: 'view' }],
  '/chat': [{ module: 'chat', action: 'view' }],
  '/suppliers': [{ module: 'suppliers', action: 'view' }],
  '/weekly-summary': [{ module: 'finance', action: 'view' }],
  // SPEC §4.2 Settings and Users rows are Founder-only.
  '/settings': [{ module: 'settings', action: 'view' }],
};

/**
 * Routes gated on the Founder ROLE rather than any module grant (brief §8 —
 * only the Founder sees reconciliation). There is no permission module that
 * models this, so `can()` cannot express it; the check is `isFounderRole`.
 * The server still enforces it with `requireFounder` (a role check, not a
 * grant) — hiding the nav item is a convenience, never the control.
 */
export const FOUNDER_ONLY_ROUTES = new Set<string>(['/reconciliation']);

/** Every check for a route must pass. */
export const canAccessRoute = (source: NavPermissionSource, pathname: string): boolean => {
  const route = normaliseRoute(pathname)
  // Founder-only screens are decided by the role, before any module lookup.
  if (FOUNDER_ONLY_ROUTES.has(route)) return isFounderRole(source.role);
  // Detail routes inherit their section's guard via the longest registered
  // prefix: /budgets/<id> is treated as /budgets, /distributions/<id> as
  // /distributions. Routes with no match at all (e.g. /profile) stay open —
  // this is nav display logic, enforcement is server-side anyway.
  const requirements =
    ROUTE_PERMISSIONS[route] ??
    Object.entries(ROUTE_PERMISSIONS)
      .filter(([prefix]) => prefix !== '/' && route.startsWith(`${prefix}/`))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
  if (!requirements) return true; // no declared requirement, e.g. /profile
  return requirements.every((req) => can(source, req.module, req.action));
};

const normaliseRoute = (pathname: string): string => {
  if (pathname === '/') return '/';
  const withoutQuery = pathname.split('?')[0].replace(/\/+$/, '');
  return withoutQuery || '/';
};

export const isFounder = (role?: string): boolean => isFounderRole(role);

/**
 * Display-only mirror of the server's `authorizeStockWrite`
 * (`src/lib/authorization.ts`), which is the authority on this question.
 *
 * SPEC §4.2 marks Hasnat and Ali "❌ (except Lahore stock)" on inventory. Full
 * `inventory.create` covers every location; the scoped `inventory.lahore_stock`
 * grant covers Lahore *alone*, so a transfer with a Sheikhupura leg is hidden
 * from a Lahore-only Partner exactly as it is refused by the API.
 */
export const canWriteStockLocation = (
  source: NavPermissionSource,
  location: string
): boolean => {
  if (isFounderRole(source.role)) return true;
  if (can(source, 'inventory', 'create')) return true;
  if (location.toLowerCase() !== 'lahore') return false;

  const scoped = source.permissions?.[SCOPED_LAHORE_STOCK_PERMISSION];
  if (scoped && typeof scoped.create === 'boolean') return scoped.create;
  return LAHORE_STOCK_ROLES[source.role] === true;
};

/**
 * Display-only mirror of the `sales.full_edit` grant that guards editing an
 * order's contents before dispatch. `sales.edit` alone only moves lifecycle /
 * COD state, so the order form is opened by a different button.
 */
export const canFullEditOrder = (source: NavPermissionSource): boolean => {
  if (isFounderRole(source.role)) return true;
  const scoped = source.permissions?.[SCOPED_SALES_FULL_EDIT];
  if (scoped && typeof scoped.create === 'boolean') return scoped.create;
  return SALES_FULL_EDIT_ROLES[source.role] === true;
};

/** Re-exported so the settings screens show the same scoped grants the API checks. */
export {
  LAHORE_STOCK_ROLES,
  SALES_FULL_EDIT_ROLES,
  SCOPED_LAHORE_STOCK_PERMISSION,
  SCOPED_SALES_FULL_EDIT,
};
