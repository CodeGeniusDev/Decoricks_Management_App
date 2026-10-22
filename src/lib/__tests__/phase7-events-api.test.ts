/**
 * Phase 7 SSE endpoint (/api/events) authorization tests, updated for Phase 9.
 *
 * These lock the realtime-security guarantees the brief names — a user is never
 * subscribed to a module event type they lack permission for, and the
 * resume-gap signal the client needs to fall back to polling. Phase 9 added the
 * user-scoped `notifications` module: it is delivered to any authenticated
 * caller (its signals are filtered by recipient id), so an authenticated user
 * always has at least that channel — the guarantee is now that NO *module*
 * signal leaks to a caller without its grant, not that a module-less caller is
 * refused outright.
 *
 * The change-stream watcher is mocked out (mem-mongo has no `db.watch()`); the
 * per-module `authorize` mock is the lever that decides what scope is served,
 * with `discoverViewScopes` derived from it — the route resolves its module set
 * through that one call now, so filtering it through the same lever keeps the
 * "never advertise a module without its grant" assertion testing real logic.
 * `awaitChangeStreamOpen` is mocked ready by default so the baseline path keeps
 * its pre-Phase-5 shape; the "watcher not ready" case overrides it to prove the
 * route will not claim liveness it cannot back up.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { ObjectId } from 'mongodb'
import { authorize, AuthorizationError, discoverViewScopes } from '@/lib/authorization'
import { createMemDb, type MemDb } from './helpers/mem-mongo'

let mem: MemDb

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => mem.handle),
  getMongoClient: vi.fn(async () => mem.client),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

const ensureChangeStreamWatcher = vi.fn()
/** Resolves `true` (stream live) unless a test overrides it. */
const awaitChangeStreamOpen = vi.fn(async (): Promise<boolean> => true)
vi.mock('@/lib/realtime/watcher', () => ({
  ensureChangeStreamWatcher: () => ensureChangeStreamWatcher(),
  awaitChangeStreamOpen: () => awaitChangeStreamOpen(),
}))

import { GET } from '@/app/api/events/route'
import { SOURCES } from '@/lib/sync/cursor'
import { COLLECTION_MODULES } from '@/lib/realtime/types'

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
  const authorizeMock = (authorize as Mock)
    .mockReset()
    .mockImplementation(async (module: string) => {
      if (deny.includes(module)) throw new AuthorizationError(module, 'view')
      return okCtx()
    })

  // Production resolves the whole stream scope with a single discovery call;
  // reproduce its semantics by filtering through the `authorize` lever above, so
  // `deny` still decides exactly which modules the route may advertise.
  ;(discoverViewScopes as Mock).mockReset().mockImplementation(async (modules: string[]) => {
    const viewable: string[] = []
    for (const permModule of modules ?? []) {
      try {
        await authorizeMock(permModule)
        viewable.push(permModule)
      } catch (err) {
        if (deny.includes(permModule)) continue
        throw err
      }
    }
    return {
      userId: String(FOUNDER),
      email: 'f@decoricks.com',
      viewable,
      mustChangePassword: false,
    }
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
  awaitChangeStreamOpen.mockReset().mockImplementation(async () => true)
})

describe('GET /api/events', () => {
  it('gives a caller denied EVERY module grant a stream scoped to their own notifications only', async () => {
    // Phase 9 changed this contract: `notifications` is user-scoped, not
    // module-gated, so an authenticated caller always has at least that channel
    // (their signals are filtered by recipient id). There is therefore no longer
    // a "zero permitted modules" state to 403 on — the security property is that
    // NO module leaks through while the own-data notifications channel remains.
    grantAllBut(['tasks', 'chat', 'sales', 'inventory', 'finance']) // every module denied
    const { req, ctrl } = makeRequest()
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')

    const text = await readUntilStreamEnds(res, ctrl, 'event: hello')
    const hello = text
      .split('\n')
      .find((line) => line.startsWith('data: ') && line.includes('"modules"'))!
    const payload = JSON.parse(hello.slice('data: '.length)) as { modules: string[] }
    expect(payload.modules).toEqual(['notifications']) // nothing else is advertised
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

  it('sends the authoritative cursor baseline only once the stream is really watching', async () => {
    grantAllBut([])
    const { req, ctrl } = makeRequest()
    const res = await GET(req)
    const text = await readUntilStreamEnds(res, ctrl, 'event: cursor')
    expect(text).toContain('event: cursor')
    expect(text).not.toContain('watcher-not-ready')
    ctrl.abort()
  })

  it('degrades to reconcile — never a cursor baseline — when the watcher is not ready', async () => {
    // A `cursor` frame is what tells the client to stop polling
    // (`onLiveSignal()` in `sync/sse-transport.ts`). Publishing one from a
    // process whose change stream has not completed its server-side handshake
    // leaves a window with NO carrier at all: nothing can signal, and polling
    // has just been stood down. Phase 5 reproduced exactly that as a remote
    // write invisible to an open tab on a freshly started server.
    grantAllBut([])
    awaitChangeStreamOpen.mockImplementation(async () => false)
    const { req, ctrl } = makeRequest()
    const res = await GET(req)
    const text = await readUntilStreamEnds(res, ctrl, 'watcher-not-ready')
    expect(text).toContain('event: reconcile')
    expect(text).toContain('"reason":"watcher-not-ready"')
    expect(text).not.toContain('event: cursor')
    ctrl.abort()
  })
})

/* ------------------------------------------------------------------ *
 * Collection-mapping contract — Phase 5 §3
 * ------------------------------------------------------------------ */
describe('change-stream module mapping', () => {
  /**
   * Resolves the collection NAME a model getter asks the driver for, with no
   * driver: every `getXCollection(db)` is a thin `db.collection('<name>')`, so a
   * stub that records the name reads the truth straight out of the models layer
   * instead of duplicating a list a test would immediately rot.
   */
  const collectionNameOf = (get: (db: never) => unknown): string => {
    const seen: string[] = []
    // The stub is deliberately not a `Db` — only `collection()` is ever reached.
    get({
      collection: (name: string) => {
        seen.push(name)
        return {}
      },
    } as never)
    expect(seen, 'a cursor source should resolve exactly one collection name').toHaveLength(1)
    return seen[0]
  }

  it('gives a live signal to every collection the polling cursor reads', () => {
    for (const [module, sources] of Object.entries(SOURCES)) {
      for (const source of sources) {
        const name = collectionNameOf(source.get)
        expect(
          COLLECTION_MODULES[name],
          `a write to "${name}" moves the "${module}" cursor but has no COLLECTION_MODULES ` +
            `entry — other devices would learn about it from the polling fallback only, never live`
        ).toBe(module)
      }
    }
  })

  it('maps the finance cursor to the collection it actually reads', () => {
    // Regression: this map said `ledger: 'finance'`. There is no `ledger`
    // collection — the ledger lives in `transactions` — so the entry was dead
    // and finance had no live signal whatsoever, while still looking correct.
    expect(COLLECTION_MODULES).not.toHaveProperty('ledger')
    expect(COLLECTION_MODULES.transactions).toBe('finance')
  })
})
