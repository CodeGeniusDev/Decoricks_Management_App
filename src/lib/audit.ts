import { ObjectId } from 'mongodb'
import type { Db } from 'mongodb'
import { getAuditLogCollection, type AuditLogEntry } from '@/lib/models/User'

/**
 * Append-only audit trail.
 *
 * SPEC.md §3.1.19 defines the entry shape; §4.3 additionally requires that
 * permission-*denied* attempts are recorded; §10.2.6 Test 17 requires that no
 * API can update or delete an entry.
 *
 * Test 17 is satisfied structurally: this module exposes an insert-only writer
 * and no update/delete function exists anywhere in the codebase, and the
 * collection is never mounted behind a mutating route.
 */

export interface AuditInput {
  userId?: ObjectId | string | null
  userEmail?: string
  action: string
  entityType: string
  entityId?: ObjectId | string | null
  oldValue?: unknown
  newValue?: unknown
  details?: string
  outcome?: AuditLogEntry['outcome']
  ipAddress?: string
  userAgent?: string
}

export const recordAuditEntry = async (db: Db, input: AuditInput): Promise<void> => {
  const entry: AuditLogEntry = {
    userId: toObjectIdOrNull(input.userId),
    userEmail: input.userEmail,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    oldValue: sanitize(input.oldValue),
    newValue: sanitize(input.newValue),
    details: input.details,
    outcome: input.outcome ?? 'success',
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    createdAt: new Date(),
  }

  await getAuditLogCollection(db).insertOne(entry)
}

export const recordManyAuditEntries = async (db: Db, inputs: AuditInput[]): Promise<void> => {
  if (inputs.length === 0) return
  const now = new Date()
  const entries: AuditLogEntry[] = inputs.map((input) => ({
    userId: toObjectIdOrNull(input.userId),
    userEmail: input.userEmail,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    oldValue: sanitize(input.oldValue),
    newValue: sanitize(input.newValue),
    details: input.details,
    outcome: input.outcome ?? 'success',
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    createdAt: now,
  }))
  await getAuditLogCollection(db).insertMany(entries)
}

const toObjectIdOrNull = (value?: ObjectId | string | null): ObjectId | null => {
  if (!value) return null
  if (value instanceof ObjectId) return value
  return /^[0-9a-fA-F]{24}$/.test(value) ? new ObjectId(value) : null
}

/**
 * Strips secrets before anything is persisted.
 *
 * SPEC §10.2.4 Test 12 requires that no plaintext passwords reach the audit log
 * or server logs. Recursive rather than top-level so a nested `passwordHash`
 * cannot slip through.
 */
const SECRET_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'passwordhash',
  'passwordresetat',
  'csftoken',
  'token',
  'tokenhash',
  'sessionsecret',
  'authorization',
  'cookie',
])

const MAX_DEPTH = 6

const sanitize = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined) return value
  if (depth > MAX_DEPTH) return '[truncated]'
  if (value instanceof Date) return value
  if (value instanceof ObjectId) return value.toString()

  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1))

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.has(key.toLowerCase()) ? '[redacted]' : sanitize(raw, depth + 1)
    }
    return out
  }

  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…`
  if (typeof value === 'bigint') return value.toString()
  return value
}