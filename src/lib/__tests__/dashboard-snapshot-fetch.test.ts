import { describe, it, expect } from 'vitest'

import {
  fetchDashboardSnapshot,
  attemptsFor,
  isRetryableKind,
  isSafeServerMessage,
  kindForStatus,
  safeMessage,
  DEFAULT_TIMEOUT_MS,
  type SnapshotOptions,
} from '@/lib/dashboard/snapshot-fetch'

/**
 * The dashboard's reported failure, tested at the layer that decides what the
 * user reads.
 *
 * What shipped before this file existed: `useDashboard` awaited `apiFetch` with
 * no timeout and no retry and did `setError(err.message)`. `fetch()` rejects with
 * the browser's own words when the network layer fails before an HTTP status
 * exists, and on Chrome those words are always `Failed to fetch` — so the
 * dashboard's error dialog printed a string that describes nothing, is not
 * actionable, and was never retried. Trigger: Render's free instance sleeping
 * after its idle window, where the first request after the wake can be reset.
 * Every case below is that shape: a rejection that carries no status.
 *
 * The same file is a regression net for the opposite failure — "helpfulness" that
 * invents numbers. A failed read must never carry `data`, because a dashboard
 * showing PKR 0 where the truth is unknown is a financial report that lies.
 */

const URL = '/api/dashboard?period=month'

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })

const okEnvelope = {
  success: true,
  data: { finance: { netProfit: { paisa: 123450 } } },
  timestamp: '2026-10-26T10:00:00.000Z',
}

/**
 * Build one call under test. `sleep` is injected as an immediate resolution so a
 * retry costs no wall clock, and the timeout cases use a real 20ms timer instead
 * of fake ones — the retry path has to survive a faked clock, and a 20ms read is
 * easier to reason about than advancing timers across a loop.
 */
const build = (
  overrides: Partial<SnapshotOptions> = {},
  impl: (init: RequestInit) => Promise<Response> = async () => jsonResponse(okEnvelope)
) => {
  const calls: RequestInit[] = []
  const options: SnapshotOptions = {
    isCurrent: () => true,
    background: false,
    fetchImpl: async (_input, init) => {
      calls.push(init)
      return impl(init)
    },
    sleep: async () => undefined,
    isOffline: () => false,
    ...overrides,
  }
  return { options, calls }
}

const expectFailure = (result: Awaited<ReturnType<typeof fetchDashboardSnapshot>>) => {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected a failure')
  return result
}

describe('snapshot-fetch — the reported "Failed to fetch" failure', () => {
  it('recovers from a transient reset without the user seeing either attempt', async () => {
    let attempt = 0
    const { options, calls } = build({}, async () => {
      attempt++
      if (attempt === 1) throw new TypeError('Failed to fetch')
      return jsonResponse(okEnvelope)
    })

    const result = await fetchDashboardSnapshot(URL, options)

    expect(result.ok).toBe(true)
    expect(calls.length).toBe(2)
    if (!result.ok) return
    expect(result.data).toEqual(okEnvelope.data)
    expect('message' in result).toBe(false)
  })

  it('classifies a permanent network rejection and says something true', async () => {
    const { options } = build({}, async () => {
      throw new TypeError('Failed to fetch')
    })

    const failure = expectFailure(await fetchDashboardSnapshot(URL, options))

    expect(failure.kind).toBe('network')
    expect(failure.retryable).toBe(true)
    // The regression assertion: the browser's words must not reach the screen.
    expect(failure.message).not.toMatch(/failed to fetch/i)
    expect(failure.message).toBe("Couldn't reach the server. It may be waking up — try again.")
    // And nothing was invented to fill the gap.
    expect('data' in failure).toBe(false)
  })

  it('gives a background refresh exactly one attempt, so polling never doubles', async () => {
    const { options, calls } = build({ background: true }, async () => {
      throw new TypeError('Failed to fetch')
    })

    const failure = expectFailure(await fetchDashboardSnapshot(URL, options))

    expect(calls.length).toBe(1)
    expect(failure.attempts).toBe(1)
    expect(attemptsFor(true)).toBe(1)
    expect(attemptsFor(false)).toBe(2)
  })
})

describe('snapshot-fetch — timeout and offline', () => {
  it('abandons a read that never answers and reports it as a timeout', async () => {
    // A sleeping instance that accepts the connection and then says nothing:
    // without a timer the skeleton would spin for as long as the tab stayed open.
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })

    const { options, calls } = build({ timeoutMs: 20 }, (init) => hang(init))

    const failure = expectFailure(await fetchDashboardSnapshot(URL, options))

    expect(calls.length).toBe(2) // one timeout, one retry, then it gives up
    expect(failure.kind).toBe('timeout')
    expect(failure.message).toBe('The server took too long to respond. Try again.')
    // The production default must stay well above a warm read (~0.2s measured on
    // the deployed app) and below the point where a user gives up.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000)
  })

  it('spends no request at all when the browser already knows it is offline', async () => {
    const { options, calls } = build({ isOffline: () => true })

    const failure = expectFailure(await fetchDashboardSnapshot(URL, options))

    expect(calls.length).toBe(0)
    expect(failure.kind).toBe('offline')
    expect(failure.attempts).toBe(0)
    expect(failure.message).toBe("You're offline. Reconnect and try again.")
  })
})

