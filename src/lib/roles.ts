import type { PermissionModule, Role } from '@/lib/models/User'

export type { PermissionModule }

/**
 * SPEC.md Appendix A "Roles (Initial)" and §4.2, transcribed verbatim.
 *
 * These four documents are seeded into the `roles` collection and are the
 * authoritative defaults. They are written as literal data rather than derived
 * from a base role so that editing one partner's grants can never silently
 * shift another's.
 *
 * The partners are intentionally distinct: Hasnat creates/edits sales, Ali is
 * view-only on sales but records Lahore stock, Afnan is view-only outside
 * tasks and chat.
 */
const FULL = {
  view: true,
  create: true,
  edit: true,
  delete: true,
  approve: true,
}

const VIEW_ONLY_WITH_APPROVE_FALSE = {
  view: true,
  create: false,
  edit: false,
  delete: false,
  approve: false,
}

const INVENTORY_VIEW_ONLY = {
  view: true,
  create: false,
  edit: false,
  delete: false,
}

const SALES_VIEW_ONLY = {
  view: true,
  create: false,
  edit: false,
  delete: false,
}

const SALES_CREATE_EDIT = {
  view: true,
  create: true,
  edit: true,
  delete: false,
}

const SALES_FULL_NO_DELETE = {
  view: true,
  create: true,
  edit: true,
  delete: false,
}

/**
 * Phase 6 splits `tasks` from `chat`. Chat stays as before: view/create/edit/
 * delete open to every member. Tasks gain the board-specific actions from
 * SPEC §4.2 (editOthers, deleteOthers, comment, manage).
 */
const CHAT_OPEN = {
  view: true,
  create: true,
  edit: true,
  delete: true,
}

/** Partners by default: full control of their own cards, not others'. */
const TASKS_PARTNER = {
  view: true,
  create: true,
  edit: true,          // edit / move own
  editOthers: false,   // grantable by Founder per role
  delete: true,        // archive own
  deleteOthers: false,
  comment: true,
  manage: false,       // Founder-only, not grantable
}

/** Founder: everything open, sole owner of board and column management. */
const TASKS_FOUNDER = {
  view: true,
  create: true,
  edit: true,
  editOthers: true,
  delete: true,
  deleteOthers: true,
  comment: true,
  manage: true,
}

const SUPPLIERS_VIEW_ONLY = {
  view: true,
  create: false,
  edit: false,
  delete: false,
}

const DENIED = {
  view: false,
  create: false,
  edit: false,
  delete: false,
}

export const ROLE_FOUNDER = 'founder'
export const ROLE_HASNAT = 'partner_hasnat'
export const ROLE_ALI = 'partner_ali'
export const ROLE_AFNAN = 'partner_afnan'

