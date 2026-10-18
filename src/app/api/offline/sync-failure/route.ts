import { NextRequest } from 'next/server'
import { z } from 'zod'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth } from '@/lib/http'
import { requireAuth } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { successResponse, validationError } from '@/lib/api-response'
import { notifySyncFailure } from '@/lib/notifications/events'

/**
 * POST /api/offline/sync-failure — turn an exhausted retry budget into a
 * persistent, owner-visible notification (design §6.3).
 *
 * The client fires this once, when a queue entry crosses to permanent
 * `failed` (5 attempts used up or a 400 validation rejection it cannot
 * auto-retry). The notification lives server-side in the user's inbox, so it
 * survives a browser wipe and shows on any device the user signs in from.
 * `notifySyncFailure` dedupes on the idempotency key, so repeat calls for the
 * same entry (double tab, re-tried drain) create exactly one alert.
 */

const failureSchema = z.object({
  idempotencyKey: z.string().min(8).max(120),
  reason: z.string().min(1).max(500),
})

async function __POST(request: NextRequest) {
  try {
    const parsed = failureSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const auth = await requireAuth()
    const db = await getDatabase()

    const emitted = await notifySyncFailure(db, {
      userId: (auth.user._id as ObjectId).toString(),
      idempotencyKey: parsed.data.idempotencyKey,
      reason: parsed.data.reason,
    })

    return successResponse({ queued: emitted > 0, deduped: emitted === 0 })
  } catch (error) {
    console.error('POST /api/offline/sync-failure failed:', error)
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
