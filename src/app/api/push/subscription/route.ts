import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { requireAuth } from '@/lib/authorization'
import { HttpError, handleRouteError } from '@/lib/http'
import { successResponse } from '@/lib/api-response'
import {
  ensurePushIndexes,
  getPushSubscriptionCollection,
} from '@/lib/models/PushSubscriptions'

/**
 * /api/push/subscription — store / remove one browser's Web Push endpoint for the
 * caller (design §10). CSRF is enforced by middleware on these verbs, exactly as
 * for every other mutation.
 *
 * PUT   { endpoint, keys: { p256dh, auth } } — upsert. Keyed by `endpoint` (the
 *       unique browser-supplied URL), so re-subscribing from the same device
 *       updates rather than duplicates, and one user can hold several devices.
 *       We store ONLY the endpoint and the two client public keys — never a
 *       token, password or any record data.
 * DELETE { endpoint } — remove, scoped to `{ endpoint, userId }` so a caller can
 *       only unsubscribe their OWN device, never someone else's by guessing an
 *       endpoint. The service worker calls this on logout / unsubscribe.
 */

export const dynamic = 'force-dynamic'

async function __PUT(request: NextRequest) {
  const auth = await requireAuth()
  const userId = auth.user._id as ObjectId

  const body = (await request.json().catch(() => null)) as {
    endpoint?: unknown
    keys?: { p256dh?: unknown; auth?: unknown }
  } | null

  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : ''
  const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh.trim() : ''
  const authKey = typeof body?.keys?.auth === 'string' ? body.keys.auth.trim() : ''

  // A push endpoint is an https URL the browser minted; reject anything that is
  // not, so a crafted value cannot be persisted and later sent to.
  if (!endpoint || !/^https?:\/\//.test(endpoint) || !p256dh || !authKey) {
    throw new HttpError('A valid push subscription is required', 400, 'VALIDATION_ERROR')
  }

  const db = await getDatabase()
  await ensurePushIndexes(db)
  const now = new Date()

  await getPushSubscriptionCollection(db).updateOne(
    { endpoint } as never,
    {
      $set: { userId, keys: { p256dh, auth: authKey }, updatedAt: now },
      $setOnInsert: { createdAt: now },
    } as never,
    { upsert: true }
  )

  return successResponse({ stored: true })
}

async function __DELETE(request: NextRequest) {
  const auth = await requireAuth()
  const userId = auth.user._id as ObjectId

  const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : ''
  if (!endpoint) throw new HttpError('`endpoint` is required', 400, 'VALIDATION_ERROR')

  const db = await getDatabase()
  const result = await getPushSubscriptionCollection(db).deleteOne({ endpoint, userId } as never)

  return successResponse({ removed: result.deletedCount > 0 })
}

export const PUT = async (request: NextRequest): Promise<Response> => {
  try {
    return await __PUT(request)
  } catch (error) {
    return handleRouteError(error)
  }
}

export const DELETE = async (request: NextRequest): Promise<Response> => {
  try {
    return await __DELETE(request)
  } catch (error) {
    return handleRouteError(error)
  }
}
