/**
 * Phase 6 §4.1 — per-stage API latency diagnostics.
 *
 * Strictly observational. `API_TIMING=1` is the only way to turn it on, and with
 * the flag off every function here returns immediately, so a normal request does
 * not allocate, log or await anything it would not otherwise.
 *
 * It exists because a client-measured "631ms endpoint" does not say where the
 * time went, and the answer changes what is worth fixing:
 *
 *   - waiting for a pooled connection (a pool/parking problem),
 *   - the session `$lookup` aggregate every protected request performs (a shape
 *     problem, see `getAuthenticatedUser`),
 *   - the role document read (cached for 2s, so normally free),
 *   - or the endpoint's own queries.
 *
 * `withAuth` opens a trace, so the line is attributable to a route; the auth and
 * ledger helpers add stages to whichever trace is current. Enable it on the same
 * production build `scripts/route-diag.ts` drives and read the server log:
 *
 *   API_TIMING=1 npm run start
 *
 * Nothing identifying a caller is ever printed — no cookie, no token, no email,
 * no user id. Only a route path, stage names and durations.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** Read once at module load; the flag is a deployment-level switch. */
export const apiTimingEnabled = process.env.API_TIMING === '1'

export interface ApiTrace {
  id: number
  /** `GET /api/finance/accounts` — method plus pathname. */
  label: string
  t0: number
  /** Stage name → accumulated milliseconds. */
  stages: Map<string, number>
}

const storage = new AsyncLocalStorage<ApiTrace>()
let nextTraceId = 0

/** The trace for the request currently being handled, when diagnostics are on. */
export const currentTrace = (): ApiTrace | undefined =>
  apiTimingEnabled ? storage.getStore() : undefined

/**
 * Run `handler` inside a fresh trace. Returns the handler's own result untouched;
 * when disabled the call is a bare pass-through.
 */
export async function withTrace<T>(label: string, handler: () => Promise<T>): Promise<T> {
  if (!apiTimingEnabled) return handler()
  const trace: ApiTrace = {
    id: ++nextTraceId,
    label,
    t0: Date.now(),
    stages: new Map(),
  }
  try {
    return await storage.run(trace, handler)
  } finally {
    report(trace)
  }
}

/**
 * Time one named stage of the current request. Nesting is additive and each name
 * accumulates, so a helper called three times in one request reports the total
 * and the count — the count is what distinguishes "one slow query" from "the same
 * slow query three times".
 */
export async function timeStage<T>(name: string, run: () => Promise<T>): Promise<T> {
  const trace = currentTrace()
  if (!trace) return run()
  const started = Date.now()
  try {
    return await run()
  } finally {
    const previous = trace.stages.get(name) ?? 0
    trace.stages.set(name, previous + (Date.now() - started))
    // The count rides alongside the duration under a sibling key, so a stage that
    // ran five times shows as `name=…ms x5` instead of looking like one slow run.
    const count = (trace.stages.get(`${name}#`) ?? 0) + 1
    trace.stages.set(`${name}#`, count)
  }
}

/** The route label for a `withAuth`-wrapped handler, from its first Request arg. */
export function labelFromArgs(args: unknown[]): string {
  for (const arg of args) {
    const url = (arg as { url?: unknown } | null)?.url
    if (typeof url !== 'string') continue
    try {
      const parsed = new URL(url, 'http://localhost')
      const method = (arg as { method?: unknown }).method
      return `${typeof method === 'string' ? method.toUpperCase() : 'REQ'} ${parsed.pathname}`
    } catch {
      // Not a URL we can label; fall through to the generic one.
    }
  }
  return 'request'
}

function report(trace: ApiTrace): void {
  const stages = [...trace.stages.entries()]
    .filter(([name]) => !name.endsWith('#'))
    .map(([name, ms]) => {
      const count = trace.stages.get(`${name}#`) ?? 1
      return count > 1 ? `${name}=${ms}ms x${count}` : `${name}=${ms}ms`
    })
  // Stages are a *subset* of the total: the gap between them is framework work,
  // serialization and the part of the handler that is not instrumented.
  console.log(
    `[api-timing] #${trace.id} ${trace.label} total=${Date.now() - trace.t0}ms` +
      (stages.length ? ` ${stages.join(' ')}` : '')
  )
}
