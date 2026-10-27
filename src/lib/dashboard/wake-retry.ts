/**
 * Cold-start recovery — telling "the server is asleep" apart from "there is no
 * network", and waiting for the former without pretending it is the latter.
 *
 * THE REPORTED BUG. Render's free instance sleeps after ~15 minutes idle. The
 * next request is served by a machine that is still booting, so the first
 * `/api/dashboard` either resets or hangs until it times out. On the deployed
 * app that produced two things at once: the board reading "Couldn't load the
 * dashboard / Failed to fetch", and the header chip reading **Offline** — on a
 * phone with full signal. Both recovered on their own a few seconds later, which
 * is the tell that neither was a real failure: the instance came up.
 *
 * `snapshot-fetch` already fixed the first half — the message is now a classified
 * sentence and the read is retried once. What it cannot do is wait long enough.
 * A cold Node process on the free tier takes 10–40s to answer its first request,
 * and a single 750ms retry is not a policy that survives that; it is a policy
 * that survives a transient reset. Stretching `snapshot-fetch`'s retry to 90s
 * would be wrong too: the same code path serves a warm server, where 90s of
 * silence is a genuine outage and the user should be told immediately.
 *
 * SO THIS FILE SEPARATES THE TWO QUESTIONS:
 *
 *   "should I keep trying?"  → only while the browser reports connectivity AND
 *                              the failure is one a wake-up can fix. A 401, a
 *                              403 or a bad range gets exactly the attempts
 *                              `snapshot-fetch` already spends, and no more.
 *   "what do I say?"         → `waking` while the loop is still trying, `offline`
 *                              only when `navigator.onLine` is false, and `error`
 *                              when the window has genuinely run out.
 *
 * The budget is a WINDOW, not a count: delays double (1s, 2s, 4s, 8s …) and the
 * last one is truncated so the total wait lands on `windowMs` rather than
 * overshooting it. At 90s that is 1s 2s 4s 8s 16s 32s 27s — six doublings and a
 * tail — which covers the observed wake-up range without ever holding a request
 * open past a minute and a half.
 *
 * WHAT THE WINDOW HONESTLY BOUNDS is the *waiting*, not the last request: the
 * attempt made after the truncated tail starts at the deadline and is allowed to
 * finish, so the true worst case is `windowMs` plus one attempt. One attempt,
 * because the loop condition is re-checked before any further pause. That
 * overrun is deliberate — `snapshot-fetch` caps an attempt at its own 20s
 * timeout, so the promise is "about ninety seconds, plus whatever the request you
 * are already watching takes" — and the alternative was worse: refusing to start
 * an attempt that lands exactly on the deadline would throw away the 27s tail,
 * the single most likely moment for a cold instance to have finished booting.
 *
 * WHY THIS IS A PLAIN MODULE. `vitest.config.ts` is `environment: 'node'`: there
 * is no jsdom and no React testing library in this repo, so a hook cannot be
 * unit-tested. Everything with an opinion here is either a pure function or an
 * async function whose clock, connectivity probe and attempt callback are all
 * injected. `useDashboard` is left holding only React state and refs, which is
 * the part that genuinely needs a browser to observe.
 */

/** First pause, and the factor each subsequent one grows by. */
export const WAKE_BASE_MS = 1_000
export const WAKE_FACTOR = 2

/**
 * How long to keep a waking reader waiting. Sized from the observed wake-up on
 * the deployed free instance rather than from a round number: a cold Node boot
 * plus the first Atlas connection lands inside a minute, so 90s is "that, twice,
 * and then we stop guessing". It is also comfortably shorter than the ~2 min a
 * user will watch a skeleton before deciding the app is broken.
 */
export const WAKE_WINDOW_MS = 90_000

/**
 * The pause schedule for `windowMs`: doubling delays whose sum is exactly the
 * window. The final delay is shortened so the total lands ON the budget, not past
 * it — a schedule that overshot would make `windowMs` a lie. At the default that
 * is [1, 2, 4, 8, 16, 32, 27] seconds — six doublings and a truncated tail.
 *
 * An empty window yields no delays at all, which is the correct way to express
 * "do not retry" and lets the caller reuse this instead of special-casing.
 *
 * Exported because it is the readable statement of the policy the brief asked
 * for, and it is what the tests pin. `runWakeRetry` reproduces the same doubling
 * against a live clock instead of iterating this list, because a delay sequence
 * planned before the first attempt cannot know how long each attempt took — see
 * the comment at the loop.
 */
export const wakeSchedule = (
  windowMs: number = WAKE_WINDOW_MS,
  baseMs: number = WAKE_BASE_MS,
  factor: number = WAKE_FACTOR
): number[] => {
  const delays: number[] = []
  let spent = 0
  let delay = baseMs
  while (spent < windowMs) {
    const remaining = windowMs - spent
    const next = Math.min(delay, remaining)
    delays.push(next)
    spent += next
    delay *= factor
  }
  return delays
}

/**
 * Kinds a sleeping server is a plausible explanation for. Mirrors
 * `isRetryableKind` in `snapshot-fetch` deliberately: this is the same set, but
 * the question is different — `snapshot-fetch` asks "is another attempt worth
 * one short pause", and this asks "is another attempt worth up to 90 seconds".
 *
 * `offline` is absent because the browser has already told us there is no wire;
 * `unauthorized`, `forbidden` and `client` are absent because no amount of
 * waiting changes them; `aborted` is absent because the CALLER replaced this
 * read, which is not a failure to recover from.
 */
