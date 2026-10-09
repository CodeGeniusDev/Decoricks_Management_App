import { Collection, Db } from 'mongodb'
import { ObjectId } from 'mongodb'

/**
 * Role permissions exactly as SPEC.md §4.2 / Appendix A.
 *
 * The three partners deliberately have *different* grants, so roles cannot be
 * collapsed into a single shared "Partner" role:
 *   - Hasnat: creates/edits sales, records delivery outcomes and returns
 *   - Ali:    view-only sales, records Lahore stock movements
 *   - Afnan:  view-only everywhere except tasks/chat
 */
export type PermissionModule =
  | 'finance'
  | 'budget'
  | 'inventory'
  | 'sales'
  | 'tasks'
  | 'chat'
  | 'suppliers'
  | 'settings'
  | 'users'

export type PermissionAction = 'view' | 'create' | 'edit' | 'delete' | 'approve'

export type PermissionSet = Record<string, Record<string, boolean>>

export interface User {
  _id?: ObjectId
  email: string
  /** bcrypt hash. SPEC §10.1.4 Threat 9 mandates bcrypt, cost factor 12. */
  passwordHash: string
  name: string
  role: string // 'founder' | 'partner_hasnat' | 'partner_ali' | 'partner_afnan'
  partnerId?: string
  isActive: boolean
  /**
   * True until the user picks their own password. Set for the seeded Founder,
   * who signs in with the environment-provided bootstrap credential and is
   * redirected straight to the change-password screen.
   */
  mustChangePassword: boolean
  /**
   * Set when a Founder resets a user's password. Cleared on first successful
   * change. Blocks login until changed.
   */
  passwordResetAt?: Date
  createdAt: Date
  updatedAt: Date
  lastLoginAt?: Date
  /** Bumped on deactivate/reactivate/reset so live sessions can be revoked. */
  sessionVersion: number
}

export interface Role {
  _id?: ObjectId
  name: string
  displayName: string
  permissions: PermissionSet
  createdAt: Date
  updatedAt: Date
}

/**
 * Server-side session record. The cookie only carries the opaque `token`;
 * everything else stays in MongoDB so a session can be revoked server-side
 * (SPEC §10.1.2 Threat 4) rather than trusting client state.
 */
export interface Session {
  _id?: ObjectId
  tokenHash: string
  userId: ObjectId
  /** Snapshot of the user's `sessionVersion` at issue time. */
  sessionVersion: number
  role: string
  csrfToken: string
  createdAt: Date
  lastActivityAt: Date
  expiresAt: Date
  ipAddress?: string
  userAgent?: string
}

/**
 * Failed-login tracking that drives the 5-attempts / 15-minute lockout
 * (SPEC §10.2.1 Test 2).
 */
export interface LoginAttempt {
  _id?: ObjectId
  /** Lowercased email, or the raw identifier when no account matched. */
  identifier: string
  successful: boolean
  ipAddress?: string
  userAgent?: string
  createdAt: Date
}

/**
 * Append-only audit trail. SPEC §3.1.19 field names, plus `outcome` so a
 * failed login / denied permission is recorded with the same shape as a
 * successful mutation.
 */
export interface AuditLogEntry {
  _id?: ObjectId
  userId: ObjectId | null
  /** null for pre-auth events (failed login on unknown account). */
  userEmail?: string
  action: string
  entityType: string
  entityId?: ObjectId | string | null
  oldValue?: unknown
  newValue?: unknown
  details?: string
  outcome: 'success' | 'denied' | 'failure'
  ipAddress?: string
  userAgent?: string
  createdAt: Date
}

export const getUserCollection = (db: Db): Collection<User> => {
  return db.collection<User>('users')
}

export const getRoleCollection = (db: Db): Collection<Role> => {
  return db.collection<Role>('roles')
}

export const getSessionCollection = (db: Db): Collection<Session> => {
  return db.collection<Session>('sessions')
}

export const getLoginAttemptCollection = (db: Db): Collection<LoginAttempt> => {
  return db.collection<LoginAttempt>('loginAttempts')
}

export const getAuditLogCollection = (db: Db): Collection<AuditLogEntry> => {
  return db.collection<AuditLogEntry>('auditLog')
}

/**
 * Indexes declared by SPEC.md §3.1. Created lazily so a fresh database is
 * usable without a migration step.
 */
export const ensureAuthIndexes = async (db: Db): Promise<void> => {
  await Promise.all([
    // SPEC §3.1.1
    getUserCollection(db).createIndex({ email: 1 }, { unique: true, name: 'users_email_unique' }),
    getUserCollection(db).createIndex({ isActive: 1 }, { name: 'users_isActive' }),

    // SPEC §3.1.2
    getRoleCollection(db).createIndex({ name: 1 }, { unique: true, name: 'roles_name_unique' }),

    getSessionCollection(db).createIndex({ tokenHash: 1 }, { unique: true, name: 'sessions_tokenHash' }),
    getSessionCollection(db).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'sessions_ttl' }),
    getSessionCollection(db).createIndex({ userId: 1 }, { name: 'sessions_userId' }),

    getLoginAttemptCollection(db).createIndex({ identifier: 1, createdAt: -1 }, { name: 'loginAttempts_lookup' }),

    // SPEC §3.1.19
    getAuditLogCollection(db).createIndex({ userId: 1 }, { name: 'audit_userId' }),
    getAuditLogCollection(db).createIndex({ action: 1 }, { name: 'audit_action' }),
    getAuditLogCollection(db).createIndex({ entityType: 1, entityId: 1 }, { name: 'audit_entity' }),
    getAuditLogCollection(db).createIndex({ createdAt: -1 }, { name: 'audit_createdAt' }),
  ])
}

export const requiresPasswordChange = (user: Pick<User, 'mustChangePassword' | 'passwordResetAt'>): boolean =>
  user.mustChangePassword === true || Boolean(user.passwordResetAt)

export const userToJSON = (user: User) => {
  return {
    _id: user._id?.toString(),
    email: user.email,
    name: user.name,
    role: user.role,
    partnerId: user.partnerId,
    isActive: user.isActive,
    mustChangePassword: requiresPasswordChange(user),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  }
}

export const isValidObjectId = (id: string): boolean => {
  return /^[0-9a-fA-F]{24}$/.test(id)
}