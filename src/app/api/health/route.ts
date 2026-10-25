import { NextResponse } from 'next/server'

/**
 * Liveness probe — deliberately NO database round trip.
 *
 * Render (and any platform health check) polls this to decide whether the
 * instance is healthy enough to route traffic. A cold start has to answer
 * quickly, before the first Mongo connection has even been attempted: a `ping`
 * here could sit behind a slow first handshake (`minPoolSize` warm-up, Atlas
 * TLS negotiation ~300-400ms measured in Phase 4) and get the instance marked
 * unhealthy for a reason that has nothing to do with it being down.
 *
 * So this only proves the Node process is up and serving HTTP. The database
 * round trip lives behind `/api/health/database` for operators and on-demand
 * checks that actually want the storage signal.
 */
export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      // Wall-clock uptime of the process, in whole seconds. A fresh cold start
      // reports a small number; it is a liveness signal, not a readiness one.
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
    { status: 200 },
  )
}
