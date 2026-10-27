/**
 * The dashboard snapshot read — the failure-handling half of `useDashboard`.
 *
 * This lives in its own module for one reason: the repo has no DOM test
 * environment (`vitest.config.ts` is `environment: 'node'`, no jsdom, no
 * testing-library), so anything that decides whether a user sees a number or an
 * error had better be a plain function. The behaviour below is the entire
 * production bug it replaces, so it is exercised at 320px of wall-clock and 20s
 * of fake timers rather than "look at it on the deployed site and hope".
 *
 * WHAT WAS WRONG. `useDashboard` called `apiFetch` bare: no timeout, no retry,
 * no abort, and it put `err.message` straight into React state, which renders it
 * inside `ErrorState`. `apiFetch` rejects with the browser's own words whenever
 * the network layer fails before an HTTP status exists, and on Chrome those
 * words are always `Failed to fetch`. So the dashboard's error dialog was
 * showing the user a raw runtime string that (a) describes nothing, (b) is not
 * actionable, and (c) appeared on the ONE request that is guaranteed to meet a
 * transient network event: the first request after Render's free instance
 * wakes from its ~15-minute idle sleep. A single TCP reset during that wake was
 * enough to blank the whole board, and nothing retried it — the user had to
 * reload the page.
 *
 * WHAT THIS MODULE DOES INSTEAD:
 *
 *   • classifies the failure into a `FailureKind` instead of forwarding a string,
 *     so the UI can say something true ("the server took too long to respond")
 *     and the console can say something precise (kind, status, elapsed);
 *   • bounds the wait. A waking server that never answers used to leave the
 *     skeleton spinning forever; now the read is abandoned at `timeoutMs`;
 *   • retries a *user-initiated* read exactly once, with a short backoff, and
 *     retries only what is worth retrying. Background refreshes get one attempt
 *     — they are on a timer and will naturally come round again, and doubling
 *     them would be the duplicate-request behaviour the brief forbids;
 *   • refuses to invent numbers. A failure carries no `data`; the caller keeps
 *     the last good snapshot for a background miss and shows an error with a
 *     working retry for a foreground miss. Zero is never a substitute for "I
 *     don't know";
 *   • never repeats work the caller has already superseded, checked before each
 *     attempt, so a rapid period switch cannot interleave two snapshots;
 *   • and never lets server-authored text into the UI unchecked. The API layer
 *     already sanitises (see `handleRouteError`: generic 500 + `traceId`, 503 for
 *     a lost database), but "already sanitised upstream" is not a invariant this
 *     file can see, so the message is allowlisted by shape here too.
 */

export type FailureKind =
  /** The browser says there is no connection at all — don't spend a request. */
  | 'offline'
  /** Our own timer fired before the server answered. */
  | 'timeout'
  /** The request was superseded by a newer one; not an error, carries no message. */
  | 'aborted'
  /** fetch() rejected before any HTTP status existed (a reset, DNS or wake-up loss). */
  | 'network'
  /** 401 — the session ended. */
  | 'unauthorized'
  /** 403 — no access to this range or module. */
  | 'forbidden'
  /** 5xx, including the 503 the server returns when MongoDB is unreachable. */
  | 'server'
  /** 4xx that is not 401/403 — a malformed range, most often. */
  | 'client'
  /** A 200 whose body was not JSON, or whose envelope said `success: false`. */
  | 'bad-response'

export interface SnapshotSuccess<T> {
  ok: true
  data: T
  /** The server's own instant for this snapshot, or `null` if it sent none. */
  serverTime: number | null
  /** Wall-clock the caller waited, from the start of the FIRST attempt. */
  durationMs: number
  kind: 'ok'
  /** Attempts actually spent (1 or 2). */
  attempts: number
}

export interface SnapshotFailure {
  ok: false
  kind: FailureKind
  /** Safe to render. Never a raw runtime string, a driver error or a stack. */
  message: string
  status?: number
  /** Whether another attempt could plausibly succeed (the UI's "Try again"). */
  retryable: boolean
  attempts: number
  durationMs: number
}

export type SnapshotResult<T> = SnapshotSuccess<T> | SnapshotFailure

export interface SnapshotOptions {
  /** Suppression check, evaluated before the read and before every retry. */
  isCurrent: () => boolean
  /** `true` for the silent timer/event-driven refresh, `false` for a user action. */
  background: boolean
  timeoutMs?: number
  /** Backoff before the single foreground retry. Injectable so tests are instant. */
  retryDelayMs?: number
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Injected for tests. Defaults to the browser's own connectivity claim. */
  isOffline?: () => boolean
  /**
   * Receives `{ kind, status, attempts, durationMs }` for every outcome,
   * including successes that needed a retry. Deliberately given no URL, no
   * payload and no message text: this ends up in the browser console, and the
   * console is readable by anything running on the page.
   */
  onDiagnostics?: (info: {
    kind: FailureKind | 'ok'
    status?: number
    attempts: number
    durationMs: number
  }) => void
}

