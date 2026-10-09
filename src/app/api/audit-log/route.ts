import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getAuditLogCollection, type AuditLogEntry } from '@/lib/models/User'
import { successResponse, errorResponse } from '@/lib/api-response'
import { getRequestMeta, handleRouteError } from '@/lib/http'
import { requireFounder } from '@/lib/authorization'

export const dynamic = 'force-dynamic'

/**
 * Founder-only audit log viewer with search, filters and pagination.
 *
 * SPEC §2.2 puts this under Settings, §10.2.6 Test 17 requires that entries can
 * be neither updated nor deleted, and §3.1.19 defines the indexes that make
 * these queries cheap. There is intentionally **no** PUT/PATCH/DELETE handler
 * here — that absence is what makes the log append-only from the API's point of
 * view.
 */

const PAGE_SIZE_LIMIT = 100 // SPEC §10.1.5 Threat 11

export async function GET(request: NextRequest) {
  try {
    const meta = await getRequestMeta()
    await requireFounder({ ipAddress: meta.ipAddress, userAgent: meta.userAgent })

    const { searchParams } = new URL(request.url)

    // `limit=10000` must not become an unbounded scan (SPEC §10.2.5 Test 14).
    const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1)
    const rawLimit = Number.parseInt(searchParams.get('limit') ?? '25', 10) || 25
    const limit = Math.min(Math.max(1, rawLimit), PAGE_SIZE_LIMIT)

    const action = searchParams.get('action')?.trim()
    const entityType = searchParams.get('entityType')?.trim()
    const outcome = searchParams.get('outcome')?.trim()
    const userId = searchParams.get('userId')?.trim()
    const from = searchParams.get('from')?.trim()
    const to = searchParams.get('to')?.trim()
    const search = searchParams.get('search')?.trim()

    const filter: Record<string, unknown> = {}

    if (action) filter.action = action
    if (entityType) filter.entityType = entityType
    if (outcome) filter.outcome = outcome
    if (userId && ObjectId.isValid(userId)) filter.userId = new ObjectId(userId)

    if (from || to) {
      const range: Record<string, Date> = {}
      if (from && !Number.isNaN(Date.parse(from))) range.$gte = new Date(from)
      if (to && !Number.isNaN(Date.parse(to))) range.$lte = new Date(to)
      if (Object.keys(range).length > 0) filter.createdAt = range
    }

    if (search) {
      // Escaped before use: SPEC §10.2.3 Test 7 (NoSQL injection).
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      filter.$or = [
        { details: { $regex: safe, $options: 'i' } },
        { action: { $regex: safe, $options: 'i' } },
        { userEmail: { $regex: safe, $options: 'i' } },
      ]
    }

    const db = await getDatabase()
    const col = getAuditLogCollection(db)

    const [entries, total, distinctActions, distinctEntities] = await Promise.all([
      col
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      col.countDocuments(filter),
      col.distinct('action'),
      col.distinct('entityType'),
    ])

    return successResponse({
      entries: entries.map(toJSON),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNext: page * limit < total,
        hasPrevious: page > 1,
      },
      filters: {
        actions: (distinctActions as string[]).filter(Boolean).sort(),
        entityTypes: (distinctEntities as string[]).filter(Boolean).sort(),
      },
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

const toJSON = (entry: AuditLogEntry) => ({
  _id: entry._id?.toString(),
  userId: entry.userId?.toString() ?? null,
  userEmail: entry.userEmail,
  action: entry.action,
  entityType: entry.entityType,
  entityId: entry.entityId?.toString() ?? null,
  oldValue: entry.oldValue,
  newValue: entry.newValue,
  details: entry.details,
  outcome: entry.outcome,
  ipAddress: entry.ipAddress,
  createdAt: entry.createdAt,
})

/**
 * Explicit 405s. Not strictly required (a missing export already 405s in Next),
 * but they make the append-only guarantee legible and give the client a clear
 * body instead of a framework error.
 */
const methodNotAllowed = () => errorResponse('Audit log entries are append-only', 405, 'METHOD_NOT_ALLOWED')

export const PUT = methodNotAllowed
export const PATCH = methodNotAllowed
export const DELETE = methodNotAllowed