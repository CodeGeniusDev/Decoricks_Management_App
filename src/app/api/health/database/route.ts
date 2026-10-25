import { NextResponse } from 'next/server'
import { healthCheck } from '@/lib/mongodb'

/**
 * Database readiness — the deep check the liveness probe deliberately omits.
 *
 * This DOES make a MongoDB round trip (`ping`), so it is slow on a cold start and
 * returns 503 when storage is unreachable. That makes it right for an operator
 * asking "is the data layer actually up?" and wrong for the platform health check,
 * which is why `/api/health` does not call it. It stays under the same public
 * prefix (`/api/health/*`) so it needs no session, matching the liveness probe.
 */
export const runtime = 'nodejs'

export async function GET() {
  const result = await healthCheck()
  const healthy = result.status === 'healthy'

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'error',
      database: result.status,
      message: healthy ? 'Database connected' : 'Database unavailable',
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 },
  )
}