/**
 * The default `isOffline`, which is the ONLY one the application runs.
 *
 * Every other case in this file injects `isOffline: () => false` through
 * `build()`, which makes them blind to the default — and the shipped default was
 * `navigator.onLine !== false`, an expression that is TRUE in every connected
 * browser. The result was the original bug report reproduced exactly: the
 * dashboard answered `kind: 'offline', attempts: 0, durationMs: 0` and never
 * issued a request, on every load, for every user. The server was healthy; the
 * client refused to ask it anything.
 *
 * So these cases stub `navigator` and pass NO `isOffline`. Omitting the option
 * is the entire point of the block, and it is the reason it is separate.
 */
describe('snapshot-fetch — the default connectivity check', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

  const withNavigator = async (value: unknown, run: () => Promise<void>) => {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
    try {
      await run()
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original)
      else delete (globalThis as { navigator?: unknown }).navigator
    }
  }

  const withDefaultOptions = () => {
    const calls: RequestInit[] = []
    const options: SnapshotOptions = {
      isCurrent: () => true,
      background: false,
      fetchImpl: async (_input, init) => {
        calls.push(init)
        return jsonResponse(okEnvelope)
      },
      sleep: async () => undefined,
      // deliberately no `isOffline`
    }
    return { options, calls }
  }

  it('asks the server when the browser reports itself connected', async () => {
    await withNavigator({ onLine: true }, async () => {
      const { options, calls } = withDefaultOptions()
      const result = await fetchDashboardSnapshot(URL, options)
      expect(calls.length, 'a connected browser must spend a request').toBe(1)
      expect(result.ok).toBe(true)
    })
  })

  it('spends nothing when the browser reports itself disconnected', async () => {
    await withNavigator({ onLine: false }, async () => {
      const { options, calls } = withDefaultOptions()
      const failure = expectFailure(await fetchDashboardSnapshot(URL, options))
      expect(calls.length).toBe(0)
      expect(failure.kind).toBe('offline')
      expect(failure.attempts).toBe(0)
    })
  })

  it('treats an unknown connectivity state as worth asking about', async () => {
    // A runtime that has `navigator` but no `onLine` is not evidence of being
    // offline, and guessing that it is would blank the board for everyone.
    await withNavigator({}, async () => {
      const { options, calls } = withDefaultOptions()
      const result = await fetchDashboardSnapshot(URL, options)
      expect(calls.length).toBe(1)
      expect(result.ok).toBe(true)
    })
  })
})

describe('snapshot-fetch — server responses are classified, not parroted', () => {
  it.each([
    [401, 'unauthorized', false],
    [403, 'forbidden', false],
    [400, 'client', false],
    [500, 'server', true],
    [503, 'server', true],
  ] as const)('%i → %s (retried: %s)', async (status, kind, retried) => {
    expect(kindForStatus(status)).toBe(kind)
    const { options, calls } = build({}, async () =>
      jsonResponse(
        {
          success: false,
          error: { message: 'Something went wrong. Please try again.', code: 'X' },
        },
        { status }
      )
    )

    const failure = expectFailure(await fetchDashboardSnapshot(URL, options))

    expect(failure.kind).toBe(kind)
    expect(failure.status).toBe(status)
    expect(failure.retryable).toBe(retried)
    // A 4xx is a decision, not a hiccup: retrying an expired session is how a
    // background tab turns into a request storm.
    expect(calls.length).toBe(retried ? 2 : 1)
  })

  it('keeps a useful range error from the server and refuses a dangerous one', async () => {
    const safe = 'The custom range needs both a start and an end date.'
    const good = build({}, async () =>
      jsonResponse({ success: false, error: { message: safe } }, { status: 400 })
    )
    expect(expectFailure(await fetchDashboardSnapshot(URL, good.options)).message).toBe(safe)

    // Same status, payload that must never be rendered.
    const leaky = build({}, async () =>
      jsonResponse(
        {
          success: false,
          error: {
            message:
              'MongoServerSelectionError: connection refused\n  at Topology.selectServer (node_modules/mongodb/lib/sdam/topology.js:312)',
          },
        },
        { status: 400 }
      )
    )
    const message = expectFailure(await fetchDashboardSnapshot(URL, leaky.options)).message
    expect(message).toBe(safeMessage('client'))
    expect(message).not.toMatch(
      /mongodb|node_modules|MongoServerSelectionError|Topology|selectServer/i
    )
  })

  it('allowlists server text by shape, not by trust', () => {
    expect(isSafeServerMessage('Try a shorter period.')).toBe(true)
    expect(isSafeServerMessage('')).toBe(false)
    expect(isSafeServerMessage('   ')).toBe(false)
    expect(isSafeServerMessage(undefined)).toBe(false)
    expect(isSafeServerMessage(42)).toBe(false)
    expect(isSafeServerMessage('x'.repeat(161))).toBe(false)
    expect(isSafeServerMessage('two\nlines')).toBe(false)
    expect(isSafeServerMessage('{"ok":true}')).toBe(false)
    expect(isSafeServerMessage('ETIMEDOUT on 10.0.0.1:27017')).toBe(false)
    expect(isSafeServerMessage('at Object.<anonymous> (route.ts:12)')).toBe(false)
  })

  it('treats a 200 without a usable envelope as a failure carrying no data', async () => {
    // The "silently return fake zero values" trap: an absent payload stays absent,
    // so the caller either keeps the last real snapshot or shows an error.
    const { options } = build({}, async () => jsonResponse({ success: false }))
    const failure = expectFailure(await fetchDashboardSnapshot(URL, options))
    expect(failure.kind).toBe('bad-response')
    expect('data' in failure).toBe(false)
  })

  it('survives a body that is not JSON at all (a proxy error page)', async () => {
    const { options } = build({}, async () => new Response('<html>gw timeout</html>'))
    const failure = expectFailure(await fetchDashboardSnapshot(URL, options))
    expect(failure.kind).toBe('bad-response')
    expect(failure.message).toBe('The dashboard response was incomplete. Try again.')
  })
})

