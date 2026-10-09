import { beforeAll, afterAll, vi } from 'vitest'

/*
 * Global test wiring.
 *
 * The route unit tests exercise handler logic against mock collections. Those
 * handlers now call the authorization layer, which resolves identity from
 * Next's request-scoped `cookies()`/`headers()` — APIs that throw outside a
 * request scope. Rather than make every suite re-implement a session, the auth
 * layer is mocked here to a permissive Founder and the request metadata is
 * stubbed. Individual suites can still override a check (for example
 * `vi.mocked(authorize).mockRejectedValueOnce(new AuthenticationError())`) to
 * assert a 401/403 path.
 *
 * The real error classes and the pure helpers (`hasPermission`,
 * `hasScopedGrant`) are kept intact so `handleRouteError`'s `instanceof` checks
 * and any pure-matrix assertions behave exactly as they do in production.
 */

// Mock environment variables for tests
process.env.MONGODB_URI = 'mongodb://localhost:27017/test'
process.env.SESSION_SECRET = 'test-session-secret-0123456789'
process.env.NEXTAUTH_SECRET = 'test-secret'
process.env.NEXTAUTH_URL = 'http://localhost:3000'

vi.mock('@/lib/authorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/authorization')>()
  const { ObjectId } = await import('mongodb')

  const makeAuth = () => ({
    user: {
      _id: new ObjectId('507f1f77bcf86cd799439011'),
      email: 'founder@decoricks.com',
      name: 'Test Founder',
      role: 'founder',
      isActive: true,
      mustChangePassword: false,
      sessionVersion: 1,
    },
    session: {
      tokenHash: 'test-token-hash',
      sessionVersion: 1,
      csrfToken: 'test-csrf-token',
      role: 'founder',
    },
    role: {
      name: 'founder',
      displayName: 'Founder',
      permissions: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    permissions: {},
  })

  return {
    ...actual,
    authorize: vi.fn(async () => makeAuth()),
    requireAuth: vi.fn(async () => makeAuth()),
    requireFounder: vi.fn(async () => makeAuth()),
    authorizeScoped: vi.fn(async () => makeAuth()),
    authorizeAllViews: vi.fn(async () => makeAuth()),
    authorizeStockWrite: vi.fn(async () => undefined),
  }
})

vi.mock('@/lib/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/http')>()
  return {
    ...actual,
    // Real `handleRouteError`/`withAuth` are preserved; only the header lookup
    // (which needs a request scope) is neutralised.
    getRequestMeta: vi.fn(async () => ({ ipAddress: undefined, userAgent: undefined })),
  }
})

// Setup before all tests
beforeAll(() => {
  console.log('Test setup complete')
})

// Cleanup after all tests
afterAll(() => {
  console.log('Test cleanup complete')
})
