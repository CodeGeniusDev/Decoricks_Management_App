import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoClient, type Db } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { NextRequest } from 'next/server'
import {
  AuthenticationError,
  AuthorizationError,
  PasswordChangeRequiredError,
  requireFounder,
  resolveViewScopes,
} from '@/lib/authorization'

/**
 * Phase 8 — API route authorization + shape enforcement (brief "API tests").
 *
 * Proves the two aggregate routes behave as the brief demands:
 *   - 401 with no session, 403 when the caller holds none of the grants,
 *     403 PASSWORD_CHANGE_REQUIRED on the forced-password rule (dashboard),
 *   - a Partner WITHOUT a module's view grant never receives that figure —
 *     the block is not in the response at all (enforcement by shape, not hiding),
 *   - the Founder-only reconciliation route rejects a non-Founder,
 *   - an invalid / inverted date range is rejected with 400.
 *
 * The authorization layer and `getDatabase` are the seams. We drive
 * `resolveViewScopes`/`requireFounder` directly and let the REAL composer and
 * reconciler run against an empty in-memory database, so a 200 here is the
 * genuine serialized dashboard shape — we can assert on the actual block keys the
 * client would receive.
 */

// The routes import the whole authorization module; setup.ts mocks parts of it.
// We re-mock to control exactly the two gates the aggregate routes call, keeping
// the error CLASSES real so `handleRouteError`'s `instanceof` checks still fire.
vi.mock('@/lib/authorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/authorization')>()
  return {
    ...actual,
    resolveViewScopes: vi.fn(),
    requireFounder: vi.fn(),
  }
})

// getDatabase is the only DB access on the happy path (the composer/reconciler
// take the injected `db`). A single empty memory database keeps the routes alive
// without seeding anything — empty inputs are the honest zero-activity case.
let server: MongoMemoryServer
let client: MongoClient
let db: Db
const getDatabaseMock = vi.fn<() => Promise<Db>>()

vi.mock('@/lib/mongodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mongodb')>()
  return {
    ...actual,
    getDatabase: () => getDatabaseMock(),
  }
})

const mockedScopes = vi.mocked(resolveViewScopes)
const mockedFounder = vi.mocked(requireFounder)

const { GET: dashboardGet } = await import('@/app/api/dashboard/route')
const { GET: reconciliationGet } = await import('@/app/api/dashboard/reconciliation/route')

const dashboardUrl = (qs = 'period=month') =>
  new NextRequest(`http://localhost/api/dashboard?${qs}`)
const reconciliationUrl = (qs = 'period=month') =>
  new NextRequest(`http://localhost/api/dashboard/reconciliation?${qs}`)

const envelope = async (response: Response) =>
  (await response.json()) as {
    success: boolean
    data?: Record<string, unknown> & { blocks?: Record<string, unknown> }
    error?: { code?: string }
  }

beforeAll(async () => {
  // launchTimeout is raised above the 10s default: when vitest runs the DB
  // suites in parallel, several mongod binaries cold-start at once and the
  // first spin-up can exceed 10s under CPU contention (not a logic failure).
  server = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } })
  client = await MongoClient.connect(server.getUri())
  db = client.db(`phase8_api_${Date.now()}`)
  getDatabaseMock.mockResolvedValue(db)
}, 120_000)

afterAll(async () => {
  await client?.close().catch(() => undefined)
  await server?.stop().catch(() => undefined)
})

describe('GET /api/dashboard — unauthenticated and denied callers', () => {
  it('401 UNAUTHENTICATED when there is no session', async () => {
    mockedScopes.mockRejectedValueOnce(new AuthenticationError())
    const response = await dashboardGet(dashboardUrl())
    expect(response.status).toBe(401)
    expect((await envelope(response)).error?.code).toBe('UNAUTHENTICATED')
  })

  it('403 PASSWORD_CHANGE_REQUIRED when the caller must change their password', async () => {
    mockedScopes.mockRejectedValueOnce(new PasswordChangeRequiredError())
    const response = await dashboardGet(dashboardUrl())
    expect(response.status).toBe(403)
    expect((await envelope(response)).error?.code).toBe('PASSWORD_CHANGE_REQUIRED')
  })

  it('403 FORBIDDEN when the caller holds none of the dashboard grants', async () => {
    mockedScopes.mockRejectedValueOnce(new AuthorizationError('dashboard', 'view'))
    const response = await dashboardGet(dashboardUrl())
    expect(response.status).toBe(403)
    expect((await envelope(response)).error?.code).toBe('FORBIDDEN')
  })
})

