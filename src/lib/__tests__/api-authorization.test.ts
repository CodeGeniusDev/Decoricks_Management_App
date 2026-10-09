import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import {
  AuthenticationError,
  AuthorizationError,
  PasswordChangeRequiredError,
  authorize,
  requireFounder,
} from '@/lib/authorization'

import { GET as listUsers, POST as createUser } from '@/app/api/users/route'
import { GET as listRoles } from '@/app/api/roles/route'
import {
  DELETE as auditDelete,
  GET as auditGet,
  PATCH as auditPatch,
  PUT as auditPut,
} from '@/app/api/audit-log/route'

/**
 * Route-level enforcement. `authorization` is globally mocked permissively in
 * `src/test/setup.ts`; here we make it reject to prove the handlers map the
 * failure to the right HTTP status and never fall through to data access.
 */

const mockedAuthorize = vi.mocked(authorize)
const mockedRequireFounder = vi.mocked(requireFounder)

const readJson = async (response: Response) => (await response.json()) as Record<string, never> & {
  success: boolean
  error?: { code?: string }
}

beforeEach(() => {
  mockedAuthorize.mockClear()
  mockedRequireFounder.mockClear()
})

describe('401 when there is no session', () => {
  it('rejects an unauthenticated create-user POST', async () => {
    mockedRequireFounder.mockRejectedValueOnce(new AuthenticationError())
    const response = await createUser(
      new Request('http://localhost/api/users', { method: 'POST', body: '{}' })
    )
    expect(response.status).toBe(401)
    expect((await readJson(response)).error?.code).toBe('UNAUTHENTICATED')
  })

  it('rejects an unauthenticated user list GET', async () => {
    mockedAuthorize.mockRejectedValueOnce(new AuthenticationError())
    const response = await listUsers()
    expect(response.status).toBe(401)
  })
})

describe('403 when the permission is missing', () => {
  it('rejects a Partner calling /api/users directly', async () => {
    mockedAuthorize.mockRejectedValueOnce(new AuthorizationError('users', 'view'))
    const response = await listUsers()
    const body = await readJson(response)
    expect(response.status).toBe(403)
    expect(body.error?.code).toBe('FORBIDDEN')
  })

  it('rejects a Partner reading the role matrix directly', async () => {
    mockedAuthorize.mockRejectedValueOnce(new AuthorizationError('users', 'view'))
    const response = await listRoles()
    expect(response.status).toBe(403)
  })

  it('rejects a Partner attempting a Founder-only user mutation', async () => {
    mockedRequireFounder.mockRejectedValueOnce(
      new AuthorizationError('founder', 'manage', 'Only the Founder can perform this action')
    )
    const response = await createUser(
      new Request('http://localhost/api/users', { method: 'POST', body: '{}' })
    )
    expect(response.status).toBe(403)
  })

  it('rejects a Partner reading the audit log', async () => {
    mockedRequireFounder.mockRejectedValueOnce(new AuthorizationError('founder', 'manage'))
    const response = await auditGet(new NextRequest('http://localhost/api/audit-log'))
    expect(response.status).toBe(403)
  })
})

describe('forced password change blocks module access (403 PASSWORD_CHANGE_REQUIRED)', () => {
  it('maps PasswordChangeRequiredError on a user list GET', async () => {
    mockedAuthorize.mockRejectedValueOnce(new PasswordChangeRequiredError())
    const response = await listUsers()
    const body = await readJson(response)
    expect(response.status).toBe(403)
    expect(body.error?.code).toBe('PASSWORD_CHANGE_REQUIRED')
  })
})

describe('audit log is append-only from the API', () => {
  it('answers 405 to PUT/PATCH/DELETE with no database access', async () => {
    for (const handler of [auditPut, auditPatch, auditDelete]) {
      const response = await handler()
      const body = await readJson(response)
      expect(response.status).toBe(405)
      expect(body.error?.code).toBe('METHOD_NOT_ALLOWED')
    }
  })
})
