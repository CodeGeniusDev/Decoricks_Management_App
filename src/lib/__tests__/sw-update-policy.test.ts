/**
 * Behavioural tests for `public/sw.js` (Phase 10 stale-bundle audit).
 *
 * The worker is plain JS with no imports, so it is loaded here into a `vm`
 * context with the smallest possible Service Worker environment — `self`,
 * `fetch`, `caches`, `clients` and fake lifecycle events — and the captured
 * handlers are then driven like a browser would.
 *
 * What this locks, in the order the audit found it:
 *   • a navigation is served from the NETWORK when the network answers, so a
 *     deploy's fresh HTML (and its new chunk filenames) wins over the cached
 *     copy of the previous build — the exact "old client kept alive" bug;
 *   • the cached copy still serves an offline navigation, and a route never
 *     visited gets the controlled offline page instead of a browser error;
 *   • `/api/*` and RSC payload requests are never intercepted at all;
 *   • `install` never calls `skipWaiting()` by itself — the swap is opt-in via
 *     the `SKIP_WAITING` message — while `activate` purges every older
 *     `decoricks-*` cache;
 *   • `PURGE_PAGE_CACHES` (sign-out) drops the document caches only, leaving the
 *     shell and hashed assets so the next sign-in is not a cold download;
 *   • a notification click can only ever navigate inside this origin.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const ORIGIN = 'https://app.decoricks.test'
const SW_SOURCE = () => readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8')

/**
 * The worker owns its cache names and bumps them when the policy changes, so the
 * tests read them out of the file instead of hard-coding a version — a rename
 * must not silently turn an assertion into a no-op.
 */
const cacheName = (constant: string): string => {
  const match = new RegExp(`const ${constant} = '([^']+)'`).exec(SW_SOURCE())
  if (!match) throw new Error(`public/sw.js no longer defines ${constant}`)
  return match[1]
}

const SHELL = cacheName('SHELL_CACHE')
const PAGES = cacheName('PAGES_CACHE')
const STATIC = cacheName('STATIC_CACHE')

/** Names from an older family: present, and expected to be discarded. */
const SHELL_OLD = 'decoricks-shell-v0'
const PAGES_OLD = 'decoricks-pages-v0'
const STATIC_OLD = 'decoricks-static-v0'

type Handler = (event: unknown) => void

/**
 * A browser hands a document load to the worker as a request with
 * `mode: 'navigate'`. undici's `Request` no longer accepts that mode in its
 * constructor (it was removed from `RequestMode`), so it is stamped on after
 * construction — the worker only ever reads it.
 */
const navigateRequest = (url: string, mode = 'navigate'): Request => {
  const request = new Request(new URL(url, ORIGIN))
  Object.defineProperty(request, 'mode', { value: mode })
  return request
}

interface SwHarness {
  listeners: Record<string, Handler[]>
  /** Cache contents as `cacheName -> pathname -> Response`. */
  stores: Map<string, Map<string, Response>>
  skipWaiting: () => void
  claimed: () => number
  posted: Array<Record<string, unknown>>
  navigateTo: (url: string) => Promise<string>
  openWindowUrl: () => string | null
  setNetwork: (fn: (request: Request) => Promise<Response>) => void
  setControlledClients: (n: number) => void
  fire: (type: string, event?: Record<string, unknown>) => Promise<void>
}