/**
 * Longer than the fastest legitimate dashboard read, short enough that a user
 * is not watching a skeleton for a minute. Measured on the deployed app when the
 * instance is warm: `/api/dashboard` answers unauthenticated in ~0.18s, so this
 * is ~100x headroom and only fires on a genuinely stuck request (a wake-up that
 * never completes, or a request caught by a proxy that has lost the origin).
 */
export const DEFAULT_TIMEOUT_MS = 20_000

/** Short, and short ONCE. See the retry policy in the file header. */
export const DEFAULT_RETRY_DELAY_MS = 750

/** The number of attempts a read is allowed to spend. Pure, so it can be asserted. */
export const attemptsFor = (background: boolean): number => (background ? 1 : 2)

/**
 * Kinds worth spending the retry on: all three are "the wire or the server was
 * not ready", which is precisely what a wake-up fixes. A 401, a 403 or a
 * malformed range will fail identically on attempt two — retrying those is how a
 * session-expired tab turns into a request storm. `bad-response` is in here too
 * because the realistic cause is a truncated body or a proxy page, both of which
 * a second attempt clears; it stays a single extra attempt on a read, never on a
 * write.
 */
export const isRetryableKind = (kind: FailureKind): boolean =>
  kind === 'timeout' || kind === 'network' || kind === 'server' || kind === 'bad-response'

/**
 * Server-authored messages are the only non-static text allowed to reach the
 * screen, and even then only if it looks like a sentence: bounded length, no
 * line breaks, no path separators, no stack-shaped tokens. That is a cheap
 * gate, not a parser — its job is to make "the error dialog printed a Mongo
 * topology dump" impossible rather than merely unlikely, because the envelope is
 * produced by a handler this file cannot see.
 */
export const isSafeServerMessage = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text.length === 0 || text.length > 160) return false
  if (/[\n\r]/.test(text)) return false
  if (/[{}<>]|at\s+\w+\s+\(|\.(js|ts|tsx|mjs):\d/.test(text)) return false
  if (/mongodb|mongoose|ECONNREFUSED|ETIMEDOUT|Traceback|\bnull\b/.test(text)) return false
  return true
}

/**
 * The fixed copy the dashboard shows. Every kind has one; none is a raw string.
 *
 * Deliberately takes NO server input. A previous version accepted an optional
 * `serverMessage` and echoed it for `client`, which quietly made this function
 * the leak it was supposed to prevent — the allowlist in `fail` had already said
 * no, and this returned the driver error anyway. The only caller that may use
 * server-authored text is `fail`, and only through `isSafeServerMessage`.
 */
export const safeMessage = (kind: FailureKind): string => {
  switch (kind) {
    case 'offline':
      return "You're offline. Reconnect and try again."
    case 'timeout':
      return 'The server took too long to respond. Try again.'
    case 'network':
      return "Couldn't reach the server. It may be waking up — try again."
    case 'unauthorized':
      return 'Your session has ended. Sign in again to reload the dashboard.'
    case 'forbidden':
      return "You don't have access to this data for the selected period."
    case 'client':
      // A 400 here is almost always an incomplete custom range, which IS the
      // useful information, so `fail` prefers the allowlisted server sentence
      // and falls back to this when there isn't one.
      return 'That date range could not be loaded. Try again.'
    case 'server':
      return 'The server could not build the dashboard. Try again in a moment.'
    case 'bad-response':
      return 'The dashboard response was incomplete. Try again.'
    case 'aborted':
      return ''
  }
}

/** Map an HTTP status to a kind. One place, so the policy is assertable. */
export const kindForStatus = (status: number): FailureKind => {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'bad-response'
}

interface Envelope<T> {
  success?: boolean
  data?: T
  timestamp?: string
  error?: { message?: string; code?: string }
}

const decode = async <T>(res: Response): Promise<Envelope<T> | null> => {
  try {
    return (await res.json()) as Envelope<T>
  } catch {
    // A JSON parse failure is not itself an error to show the user — the status
    // is the fact worth keeping (an HTML error page from a proxy is a `server`
    // or `client` response, not a novel one).
    return null
  }
}

