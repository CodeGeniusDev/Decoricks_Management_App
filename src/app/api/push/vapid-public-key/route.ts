import { requireAuth } from '@/lib/authorization'
import { handleRouteError } from '@/lib/http'
import { successResponse } from '@/lib/api-response'
import { getVapidPublicKey } from '@/lib/notifications/push'

/**
 * GET /api/push/vapid-public-key — the client's "is push available?" probe and
 * the key it needs for `PushManager.subscribe` (design §10).
 *
 * Auth-gated so an anonymous scanner cannot even learn whether this deployment
 * has push enabled. When unconfigured it returns `enabled: false, publicKey:
 * null` with a 200 rather than an error — an unavailable feature is a normal
 * state on a free host, and the client then quietly skips the subscribe flow
 * instead of showing a broken permission prompt. Only ever the PUBLIC key; the
 * VAPID private key and subject never leave the server.
 *
 * The returned key is DERIVED FROM THE RUNTIME PRIVATE KEY, not the value baked
 * into the build, so replacing the VAPID pair in Render's env and restarting is
 * enough to keep signing and subscribing on the same pair. Existing browser
 * subscriptions survive a key rotation — the endpoint and the subscriber's own
 * keys do not depend on the sender's key — but the next build should still carry
 * the new public value so the two agree.
 */

export const dynamic = 'force-dynamic'

async function __GET() {
  await requireAuth()
  const publicKey = await getVapidPublicKey()
  return successResponse({ enabled: Boolean(publicKey), publicKey })
}

export const GET = async (): Promise<Response> => {
  try {
    return await __GET()
  } catch (error) {
    return handleRouteError(error)
  }
}