const createSw = (initialCaches: Record<string, Record<string, string>> = {}): SwHarness => {
  const listeners: Record<string, Handler[]> = {}
  const stores = new Map<string, Map<string, Response>>()
  const posted: Array<Record<string, unknown>> = []
  const state = {
    network: (_request: Request): Promise<Response> =>
      Promise.reject(new Error('offline (test default)')),
    controlled: 0,
    claimedCount: 0,
    skipped: 0,
    navigatedTo: null as string | null,
    openedUrl: null as string | null,
  }

  // Cache keys are pathnames: `ignoreSearch: true` is what the worker asks for,
  // and a navigation URL's query is part of the page, not of its cache identity.
  const keyOf = (input: Request | string): string => {
    const url = typeof input === 'string' ? new URL(input, ORIGIN) : new URL(input.url)
    return url.pathname
  }

  class FakeCache {
    constructor(private readonly rows: Map<string, Response>) {}
    async put(input: Request | string, response: Response): Promise<void> {
      this.rows.set(keyOf(input), response)
    }
    async match(
      input: Request | string,
      options?: { ignoreSearch?: boolean }
    ): Promise<Response | undefined> {
      void options
      return this.rows.get(keyOf(input))
    }
    async delete(input: Request | string): Promise<boolean> {
      return this.rows.delete(keyOf(input))
    }
    async addAll(inputs: Array<Request | string>): Promise<void> {
      for (const input of inputs) {
        const request = typeof input === 'string' ? new Request(new URL(input, ORIGIN)) : input
        const response = await state.network(request)
        if (!response.ok) throw new Error(`addAll: ${keyOf(input)} responded ${response.status}`)
        this.rows.set(keyOf(request), response)
      }
    }
  }

  const cacheFor = (name: string): Map<string, Response> => {
    let rows = stores.get(name)
    if (!rows) {
      rows = new Map()
      stores.set(name, rows)
    }
    return rows
  }

  const caches = {
    open: async (name: string) => new FakeCache(cacheFor(name)),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    // `caches.match(string)` searches every cache, like the real API.
    match: async (input: Request | string) => {
      const key = keyOf(input)
      for (const rows of stores.values()) {
        const hit = rows.get(key)
        if (hit) return hit
      }
      return undefined
    },
  }

  const self = {
    location: { origin: ORIGIN, href: `${ORIGIN}/` },
    addEventListener: (type: string, handler: Handler) => {
      ;(listeners[type] ||= []).push(handler)
    },
    skipWaiting: () => {
      state.skipped += 1
    },
    clients: {
      matchAll: async () =>
        Array.from({ length: state.controlled }, () => ({
          postMessage: (data: Record<string, unknown>) => posted.push(data),
          focus: async () => undefined,
          navigate: async (url: string) => {
            state.navigatedTo = url
            return {}
          },
        })),
      claim: async () => {
        state.claimedCount += 1
      },
      openWindow: async (url: string) => {
        state.openedUrl = url
        return {}
      },
    },
    registration: { showNotification: async () => undefined },
  }

  const sandbox = {
    self,
    // The worker's top-level `addEventListener(...)` calls resolve to `self.*`
    // in a real SW global; alias them so the source needs no change.
    addEventListener: self.addEventListener,
    skipWaiting: self.skipWaiting,
    clients: self.clients,
    registration: self.registration,
    caches,
    fetch: (input: Request | string) =>
      state.network(typeof input === 'string' ? new Request(new URL(input, ORIGIN)) : input),
    Response,
    Request,
    URL,
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
  }
  vm.createContext(sandbox)
  vm.runInContext(SW_SOURCE(), sandbox, { filename: 'public/sw.js' })

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  return {
    listeners,
    stores,
    posted,
    skipWaiting: () => state.skipped,
    claimed: () => state.claimedCount,
    openWindowUrl: () => state.openedUrl,
    navigateTo: async (url: string) => {
      const request = navigateRequest(url)
      let response: Response | undefined
      const handler = listeners.fetch?.[0]
      expect(handler, 'fetch handler').toBeTypeOf('function')
      handler({
        request,
        respondWith: (promise: Promise<Response>) => {
          promise.then((res) => (response = res))
        },
        waitUntil: (promise: Promise<unknown>) => promise.catch(() => undefined),
      })
      await flush()
      await flush()
      return (await response?.text()) ?? ''
    },
    setNetwork: (fn) => {
      state.network = fn
    },
    setControlledClients: (n) => {
      state.controlled = n
    },
    /** Runs every listener for `type` with a lifecycle event and settles. */
    fire: async (type, event = {}) => {
      const waitUntilPromises: Promise<unknown>[] = []
      for (const handler of listeners[type] ?? []) {
        handler({
          ...event,
          waitUntil: (promise: Promise<unknown>) => {
            waitUntilPromises.push(promise.catch(() => undefined))
          },
        })
      }
      await Promise.all(waitUntilPromises)
      await flush()
      await flush()
    },
  }
}

/** Seed the caches the way a previous session would have left them. */
const withCaches = (rows: Record<string, Record<string, string>>) => {
  const sw = createSw()
  for (const [name, entries] of Object.entries(rows)) {
    const store = new Map<string, Response>()
    for (const [pathname, body] of Object.entries(entries)) {
      store.set(pathname, new Response(body, { headers: { 'Content-Type': 'text/html' } }))
    }
    sw.stores.set(name, store)
  }
  return sw
}