describe('snapshot-fetch — supersession and request hygiene', () => {
  it('stops a read the caller has already replaced and reports no error', async () => {
    // A period switch mid-flight: the old read must neither land its numbers nor
    // be described to the user as a failure they never saw.
    const { options, calls } = build({ isCurrent: () => false })
    const failure = expectFailure(await fetchDashboardSnapshot(URL, options))

    expect(calls.length).toBe(0)
    expect(failure.kind).toBe('aborted')
    expect(failure.message).toBe('')
  })

  it('does not spend its retry once the caller has moved on', async () => {
    let current = true
    const { options, calls } = build({ isCurrent: () => current }, async () => {
      current = false
      throw new TypeError('Failed to fetch')
    })

    const failure = expectFailure(await fetchDashboardSnapshot(URL, options))
    expect(calls.length).toBe(1)
    expect(failure.kind).toBe('aborted')
  })

  it('flags the background read and pins the foreground one to a fresh, credentialed GET', async () => {
    const background = build({ background: true })
    await fetchDashboardSnapshot(URL, background.options)
    expect(background.calls[0]?.headers).toEqual({ 'x-session-background': '1' })

    const foreground = build()
    await fetchDashboardSnapshot(URL, foreground.options)
    expect(foreground.calls[0]?.headers).toBeUndefined()
    expect(foreground.calls[0]?.method).toBe('GET')
    // Session cookie travels, and nothing is served from cache: both are required
    // for a Refresh to actually re-query rather than replay a snapshot.
    expect(foreground.calls[0]?.credentials).toBe('same-origin')
    expect(foreground.calls[0]?.cache).toBe('no-store')
  })
})

describe('snapshot-fetch — success contract', () => {
  it('returns the engine payload and the server instant untouched', async () => {
    const built = build()
    const result = await fetchDashboardSnapshot(URL, built.options)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Not one field of the metrics object is altered on the way through.
    expect(result.data).toEqual(okEnvelope.data)
    expect(result.serverTime).toBe(Date.parse(okEnvelope.timestamp))
    expect(result.attempts).toBe(1)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports no server instant when the envelope omits one, rather than guessing', async () => {
    const { options } = build({}, async () =>
      jsonResponse({ success: true, data: { finance: {} }, timestamp: 'not-a-date' })
    )
    const result = await fetchDashboardSnapshot(URL, options)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.serverTime).toBeNull()
  })
})

describe('snapshot-fetch — diagnostics leak nothing', () => {
  it('emits only kind, attempts and elapsed', async () => {
    const seen: Parameters<NonNullable<SnapshotOptions['onDiagnostics']>>[0][] = []
    const { options } = build({ onDiagnostics: (info) => seen.push(info) }, async () => {
      throw new TypeError('Failed to fetch https://internal-host.example/api/dashboard?token=abc')
    })

    await fetchDashboardSnapshot(URL, options)

    expect(seen.length).toBe(1) // one diagnostic per outcome, not per attempt
    expect(seen[0]).toEqual({
      kind: 'network',
      attempts: 2,
      durationMs: expect.any(Number),
    })
    expect(JSON.stringify(seen)).not.toMatch(/token|internal|failed to fetch|dashboard/i)
  })

  it('diagnoses a success that needed the retry, so recovery is visible to an operator', async () => {
    const seen: string[] = []
    let attempt = 0
    const { options } = build(
      { onDiagnostics: (info) => seen.push(`${info.kind}:${info.attempts}`) },
      async () => {
        attempt++
        if (attempt === 1) throw new TypeError('Failed to fetch')
        return jsonResponse(okEnvelope)
      }
    )
    await fetchDashboardSnapshot(URL, options)
    expect(seen).toEqual(['ok:2'])
  })
})
