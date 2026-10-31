/**
 * Client fetch wrapper that carries the CSRF token.
 *
 * SPEC §10.1.1 Threat 3: the double-submit token issued at login must be echoed
 * on every state-changing request. The token lives in a JS-readable cookie by
 * design, so the app cannot rely on the browser attaching it automatically —
 * each mutation has to opt in.
 *
 * Routing every mutation through `apiFetch` means a new call site cannot forget
 * the header, which is the failure mode that leaves a CSRF protection in place
 * on paper only.
 */

export const CSRF_COOKIE = 'decoricks_csrf'
export const CSRF_HEADER = 'x-csrf-token'

const SAFE_METHODS = new Set(['GET', 'HEAD'])

/**
 * Reads the CSRF cookie. Returns `''` before login rather than throwing — a
 * missing token is reported by the server as a 403, which is the correct place
 * to decide whether that matters.
 */
export function getCsrfToken(): string {
  if (typeof document === 'undefined') return ''
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : ''
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /** True when the session is gone and the caller should send the user to /login. */
  get isUnauthorized(): boolean {
    return this.status === 401
  }

  get isForbidden(): boolean {
    return this.status === 403
  }
}

export const apiFetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)

  /*
   * A `FormData` body must be left without a `Content-Type`. The browser generates
   * `multipart/form-data` for it including the boundary parameter the server needs
   * to split the parts apart, and stamping `application/json` on top — which is
   * what the default below does for every other body — produces a request whose
   * header contradicts its bytes, so `request.formData()` on the other end fails.
   *
   * The same reasoning covers `URLSearchParams` and `Blob`, which the fetch
   * standard also types as bodies with their own natural content type. Everything
   * else in this app sends JSON, which is what the fallback is for.
   */
  const browserSetsContentType =
    (typeof FormData !== 'undefined' && init.body instanceof FormData) ||
    (typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams) ||
    (typeof Blob !== 'undefined' && init.body instanceof Blob)

  if (init.body !== undefined && !browserSetsContentType && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  if (!SAFE_METHODS.has(method)) {
    const token = getCsrfToken()
    if (token) headers.set(CSRF_HEADER, token)
  }

  return fetch(input, { ...init, method, headers, credentials: 'same-origin' })
}

/**
 * `apiFetch` plus JSON decoding, throwing `ApiError` on a non-`success` body so
 * callers can use try/catch instead of branching on a wrapper object.
 */
export const apiJson = async <T = unknown>(input: string, init: RequestInit = {}): Promise<T> => {
  const res = await apiFetch(input, init)

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // A non-JSON body on an error status is still worth reporting.
    if (!res.ok) throw new ApiError(`Request failed (${res.status})`, res.status)
    return undefined as T
  }

  const envelope = body as {
    success?: boolean
    data?: T
    timestamp?: string
    error?: { message?: string; code?: string; details?: unknown }
  } | null

  if (!res.ok || envelope?.success === false) {
    throw new ApiError(
      envelope?.error?.message ?? `Request failed (${res.status})`,
      res.status,
      envelope?.error?.code,
      envelope?.error?.details
    )
  }

  return envelope?.data as T
}

/**
 * `apiJson` plus the server's own completion time for THIS response, and how
 * long the client waited for it.
 *
 * Every envelope already carries `timestamp` (set server-side when the response
 * was built); it is normally discarded because no screen needs it. The realtime
 * layer does: `SyncCoordinator.settleRead` has to prove, in *server* time, that a
 * module was read after the newest write inside it before it can swallow the
 * first cursor snapshot. A client `Date.now()` cannot prove that — the cursor
 * timestamps come from the server's clock, and comparing a client clock to a
 * server clock is exactly the skew that would silently drop a colleague's change.
 *
 * That is why `durationMs` belongs with it. The envelope marks when the handler
 * *finished*, which is after the rows were selected by however long the handler
 * took; the pair `serverTime - durationMs` is the instant the request can at the
 * earliest have begun, which is the only instant that can prove it already saw a
 * given write. The client-side interval is deliberately wider than the server's
 * query window (it includes connecting, transferring and parsing), so the proof
 * errs towards revalidating.
 *
 * `serverTime` is `null` when the response carried no parseable timestamp, which
 * makes `settleRead` record no proof and leaves the revalidate-on-first-snapshot
 * behaviour fully intact.
 */
export const apiJsonMeta = async <T = unknown>(
  input: string,
  init: RequestInit = {}
): Promise<{ data: T; serverTime: number | null; durationMs: number }> => {
  const startedAt = Date.now()
  const res = await apiFetch(input, init)

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    if (!res.ok) throw new ApiError(`Request failed (${res.status})`, res.status)
    return { data: undefined as T, serverTime: null, durationMs: Date.now() - startedAt }
  }

  const envelope = body as {
    success?: boolean
    data?: T
    timestamp?: string
    error?: { message?: string; code?: string; details?: unknown }
  } | null

  if (!res.ok || envelope?.success === false) {
    throw new ApiError(
      envelope?.error?.message ?? `Request failed (${res.status})`,
      res.status,
      envelope?.error?.code,
      envelope?.error?.details
    )
  }

  const stamp = envelope?.timestamp ? Date.parse(envelope.timestamp) : NaN
  return {
    data: envelope?.data as T,
    serverTime: Number.isFinite(stamp) ? stamp : null,
    durationMs: Date.now() - startedAt,
  }
}

export const apiPost = <T = unknown>(input: string, body?: unknown) =>
  apiJson<T>(input, { method: 'POST', body: JSON.stringify(body ?? {}) })

export const apiPut = <T = unknown>(input: string, body?: unknown) =>
  apiJson<T>(input, { method: 'PUT', body: JSON.stringify(body ?? {}) })

export const apiPatch = <T = unknown>(input: string, body?: unknown) =>
  apiJson<T>(input, { method: 'PATCH', body: JSON.stringify(body ?? {}) })

export const apiDelete = <T = unknown>(input: string, body?: unknown) =>
  apiJson<T>(input, { method: 'DELETE', body: JSON.stringify(body ?? {}) })
