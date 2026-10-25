/**
 * /api/health/database — Founder-only readiness probe.
 *
 * Guards the two invariants the hardening asks for:
 *   1. the endpoint refuses anyone who is not the Founder (401 anonymous,
 *      403 a signed-in non-Founder), and
 *   2. the success payload leaks nothing — no cluster name, no database name,
 *      no server version, no error detail. `healthCheck()` is deliberately
 *      mocked to return a message that WOULD be a leak, to prove the handler
 *      never forwards it.
 *
 * Harness: `@/lib/mongodb` is mocked here (only `healthCheck` is used); the
 * global setup already mocks `@/lib/authorization` to a permissive Founder and
 * stubs `getRequestMeta`, so each test flips `requireFounder` for the denial
 * paths. `handleRouteError` stays real so statuses match production.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { requireFounder, AuthenticationError, AuthorizationError } from '@/lib/authorization'

vi.mock('@/lib/mongodb', () => ({
  healthCheck: vi.fn(),
}))

import { healthCheck } from '@/lib/mongodb'
import * as databaseRoute from '@/app/api/health/database/route'

const healthy = () => vi.mocked(healthCheck).mockResolvedValue({ status: 'healthy', message: 'ok' })

beforeEach(() => {
  vi.clearAllMocks()
  healthy()
})

describe('/api/health/database is Founder-only', () => {
  it('answers 200 for the Founder when the database is reachable', async () => {
    const res = await databaseRoute.GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.database).toBe('healthy')
  })

  it('answers 503 for the Founder when the database is unreachable', async () => {
    vi.mocked(healthCheck).mockResolvedValue({ status: 'unhealthy', message: 'down' })
    const res = await databaseRoute.GET()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('error')
    expect(body.database).toBe('unreachable')
  })

  it('returns 401 for an anonymous caller', async () => {
    vi.mocked(requireFounder).mockRejectedValueOnce(new AuthenticationError())
    const res = await databaseRoute.GET()
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('UNAUTHENTICATED')
  })

  it('returns 403 for a signed-in non-Founder', async () => {
    vi.mocked(requireFounder).mockRejectedValueOnce(
      new AuthorizationError('founder', 'manage', 'Only the Founder can perform this action')
    )
    const res = await databaseRoute.GET()
    expect(res.status).toBe(403)
    expect((await res.json()).success).toBe(false)
  })
})

describe('/api/health/database leaks nothing', () => {
  it('exposes only status, database and timestamp — no message/version field', async () => {
    // If the handler ever forwarded healthCheck().message, this would surface it.
    vi.mocked(healthCheck).mockResolvedValue({
      status: 'healthy',
      message: 'mongodb+srv://cluster0-abcd user=admin dbName=decoricks_prod v7.0',
    })
    const body = await (await databaseRoute.GET()).json()
    expect(Object.keys(body).sort()).toEqual(['database', 'status', 'timestamp'])
    const raw = JSON.stringify(body)
    for (const needle of ['cluster0', 'admin', 'decoricks_prod', 'v7.0', 'mongodb', 'message']) {
      expect(raw.toLowerCase(), `payload leaked ${needle}`).not.toContain(needle.toLowerCase())
    }
  })

  it('never forwards the healthCheck message on the unhealthy path either', async () => {
    vi.mocked(healthCheck).mockResolvedValue({
      status: 'unhealthy',
      message: 'getaddrinfo ENOTFOUND cluster0.mongodb.net',
    })
    const raw = JSON.stringify(await (await databaseRoute.GET()).json())
    expect(raw.toLowerCase()).not.toContain('enotfound')
    expect(raw.toLowerCase()).not.toContain('cluster0')
  })
})