/**
 * Read one dashboard snapshot. Never throws: the caller gets a tagged union, so
 * "did this fail, and is it worth retrying" cannot be answered by string
 * matching on an exception message — the mistake the original code made.
 */
export async function fetchDashboardSnapshot<T>(
  url: string,
  options: SnapshotOptions
): Promise<SnapshotResult<T>> {
  const startedAt = Date.now()
  const {
    isCurrent,
    background,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    fetchImpl = (input, init) => fetch(input, init),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    /*
     * `onLine === false` is the only state that justifies spending no request.
     *
     * This expression used to read `navigator.onLine !== false`, which is TRUE
     * in every connected browser — so the check answered "we are offline" for
     * users who were online, and the dashboard returned `kind: 'offline'` with
     * `attempts: 0` and `durationMs: 0` before a request ever went out. Every
     * load, every user, and only on this page because this is the only read
     * that uses the helper. The test suite could not see it: every case injects
     * its own `isOffline`, so the default below was never evaluated.
     *
     * An absent `onLine` (a non-browser runtime, or a browser that does not
     * implement it) is UNKNOWN, and unknown must attempt the read and let the
     * transport decide — guessing "offline" there blackens the board.
     */
    isOffline = () => (typeof navigator === 'undefined' ? true : navigator.onLine === false),
    onDiagnostics,
  } = options

  const fail = (
    kind: FailureKind,
    attempts: number,
    status?: number,
    serverMessage?: string
  ): SnapshotFailure => {
    const durationMs = Date.now() - startedAt
    const retryable = isRetryableKind(kind)
    // A 400 on this endpoint is the user's own input (an incomplete custom
    // range), and the server is the only thing that knows which field — so its
    // sentence is worth surfacing, IF it passes the shape gate. Every other
    // kind gets fixed copy, because "the session ended" and "the database was
    // unreachable" are not things a message from the wire may be allowed to
    // claim on their own.
    const message =
      kind === 'client' && isSafeServerMessage(serverMessage)
        ? (serverMessage as string)
        : safeMessage(kind)
    onDiagnostics?.({ kind, status, attempts, durationMs })
    return {
      ok: false,
      kind,
      message,
      ...(status !== undefined ? { status } : {}),
      retryable,
      attempts,
      durationMs,
    }
  }

  if (isOffline()) return fail('offline', 0)

  const maxAttempts = attemptsFor(background)
  let lastKind: FailureKind = 'network'
  let lastStatus: number | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Checked per attempt, not once: a period switch while we are backing off
    // between attempts must stop the old read before it spends another request.
    if (!isCurrent()) return fail('aborted', attempt - 1)
    if (attempt > 1) await sleep(retryDelayMs)

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        ...(background ? { headers: { 'x-session-background': '1' } } : {}),
      })

      const envelope = await decode<T>(res)
      clearTimeout(timer)

      if (!res.ok) {
        lastKind = kindForStatus(res.status)
        lastStatus = res.status
        const serverMessage = envelope?.error?.message
        if (attempt < maxAttempts && isRetryableKind(lastKind) && isCurrent()) continue
        return fail(lastKind, attempt, res.status, serverMessage)
      }

      if (envelope?.success !== true || envelope.data === undefined) {
        // A 200 that is not a successful envelope, or an unreadable body: the
        // payload is absent, and absent is NOT zero. `data` stays unset.
        lastKind = 'bad-response'
        lastStatus = res.status
        if (attempt < maxAttempts && isRetryableKind(lastKind) && isCurrent()) continue
        return fail('bad-response', attempt, res.status, envelope?.error?.message)
      }

      const stamp = envelope.timestamp ? Date.parse(envelope.timestamp) : NaN
      onDiagnostics?.({
        kind: 'ok',
        status: res.status,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      })
      return {
        ok: true,
        data: envelope.data,
        serverTime: Number.isFinite(stamp) ? stamp : null,
        durationMs: Date.now() - startedAt,
        kind: 'ok',
        attempts: attempt,
      }
    } catch {
      clearTimeout(timer)
      // An abort from OUR timer is a timeout. An abort from anywhere else (the
      // page unloading, a superseding read) is not something to report as one.
      // And a read the caller has already replaced reports nothing at all —
      // that is the case that would otherwise show "Couldn't reach the server"
      // for a request the user cancelled by clicking a different period.
      if (!isCurrent()) return fail('aborted', attempt)
      lastKind = timedOut ? 'timeout' : 'network'
      lastStatus = undefined
      if (attempt < maxAttempts && isRetryableKind(lastKind) && isCurrent()) continue
      return fail(lastKind, attempt)
    }
  }

  return fail(lastKind, maxAttempts, lastStatus)
}
