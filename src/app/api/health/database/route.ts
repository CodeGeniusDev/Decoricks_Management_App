import { NextResponse } from 'next/server'
import { healthCheck } from '@/lib/mongodb'
import { getRequestMeta, handleRouteError } from '@/lib/http'
import { requireFounder } from '@/lib/authorization'

/**
 * Database readiness — the deep check the liveness probe deliberately omits,
 * now gated to the Founder.
 *
 * This DOES make a MongoDB round trip (`ping`), so it is slow on a cold start
 * and returns 503 when storage is unreachable. That makes it right for an
 * operator asking "is the data layer actually up?" and wrong for the platform
 * health check, which is why `/api/health` stays public, DB-free and instant.
 *
 * Because it reaches into the storage layer it is now Founder-only: it is a
 * diagnostic, not a public status page. And it leaks nothing — the body carries
 * only a coarse healthy/unreachable verdict and a timestamp. No cluster name,
 * no database name, no server version, no driver detail and no raw error text
 * ever leaves this handler. Any unexpected failure is funnelled through
 * `handleRouteError`, which answers a generic message plus a trace id and keeps
 * the real error in the server log only.
 *
 * The middleware still treats the `/api/health/*` prefix as public (so the
 * platform probe never needs a session); the security boundary here is this
 * route's own `requireFounder` call, enforced on the server.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const meta = await getRequestMeta()
    await requireFounder({ ipAddress: meta.ipAddress, userAgent: meta.userAgent })

    const result = await healthCheck()
    const healthy = result.status === 'healthy'

    // Coarse verdict only. `healthCheck()` returns a generic message that we
    // deliberately do NOT forward, so nothing about the server or the error can
    // ride out in the payload.
    return NextResponse.json(
      {
        status: healthy ? 'ok' : 'error',
        database: healthy ? 'healthy' : 'unreachable',
        timestamp: new Date().toISOString(),
      },
      { status: healthy ? 200 : 503 }
    )
  } catch (error) {
    return handleRouteError(error)
  }
}