describe('GET /api/dashboard — per-widget enforcement by shape', () => {
  it('an inventory-only caller receives the inventory block and NO money block', async () => {
    mockedScopes.mockResolvedValueOnce({ viewable: ['inventory'] } as never)
    const body = await envelope(await dashboardGet(dashboardUrl()))

    expect(body.success).toBe(true)
    const blocks = body.data?.blocks ?? {}
    expect(blocks.inventory).toBeDefined()
    // Restricted figures never entered the response — not hidden, absent.
    expect(blocks.profit).toBeUndefined()
    expect(blocks.expenses).toBeUndefined()
    expect(blocks.cash).toBeUndefined()
    expect(blocks.averages).toBeUndefined()
    expect(blocks.orders).toBeUndefined()
  })

  it('a finance+sales caller receives the profit chain and NO inventory', async () => {
    mockedScopes.mockResolvedValueOnce({ viewable: ['finance', 'sales'] } as never)
    const body = await envelope(await dashboardGet(dashboardUrl()))

    const blocks = body.data?.blocks ?? {}
    expect(blocks.profit).toBeDefined()
    expect(blocks.expenses).toBeDefined()
    expect(blocks.cash).toBeDefined()
    expect(blocks.averages).toBeDefined()
    expect(blocks.orders).toBeDefined()
    expect(blocks.inventory).toBeUndefined()
  })

  it('echoes the granted modules so the client renders exactly these blocks', async () => {
    mockedScopes.mockResolvedValueOnce({ viewable: ['budget', 'tasks'] } as never)
    const body = await envelope(await dashboardGet(dashboardUrl()))
    expect(body.data?.viewable).toEqual(['budget', 'tasks'])
    const blocks = body.data?.blocks ?? {}
    expect(blocks.budget).toBeDefined()
    expect(blocks.tasks).toBeDefined()
    expect(blocks.cash).toBeUndefined()
  })
})

describe('GET /api/dashboard — invalid period', () => {
  it('400 VALIDATION_ERROR when a custom range is inverted', async () => {
    mockedScopes.mockResolvedValueOnce({ viewable: ['finance'] } as never)
    const response = await dashboardGet(dashboardUrl('period=custom&from=2026-09-10&to=2026-09-01'))
    expect(response.status).toBe(400)
    expect((await envelope(response)).error?.code).toBe('VALIDATION_ERROR')
  })

  it('400 VALIDATION_ERROR when a custom range is missing its bounds', async () => {
    mockedScopes.mockResolvedValueOnce({ viewable: ['finance'] } as never)
    const response = await dashboardGet(dashboardUrl('period=custom'))
    expect(response.status).toBe(400)
  })
})

describe('GET /api/dashboard/reconciliation — Founder only', () => {
  it('401 UNAUTHENTICATED when there is no session', async () => {
    mockedFounder.mockRejectedValueOnce(new AuthenticationError())
    const response = await reconciliationGet(reconciliationUrl())
    expect(response.status).toBe(401)
    expect((await envelope(response)).error?.code).toBe('UNAUTHENTICATED')
  })

  it('403 FORBIDDEN when a Partner calls the Founder-only route directly', async () => {
    mockedFounder.mockRejectedValueOnce(
      new AuthorizationError('founder', 'manage', 'Only the Founder can perform this action')
    )
    const response = await reconciliationGet(reconciliationUrl())
    expect(response.status).toBe(403)
    expect((await envelope(response)).error?.code).toBe('FORBIDDEN')
  })

  it('200 with a real reconciliation report for a Founder', async () => {
    mockedFounder.mockResolvedValueOnce({} as never)
    const body = await envelope(await reconciliationGet(reconciliationUrl()))
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data?.checks)).toBe(true)
    expect(typeof body.data?.allPass).toBe('boolean')
  })

  it('400 VALIDATION_ERROR on an invalid reconciliation range', async () => {
    mockedFounder.mockResolvedValueOnce({} as never)
    const response = await reconciliationGet(
      reconciliationUrl('period=custom&from=2026-09-10&to=2026-09-01')
    )
    expect(response.status).toBe(400)
  })
})