export const SPEC_ROLES: Role[] = [
  {
    name: ROLE_FOUNDER,
    displayName: 'Founder',
    permissions: {
      finance: { ...FULL },
      budget: { ...FULL },
      inventory: { view: true, create: true, edit: true, delete: true },
      sales: { view: true, create: true, edit: true, delete: true },
      tasks: { ...TASKS_FOUNDER },
      chat: { ...CHAT_OPEN },
      suppliers: { view: true, create: true, edit: true, delete: true },
      settings: { view: true, edit: true },
      users: { view: true, create: true, edit: true, delete: true },
    },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  {
    name: ROLE_HASNAT,
    displayName: 'Partner (Hasnat)',
    permissions: {
      finance: { ...VIEW_ONLY_WITH_APPROVE_FALSE },
      budget: { ...VIEW_ONLY_WITH_APPROVE_FALSE },
      // SPEC §4.2: "except Lahore stock" is carried by an explicit scoped grant
      // below rather than by widening the generic inventory permission.
      inventory: { ...INVENTORY_VIEW_ONLY },
      sales: { ...SALES_CREATE_EDIT },
      tasks: { ...TASKS_PARTNER },
      chat: { ...CHAT_OPEN },
      suppliers: { ...SUPPLIERS_VIEW_ONLY },
      settings: { ...DENIED },
      users: { ...DENIED },
    },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  {
    name: ROLE_ALI,
    displayName: 'Partner (Ali)',
    permissions: {
      finance: { ...VIEW_ONLY_WITH_APPROVE_FALSE },
      budget: { ...VIEW_ONLY_WITH_APPROVE_FALSE },
      inventory: { ...INVENTORY_VIEW_ONLY },
      sales: { ...SALES_VIEW_ONLY },
      tasks: { ...TASKS_PARTNER },
      chat: { ...CHAT_OPEN },
      suppliers: { ...SUPPLIERS_VIEW_ONLY },
      settings: { ...DENIED },
      users: { ...DENIED },
    },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  {
    name: ROLE_AFNAN,
    displayName: 'Partner (Afnan)',
    permissions: {
      finance: { ...VIEW_ONLY_WITH_APPROVE_FALSE },
      budget: { ...VIEW_ONLY_WITH_APPROVE_FALSE },
      inventory: { ...INVENTORY_VIEW_ONLY },
      sales: { ...SALES_VIEW_ONLY },
      tasks: { ...TASKS_PARTNER },
      chat: { ...CHAT_OPEN },
      suppliers: { ...SUPPLIERS_VIEW_ONLY },
      settings: { ...DENIED },
      users: { ...DENIED },
    },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
]

/**
 * SPEC §4.2 Inventory row: Hasnat and Ali may "record Lahore stock movements".
 * Modelled as a separate scoped grant so `inventory.edit` keeps its matrix
 * meaning (`❌ except Lahore stock`) and a Founder can toggle the exception
 * without changing the generic permission.
 */
export const SCOPED_LAHORE_STOCK_PERMISSION = 'inventory.lahore_stock'

/**
 * SPEC §4.2 Sales Edit for Partner (Hasnat) reads "✅ (delivery outcomes/
 * returns)" — i.e. *not* order contents, customer details or pricing. Rewriting
 * a pending order is therefore a separate, Founder-by-default grant rather than
 * being folded into `sales.edit`.
 */
export const SCOPED_SALES_FULL_EDIT = 'sales.full_edit'

export const SALES_FULL_EDIT_ROLES: Record<string, boolean> = {
  [ROLE_FOUNDER]: true,
  [ROLE_HASNAT]: false,
  [ROLE_ALI]: false,
  [ROLE_AFNAN]: false,
}

export const LAHORE_STOCK_ROLES: Record<string, boolean> = {
  [ROLE_FOUNDER]: true,
  [ROLE_HASNAT]: true,
  [ROLE_ALI]: true,
  [ROLE_AFNAN]: false,
}

export const ROLE_NAMES = SPEC_ROLES.map((role) => role.name)

export const isFounderRole = (role?: string): boolean => role === ROLE_FOUNDER

/** Assignee picker options for the tasks board. */
export const TEAM_ROLES = SPEC_ROLES.map((role) => ({
  value: role.name,
  label: role.displayName,
}))

export const ASSIGNEE_OPTIONS = [
  { value: '', label: 'Unassigned' },
  ...TEAM_ROLES,
]

export const roleLabel = (role?: string): string | undefined =>
  SPEC_ROLES.find((r) => r.name === role)?.displayName

export const PERMISSION_MODULES: PermissionModule[] = [
  'finance',
  'budget',
  'inventory',
  'sales',
  'tasks',
  'chat',
  'suppliers',
  'settings',
  'users',
]

export const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'approve'] as const

/**
 * Human labels used by the permissions matrix screen.
 *
 * Kept here (not in the component) so the Founder can read the same wording the
 * API enforces, and so tests can assert against one shared vocabulary.
 */
export const MODULE_LABELS: Record<PermissionModule, string> = {
  finance: 'Finance',
  budget: 'Budget',
  inventory: 'Inventory',
  sales: 'Sales',
  tasks: 'Tasks',
  chat: 'Chat',
  suppliers: 'Suppliers',
  settings: 'Settings',
  users: 'Users',
}

export const ACTION_LABELS: Record<string, string> = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  approve: 'Approve',
}