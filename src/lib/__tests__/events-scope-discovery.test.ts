import { ObjectId } from 'mongodb'
import type { Db } from 'mongodb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionModule } from '@/lib/models/User'

/*
 * `discoverViewScopes` — the single authorization resolution behind `/api/events`.
 *
 * The stream used to answer "which modules may this caller see?" with
 * `requireAuth()` plus one `authorize()` per module: six identical session reads
 * in series (472 ms of measured connect time) and a `permission_denied` audit row
 * for every module the caller merely has no widget for. Discovery replaces that,
 * so the properties this file pins are the ones the replacement must not lose:
 *
 *   - an unauthenticated caller is still refused (401, never a stream);
 *   - one session read for any number of modules;
 *   - the module set comes from the real role document, never a default;
 *   - a pending forced password change still sees NO gated module signal, the
 *     same net effect the per-module `authorize()` throws used to have;
 *   - a partial or empty scope is not a denial: no throw, no audit write — the
 *     deliberate difference from `resolveViewScopes`, asserted below.
 *
 * `src/test/setup.ts` replaces the authorization module with permissive mocks, so
 * the real implementation is pulled in with `vi.importActual` and exercised
 * against a stubbed session/driver/audit layer (the driver has no live cluster
 * here, and the session join itself is covered by `session-rolling.test.ts`).
 */

const h = vi.hoisted(() => ({
  auth: null as unknown,
  roles: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  sessionReads: 0,
}))

vi.mock('@/lib/auth/session', () => ({
  getAuthenticatedUser: async () => {
    h.sessionReads += 1
    return h.auth
  },
}))

vi.mock('@/lib/mongodb', () => ({
  getDatabase: async () =>
    ({
      collection: (name: string) => ({
        find: () => ({
          toArray: async () => (name === 'roles' ? h.roles : []),
        }),
      }),
    }) as unknown as Db,
  withMongoRetry: async (operation: () => Promise<unknown>) => operation(),
}))

vi.mock('@/lib/audit', () => ({
  recordAuditEntry: async (entry: Record<string, unknown>) => {
    h.audits.push(entry)
  },
}))

const USER_ID = new ObjectId('507f1f77bcf86cd799439011')

const MODULES: PermissionModule[] = ['tasks', 'chat', 'sales', 'inventory', 'finance']

type AuthorizationModule = typeof import('@/lib/authorization')

let authorization: AuthorizationModule

/** A caller whose role document exists and whose password is already their own. */
const authFor = (role: string, overrides: Record<string, unknown> = {}) => {
  h.auth = {
    user: {
      _id: USER_ID,
      email: 'p@decoricks.com',
      name: 'Partner',
      role,
      isActive: true,
      mustChangePassword: false,
      sessionVersion: 1,
      ...overrides,
    },
    session: { tokenHash: 'h', sessionVersion: 1, csrfToken: 'c', role },
  }
}

const roleWith = (name: string, modules: Record<string, boolean>) => {
  h.roles = [
    {
      name,
      displayName: name,
      permissions: Object.fromEntries(Object.entries(modules).map(([m, v]) => [m, { view: v }])),
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  ]
}

beforeEach(async () => {
  h.auth = null
  h.roles = []
  h.audits = []
  h.sessionReads = 0
  authorization = await vi.importActual<typeof import('@/lib/authorization')>('@/lib/authorization')
  // `getRoles()` memoises for 2s; each case needs to see its own role document.
  authorization.invalidateRoleCache()
})

describe('discoverViewScopes', () => {
  it('refuses a caller with no valid session — the stream is never opened', async () => {
    h.auth = null
    await expect(authorization.discoverViewScopes(MODULES)).rejects.toBeInstanceOf(
      authorization.AuthenticationError
    )
  })

  it('resolves the whole module set with ONE session read', async () => {
    authFor('partner')
    roleWith('partner', { tasks: true, chat: true })

    await authorization.discoverViewScopes(MODULES)

    // Five requested modules, one read. Before this helper the same question cost
    // six (`requireAuth()` + one `authorize()` per module).
    expect(h.sessionReads).toBe(1)
  })

  it('reports only the modules the role document actually grants for view', async () => {
    authFor('partner')
    roleWith('partner', { tasks: true, chat: true, sales: false, inventory: false, finance: false })

    const { viewable } = await authorization.discoverViewScopes(MODULES)

    expect(viewable).toEqual(['tasks', 'chat'])
  })

  it('neither throws nor audits when the caller holds no view grant at all', async () => {
    authFor('partner')
    roleWith('partner', { tasks: false, chat: false, sales: false, inventory: false })

    const discovery = await authorization.discoverViewScopes(MODULES)

    expect(discovery.viewable).toEqual([])
    expect(discovery.userId).toBe(String(USER_ID))
    expect(h.audits).toEqual([])

    // The contrast that makes the difference visible: for a data endpoint the same
    // zero-scope caller IS a denial, audited and thrown. `resolveViewScopes` keeps
    // that contract untouched.
    await expect(authorization.resolveViewScopes(MODULES)).rejects.toBeInstanceOf(
      authorization.AuthorizationError
    )
    expect(h.audits).toHaveLength(1)
  })

  it('withholds every gated module from an account still on a temporary password', async () => {
    // `authorize()` gates on SPEC §10.1.1 before it ever reads the matrix, and the
    // events route caught that per module — so a pending-password tab used to see
    // no module signals at all. Discovery must reproduce that outcome rather than
    // trade a security gate for speed.
    authFor('founder', { mustChangePassword: true })
    roleWith('founder', { tasks: true, chat: true, sales: true, inventory: true, finance: true })

    const discovery = await authorization.discoverViewScopes(MODULES)

    expect(discovery.mustChangePassword).toBe(true)
    expect(discovery.viewable).toEqual([])
    expect(h.audits).toEqual([])
  })

  it('treats a missing role document as no grants, never as a permissive default', async () => {
    authFor('ghost')
    h.roles = []

    const discovery = await authorization.discoverViewScopes(MODULES)

    expect(discovery.viewable).toEqual([])
  })
})
