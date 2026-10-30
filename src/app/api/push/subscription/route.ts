import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { requireAuth } from '@/lib/authorization'
import { HttpError, handleRouteError } from '@/lib/http'
import { successResponse } from '@/lib/api-response'
import { ensurePushIndexes, getPushSubscriptionCollection } from '@/lib/models/PushSubscriptions'

/**
 * /api/push/subscription — store / remove one browser's Web Push endpoint for the
 * caller (design §10). CSRF is enforced by middleware on these verbs, exactly as
 * for every other mutation.
 *
 * PUT   { endpoint, keys: { p256dh, auth } } — upsert. Keyed by `endpoint` (the
 *       unique browser-supplied URL) AND the caller, so re-subscribing from the
 *       same device updates rather than duplicates, one user can hold several
 *       devices, and no account can re-point another account's row.
 *       We store ONLY the endpoint and the two client public keys — never a
 *       token, password or any record data.
 * DELETE { endpoint } — remove, scoped to `{ endpoint, userId }` so a caller can
 *       only unsubscribe their OWN device, never someone else's by guessing an
 *       endpoint. The service worker calls this on logout / unsubscribe.
 */

export const dynamic = 'force-dynamic'

/** Bounds for the three stored strings; a browser mints all of them, so any
 *  oversized value is a crafted request rather than a real subscription. */
const MAX_ENDPOINT_LENGTH = 2048
const MAX_KEY_LENGTH = 512

/**
 * A push endpoint is an https URL the browser's push service minted. Anything
 * else is rejected here because the stored value is not inert: `deliverPush`
 * POSTS to it on every future notification, so a `http://`, a loopback,
 * link-local (the cloud metadata address), a raw IP literal or an intranet-only
 * name would turn this app into a request generator pointed at wherever the
 * caller wanted. No public push provider uses an IP literal or a dotless name,
 * so refusing both costs nothing real.
 *
 * Not covered (and deliberately so): a *domain* that later resolves to an
 * internal address. That needs resolution-time checks, which this route cannot
 * do without shipping DNS behaviour into a free-tier request path.
 */
const isRealPushEndpoint = (raw: string): boolean => {
  if (!raw || raw.length > MAX_ENDPOINT_LENGTH || /\s/.test(raw)) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  // Push services answer on 443. A port here means a hand-built URL.
  if (url.port) return false
  // Credentials in the URL would be sent to the push service on every request.
  if (url.username || url.password) return false
  const host = url.hostname
  if (!host.includes('.')) return false // dotless: `localhost`, `.local`, single labels
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  if (host.startsWith('[')) return false // IPv6 literal (the parser keeps the brackets)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false // IPv4 literal, any range
  return true
}

/** The two client keys are base64 of fixed-size P-256 / auth material. */
const isSubscriptionKey = (raw: string): boolean =>
  Boolean(raw) && raw.length <= MAX_KEY_LENGTH && /^[A-Za-z0-9_-]+={0,2}$/.test(raw)

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
  if (
    !endpoint ||
    !isRealPushEndpoint(endpoint) ||
    !isSubscriptionKey(p256dh) ||
    !isSubscriptionKey(authKey)
  ) {
    throw new HttpError('A valid push subscription is required', 400, 'VALIDATION_ERROR')
  }

  const db = await getDatabase()
  await ensurePushIndexes(db)
  const now = new Date()
  const collection = getPushSubscriptionCollection(db)

  // `endpoint` is globally unique, so an upsert keyed on it alone would let one
  // account re-point another account's row at its own keys: the real device
  // then receives payloads it cannot decrypt and the owner silently stops
  // getting notifications. A browser never hands the same endpoint to two
  // accounts, so an endpoint already owned by someone else is a forged request.
  const owner = await collection.findOne({ endpoint } as never, { projection: { userId: 1 } })
  if (owner && String(owner.userId) !== userId.toString()) {
    throw new HttpError('A valid push subscription is required', 400, 'VALIDATION_ERROR')
  }

  await collection.updateOne(
    { endpoint, userId } as never,
    {
      $set: { keys: { p256dh, auth: authKey }, updatedAt: now },
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