export const WAKE_WORTHY = ['timeout', 'network', 'server', 'bad-response'] as const

export type WakeWorthyKind = (typeof WAKE_WORTHY)[number]

export const isWakeWorthy = (kind: string): kind is WakeWorthyKind =>
  (WAKE_WORTHY as readonly string[]).includes(kind)

/** What the UI is allowed to show right now. One variant per honest state. */
export type WakePhase =
  /** Nothing in flight, or a read that succeeded — say nothing. */
  | { status: 'idle' }
  /**
   * The read is still being attempted against a server that has not answered.
   * `retryInMs` is the pause about to be waited, so the copy can promise a
   * concrete next attempt instead of an open-ended spinner.
   */
  | { status: 'waking'; attempt: number; retryInMs: number; elapsedMs: number }
  /** The browser itself reports no connectivity. Not the server's problem. */
  | { status: 'offline' }
  /** The window ran out, or the failure was never going to heal. */
  | { status: 'failed'; message: string; kind: string; spentMs: number }

/**
 * Drive one logical read through the wake-up window.
 *
 * `attempt` performs a single read and reports whether it succeeded and, if not,
 * which classified kind it was. It is called once up front and then after every
 * scheduled pause. `superseded` is checked before each pause AND after each
 * attempt, so a period switch, a manual Refresh or an unmount stops the loop
 * immediately rather than after the next delay — the mistake that would let a
 * 90-second loop outlive the screen that started it.
 */
export async function runWakeRetry<R>(
  attempt: () => Promise<R>,
  options: {
    /** Reads the outcome of `attempt`. Kept structural so this file imports nothing. */
    classify: (result: R) => {
      ok: boolean
      kind: string
      /** The user-facing sentence to fall back on when the window closes. */
      message: string
      /** `true` when the browser reports no connectivity at all. */
      offline: boolean
      /** `true` when the caller replaced this read; stops the loop silently. */
      aborted: boolean
    }
    superseded: () => boolean
    /** Injected so tests never sleep. */
    sleep: (ms: number) => Promise<void>
    /** Injected clock, for the same reason. */
    now: () => number
    windowMs?: number
    onPhase?: (phase: WakePhase) => void
  }
): Promise<R> {
  const { classify, superseded, sleep, now } = options
  const windowMs = options.windowMs ?? WAKE_WINDOW_MS
  const { onPhase } = options

  // Measured BEFORE the first attempt, not after it. `snapshot-fetch` spends up
  // to two attempts and its own 20s timeout inside a single call, so a window
  // that started after that call would be a 90-second promise that can be
  // delivered as 130 — and the whole point of a window is that the user knows
  // when the waiting ends.
  const startedAt = now()

  let result = await attempt()
  let first = classify(result)
  if (first.ok || first.aborted) return result

  // A browser that says it has no network should be believed, not retried. This
  // is the ONLY path that may report `offline`, and it is the reason the chip
  // can stop lying: everything else that failed is reported as the server not
  // answering, which is what it actually was.
  if (first.offline) {
    onPhase?.({ status: 'offline' })
    return result
  }

  // A failure no waiting can fix (a 401, a 403, a bad range) is reported the
  // moment it is known. Waiting is not the only cost being tracked here: `spentMs`
  // is how long the user stared at a spinner, and the first attempt already spent
  // up to two requests and a timeout doing that.
  if (windowMs <= 0 || !isWakeWorthy(first.kind)) {
    onPhase?.({
      status: 'failed',
      message: first.message,
      kind: first.kind,
      spentMs: now() - startedAt,
    })
    return result
  }

  // The schedule is recomputed from the LIVE clock rather than taken from a
  // precomputed list, because an attempt is not instantaneous: `snapshot-fetch`
  // can spend its full 20s timeout inside one call. A fixed [1,2,4,8,…] list
  // bounds only the SLEEPING, and 7 of those behind 20s timeouts would put the
  // user at ~3 minutes while claiming 90 seconds. Growing the pause from
  // `remaining()` instead makes the overrun at most one attempt, not seven — see
  // the window discussion in the file header.
  const remaining = () => windowMs - (now() - startedAt)
  let delay = WAKE_BASE_MS

  for (let i = 0; remaining() > 0; i++) {
    if (superseded()) return result

    const pause = Math.min(delay, remaining())

    // Announce BEFORE the pause: the user is about to wait, and a spinner that
    // only appears after the wait has started is indistinguishable from a hang.
    onPhase?.({
      status: 'waking',
      attempt: i + 1,
      retryInMs: pause,
      elapsedMs: now() - startedAt,
    })

    await sleep(pause)
    if (superseded()) return result

    result = await attempt()
    first = classify(result)
    if (first.ok || first.aborted) {
      onPhase?.({ status: 'idle' })
      return result
    }
    // Connectivity dropped mid-window: stop immediately and say the true thing
    // rather than burning the rest of the budget dialling a network that is gone.
    if (first.offline) {
      onPhase?.({ status: 'offline' })
      return result
    }
    if (!isWakeWorthy(first.kind)) break
    delay *= WAKE_FACTOR
  }

  onPhase?.({
    status: 'failed',
    message: first.message,
    kind: first.kind,
    spentMs: now() - startedAt,
  })
  return result
}

/**
 * The one sentence this layer owns. The caller's `message` is preferred when it
 * has one, because `snapshot-fetch` distinguishes "took too long" from "could
 * not be reached" and that difference is useful once waiting has actually failed.
 */
export const WAKING_MESSAGE = 'Server is waking up, retrying…'
