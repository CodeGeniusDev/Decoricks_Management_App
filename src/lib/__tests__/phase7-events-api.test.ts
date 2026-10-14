/**
 * Phase 7 SSE endpoint (/api/events) authorization tests.
 *
 * These lock the two realtime-security guarantees the brief names — an
 * unauthenticated connection is *rejected* (never handed an open stream) and a
 * user is never subscribed to an event type they lack permission for — plus the
 * resume-gap signal the client needs to fall back to polling.
 *
 * The change-stream watcher is mocked out (mem-mongo has no `db.watch()`); the
 * per-module `authorize` mock is the lever that decides what scope is served.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { ObjectId } from 'mongodb'
import { authorize, AuthorizationError } from '@/lib/authorization'
import { createMemDb, type MemDb } from './helpers/mem-mongo'

let mem: MemDb

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => mem.handle),
  getMongoClient: vi.fn(async () => mem.client),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

const ensureChangeStreamWatcher = vi.fn()
vi.mock('@/lib/realtime/watcher', () => ({
  ensureChangeStreamWatcher: () => ensureChangeStreamWatcher(),
}))

import { GET } from '@/app/api/events/route'

const FOUNDER = new ObjectId('507f1f77bcf86cd799439011')

const okCtx = () => ({
  user: {
    _id: FOUNDER,
    email: 'f@decoricks.com',
    name: 'Founder',
    role: 'founder',
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 1,
  },
  session: { tokenHash: 'h', sessionVersion: 1, csrfToken: 'c', role: 'founder' },
  role: {
    name: 'founder',
    displayName: 'Founder',
    permissions: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  permissions: {},
})

/** Grants every module except those listed in `deny`. */
const grantAllBut = (deny: string[]) => {
  ;(authorize as Mock).mockReset().mockImplementation(async (module: string) => {
    if (deny.includes(module)) throw new AuthorizationError(module, 'view')
    return okCtx()
  })
}

const makeRequest = (headers: Record<string, string> = {}) => {
  const ctrl = new AbortController()
  const req = new Request('http://localhost/api/events', {
    signal: ctrl.signal,
    headers,
  }) as never
  return { req, ctrl }
}

/** Pulls frames off the stream until `marker` is seen, then aborts the request. */
async function readUntilStreamEnds(
  res: Response,
  ctrl: AbortController,
  marker: string
): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (let i = 0; i < 12; i += 1) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    if (text.includes(marker)) break
  }
  ctrl.abort()
  try {
    await reader.cancel()
  } catch {
    /* already torn down */
  }
  return text
}

beforeEach(() => {
  mem = createMemDb()
  ensureChangeStreamWatcher.mockClear()
})

describe('GET /api/events', () => {
  it('refuses a session with no permitted module — a 403 JSON, never an open stream', async () => {
    grantAllBut(['tasks', 'chat', 'sales', 'inventory', 'finance']) // everything denied
    const { req, ctrl } = makeRequest()
    const res = await GET(req)
    expect(res.status).toBe(403)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    ctrl.abort()
  })

  it('opens an event-stream for an authorised caller and handshakes the scope', async () => {
    grantAllBut([])
    const { req, ctrl } = makeRequest()
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')

    const text = await readUntilStreamEnds(res, ctrl, 'event: hello')
    expect(text).toContain('retry: 3000')
    expect(text).toContain('event: hello')
    ctrl.abort()
  })

  it('never advertises a module the caller has no grant for', async () => {
    grantAllBut(['finance']) // no finance access
    const { req, ctrl } = makeRequest()
    const res = await GET(req)
    const text = await readUntilStreamEnds(res, ctrl, 'event: hello')

    const hello = text
      .split('\n')
      .find((line) => line.startsWith('data: ') && line.includes('"modules"'))!
    const payload = JSON.parse(hello.slice('data: '.length)) as { modules: string[] }

    expect(payload.modules).toContain('chat')
    expect(payload.modules).toContain('tasks')
    expect(payload.modules).not.toContain('finance') // finance signal would never even be sent
    ctrl.abort()
  })

  it('a resume token ahead of the bus (a restart) yields a reconcile so the client polls', async () => {
    grantAllBut([])
    const { req, ctrl } = makeRequest({ 'last-event-id': '999999' })
    const res = await GET(req)
    const text = await readUntilStreamEnds(res, ctrl, 'event: reconcile')
    expect(text).toContain('event: reconcile')
    ctrl.abort()
  })

  it('starts the change-stream watcher lazily on the first live connection', async () => {
    grantAllBut([])
    const { req, ctrl } = makeRequest()
    await GET(req)
    expect(ensureChangeStreamWatcher).toHaveBeenCalled()
    ctrl.abort()
  })
})