describe('service worker update policy', () => {
  it('serves a navigation from the network, so a new deploy wins over the cached page', async () => {
    const sw = withCaches({ [PAGES]: { '/finance': 'OLD BUILD' } })
    sw.setNetwork(async () => new Response('NEW BUILD', { status: 200 }))

    expect(await sw.navigateTo('/finance')).toBe('NEW BUILD')
    // …and the fresh copy is what the next offline load will fall back to.
    expect(await sw.stores.get(PAGES)!.get('/finance')!.text()).toBe('NEW BUILD')
  })

  it('falls back to the cached page when the network is unreachable', async () => {
    const sw = withCaches({ [PAGES]: { '/finance': 'LAST GOOD COPY' } })
    sw.setNetwork(async () => {
      throw new Error('network down')
    })
    expect(await sw.navigateTo('/finance')).toBe('LAST GOOD COPY')
  })

  it('answers an offline first visit with the controlled offline page, never a rejection', async () => {
    const sw = withCaches({ [SHELL]: { '/offline.html': 'YOU ARE OFFLINE' } })
    sw.setNetwork(async () => {
      throw new Error('network down')
    })
    expect(await sw.navigateTo('/budgets')).toBe('YOU ARE OFFLINE')
  })

  it('leaves API and RSC requests entirely to the network', async () => {
    const sw = createSw()
    let intercepted = 0
    sw.setNetwork(async () => {
      intercepted += 1
      return new Response('{}', { status: 200 })
    })

    for (const url of ['/api/dashboard', '/finance?_rsc=1', '/api/sync/cursor?modules=tasks']) {
      const request = navigateRequest(url, url.startsWith('/api') ? 'cors' : 'navigate')
      sw.listeners.fetch[0]({
        request,
        respondWith: () => {
          throw new Error('the worker must not take over this request')
        },
        waitUntil: () => undefined,
      })
    }
    expect(intercepted).toBe(0) // the worker never called respondWith; the browser does the fetch
  })

  it('install does not skipWaiting on its own, and only announces UPDATE_READY to controlled tabs', async () => {
    const sw = createSw()
    sw.setNetwork(async () => new Response('<html>shell</html>', { status: 200 }))
    expect(sw.skipWaiting()).toBe(0)

    sw.setControlledClients(2)
    await sw.fire('install')
    expect(sw.skipWaiting()).toBe(0) // the swap stays opt-in
    expect(sw.posted.filter((m) => m.type === 'UPDATE_READY')).toHaveLength(2)

    // A first-ever install has nobody to notify, so no prompt appears out of nowhere.
    const fresh = createSw()
    fresh.setNetwork(async () => new Response('<html>shell</html>', { status: 200 }))
    await fresh.fire('install')
    expect(fresh.posted).toHaveLength(0)
  })

  it('activate deletes older decoricks-* caches and claims clients', async () => {
    const sw = withCaches({
      [PAGES_OLD]: { '/finance': 'STALE BUILD' },
      [SHELL_OLD]: { '/offline.html': 'STALE SHELL' },
      [STATIC_OLD]: { '/_next/static/chunks/app.js': 'STALE CHUNK' },
      [PAGES]: { '/finance': 'CURRENT' },
    })
    await sw.fire('activate')
    expect([...sw.stores.keys()]).toEqual([PAGES])
    expect(sw.claimed()).toBe(1)
  })

  it('SKIP_WAITING is the only page message that activates a waiting worker', async () => {
    const sw = createSw()
    await sw.fire('message', { data: { type: 'PURGE_PAGE_CACHES' }, source: null })
    expect(sw.skipWaiting()).toBe(0)
    await sw.fire('message', { data: { type: 'SKIP_WAITING' }, source: null })
    expect(sw.skipWaiting()).toBe(1)
  })

  it('PURGE_PAGE_CACHES drops the documents and keeps the shell and assets', async () => {
    const sw = withCaches({
      [PAGES]: { '/finance': 'THIS ACCOUNT SCREEN' },
      [SHELL]: { '/offline.html': 'OFFLINE PAGE' },
      [STATIC]: { '/_next/static/chunks/x.js': 'CHUNK' },
    })
    await sw.fire('message', { data: { type: 'PURGE_PAGE_CACHES' }, source: null })
    expect(sw.stores.has(PAGES)).toBe(false)
    expect([...sw.stores.keys()].sort()).toEqual([SHELL, STATIC].sort())
  })

  it('a notification click cannot navigate outside this origin', async () => {
    const sw = createSw()
    let target = ''
    await sw.fire('notificationclick', {
      notification: {
        close: () => undefined,
        data: { link: 'https://phishing.example/finance' },
      },
    })
    target = sw.openWindowUrl() ?? ''
    expect(target.startsWith(ORIGIN)).toBe(true)
    expect(target.includes('phishing.example')).toBe(false)

    // A normal deep link keeps its query, which is how the record is opened.
    const sw2 = createSw()
    await sw2.fire('notificationclick', {
      notification: { close: () => undefined, data: { link: '/finance?transaction=abc' } },
    })
    expect(sw2.openWindowUrl()).toBe(`${ORIGIN}/finance?transaction=abc`)
  })
})
