import { NextRequest } from 'next/server'
import { z } from 'zod'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { requireAuth } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { recordAuditEntry } from '@/lib/audit'
import { successResponse, validationError } from '@/lib/api-response'

/**
 * POST /api/offline/discard — audit marker for a discarded queue entry
 * (design §8.3, device-data policy).
 *
 * The queue itself lives in IndexedDB; the server holds no copy (D2). This
 * route exists ONLY for entries that had already reached the server
 * (`reachedServer`): the client calls it before deleting the local row so the
 * audit log shows a pending create was dropped by the user rather than lost.
 * Entries that never reached the server are removed locally with no call.
 *
 * No writes happen here beyond the audit row — discarding must never touch
 * the ledger, and the idempotency key is recorded so a future mystery row
 * with the same key can be traced back to this discard.
 */

const discardSchema = z.object({
  idempotencyKey: z.string().min(8).max(120),
  operation: z.enum(['create_finance', 'create_budget']),
  reason: z.enum(['discarded-by-user', 'replaced-by-edit']),
  entryCreatedAt: z.string().min(10).max(40),
  deviceId: z.string().max(120).optional(),
})

async function __POST(request: NextRequest) {
  try {
    const parsed = discardSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const auth = await requireAuth()
    const db = await getDatabase()
    const meta = await getRequestMeta()

    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'offline_entry_discarded',
      entityType: parsed.data.operation === 'create_finance' ? 'finance' : 'budget',
      entityId: null,
      newValue: {
        idempotencyKey: parsed.data.idempotencyKey,
        operation: parsed.data.operation,
        reason: parsed.data.reason,
        entryCreatedAt: parsed.data.entryCreatedAt,
        deviceId: parsed.data.deviceId ?? null,
        offline: true,
      },
      details: `Offline queue entry discarded (${parsed.data.reason}, key ${parsed.data.idempotencyKey})`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse({ discarded: true })
  } catch (error) {
    console.error('POST /api/offline/discard failed:', error)
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
