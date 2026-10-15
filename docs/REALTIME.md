# Real-Time Layer and Team Chat — Architecture

This documents the shipping implementation of Phase 7 (real-time layer + team
chat), its behaviour on free hosting, and the honest limits of the design. It
expands and, where the two differ, refines `SPEC.md` §7.

## Decision

**Server-Sent Events (SSE) driven by a MongoDB change stream, with an automatic
per-module cursor-polling fallback.** This is option (A) from the architecture
comparison and matches `SPEC.md` §7.1, which already prescribed SSE over
WebSockets. Client → server writes stay on ordinary authenticated HTTP API
routes; the live channel is one-way server → client, which is exactly what SSE
is for. A separate always-on WebSocket host (option B) was rejected: it needs a
second process to deploy, keep awake, secure and reconnect-manage for a
four-person internal tool, and every free "always-on Node" host sleeps or
credits-out. Polling-only (option C) is kept — as the fallback, not the primary.

## What the stream carries (and what it deliberately does not)

The SSE stream carries **dataless change signals only** — "module _X_ advanced
at timestamp _T_" — never record contents. This is a refinement of `SPEC.md`
§7.3, whose event table implied per-record payloads (`message_sent` with the
message data). The implementation does not do that, for two reasons:

1. **Permission safety.** A change signal leaks nothing. The stream's module
   scope is computed from the caller's `view` permissions _on connect_, so a user
   with no finance grant is never even sent a `finance` signal. We never have to
   reason about whether an event body is safe to show — there is no body.
2. **Freshness correctness.** The client reacts to a signal by re-fetching the
   affected data through the _same_ permission-guarded REST routes it uses for a
   normal load. The UI can therefore never render a record the API would have
   hidden, and there is a single source of truth for serialization.

### Modules

The live layer covers five modules: `tasks`, `chat`, `sales`, `inventory`,
`finance`. Each maps to the collection(s) that back it. When any watched
collection is written, the module's high-water mark advances and every open
screen subscribed to that module refreshes in place — no full reload, and open
modals, drawers, drags and half-filled forms are preserved (the refresh patches
data, it does not remount the page).

## Wire protocol — `GET /api/events`

Authenticated via the existing session cookie. Unauthenticated → `401` (a plain
JSON error, never a stream). Authenticated but with no permitted module → `403`.

```
retry: 3000                      # browser auto-reconnect cadence
event: hello   { modules, id }   # the module scope we agreed to serve
event: cursor  { module: ts }    # authoritative baseline on connect
event: change  id { module, ts } # one advanced high-water mark
event: reconcile { reason }      # resume gap → client must poll once
: ping                           # heartbeat comment every 20s, defeats proxy idle-close
```

- **Runtime:** `nodejs`, `force-dynamic`. Needs the driver-backed change stream
  and a response that outlives one request — this is why the app is deployed to
  a **single persistent Node host**, not a serverless function.
- **Heartbeat:** a `: ping` comment frame every 20s keeps intermediate proxies
  from closing an idle stream.
- **No-transform:** `X-Accel-Buffering: no` and `Cache-Control: no-transform`
  stop nginx/Cloudflare-style buffering from holding back flushes.

## Reliability and resume

- **Reconnect with backoff.** `EventSource` retries on its own; on a hard close
  the client re-opens on its own exponential backoff (3s base, capped at 60s)
  while continuing to receive updates via polling in the meantime.
- **Resume from last event.** A reconnecting client sends `Last-Event-ID`. The
  server keeps a bounded in-process replay buffer (`256` signals). If everything
  after that id is still held, those signals are replayed exactly — no missed
  change, no duplicate refetch. If they have aged out, or the id belongs to a
  previous process (a server restart), the server emits `reconcile` and the
  client does one poll to close the hole. Either way the coordinator dedupes by
  module timestamp, so a replay and a poll that overlap collapse to one refresh.
- **Ordering.** Signals are appended to a per-process monotonic sequence and the
  client only ever _advances_ a module's cursor (`ts > prev`), so out-of-order or
  duplicate signals are idempotent by construction.

## Automatic polling fallback

Polling is not a manual mode — it activates by itself and is transparent to
subscribers because both transports emit the identical `SyncCursor` shape.
Fallback triggers, mild to severe:

- `EventSource` unavailable (non-browser/ancient env) → poll immediately.
- **Startup watchdog**: stream opens but no `cursor`/`hello` lands within 8s
  (buffering proxy, paused host) → poll as a carrier while the stream keeps
  trying.
- `onerror` while `CONNECTING` → poll; the browser is already retrying.
- `reconcile` (resume gap) → poll once.
- Hard `CLOSED` → poll as the carrier and re-open a fresh stream on backoff.

A live event stands polling down instantly. Poll cadence is **6s** with a **3s
floor** (not the 30s in `SPEC.md` §7.5 — 30s felt dead for chat). Polling pauses
while the tab is hidden and fires immediately on `online` and on becoming
visible; each poll sends `x-session-background: 1` so an idle tab never extends
the rolling session timeout.

## Connection status and offline behaviour

A single shared connection store drives a visible status: **Live** (open SSE
stream) / **Live · syncing** (poll fallback is the carrier) / **Connecting…** /
**Reconnecting…** / **Offline**. `navigator.onLine` gates the honest offline
chip and pauses both transports until `online`.

Chat is **online-only** (offline chat sync is explicitly out of scope). When
offline: a banner appears, sending is disabled, and the composer keeps its
draft. On reconnect the draft is still there and the missed messages are
re-fetched via the cursor tail. Financial offline entry is Phase 9 — not built
here.

## Cleanup

All connections and timers are torn down on unmount and on logout: the SSE
stream closes, polling intervals clear, backoff/heartbeat/reconcile timers are
cancelled, and `online`/`offline`/`visibilitychange` listeners are removed. The
coordinator stops its transport when the last subscriber unregisters, so a page
with no live sections holds no open stream.

## Authorization model

- Every `/api/events` connection re-checks the caller's `view` permission per
  module and serves only the permitted scope.
- Every chat route gates server-side (`chat.view` / `chat.create`); channel
  management and message moderation are Founder-only and enforced by
  `requireFounder` on the mutating routes, independent of any UI flag.
- Message content is sanitized to plain text before storage and render (XSS).
- Message sends are rate-limited per `(user, channel)`.
- Edits and deletes are soft, time-boxed by the settings edit window, and
  audit-logged.

## Free-tier limits and what breaks

These are the real constraints. They are accepted trade-offs for a 4-person
internal tool, not bugs to hide.

- **Deployment must be a single persistent Node host.** SSE + change streams do
  not fit Vercel's serverless model (function timeouts kill long streams).
  Practical hosts: a small VPS, Railway/Fly free-ish credits, Render free web
  service — all of which **sleep** after inactivity.
- **When the host sleeps**, live signals stop and in-memory state is lost. On the
  next request the host wakes, the client's stream errors and falls back to
  polling; the first poll reconciles everything that changed while it slept. The
  user sees a brief "Reconnecting…" then "Live · syncing", never stale data and
  never a crash. Nothing is lost because the client re-fetches authoritative
  data rather than trusting a replayed event body.
- **The replay buffer and the rate limiter are process-local.** With one process
  this is correct. A multi-instance deployment would need a shared store
  (Redis/pub-sub) for both — out of scope and against the free/single-host
  constraint. Cross-instance live fan-out is therefore not supported.
- **MongoDB change streams need a replica set.** Atlas M0 is a replica set and
  supports them, but M0 can **pause after 30 days idle** and has capped
  throughput. A standalone local `mongod` (common on a dev laptop) does **not**
  support change streams at all — the watcher detects this, logs once, and steps
  aside; live updates continue to work through the polling fallback. Liveness is
  guaranteed by polling; the stream only makes it _instant_.
- **Weak mobile connections.** On a lossy Pakistani mobile link the stream drops
  often; reconnect + resume + polling mean the app stays correct (eventually
  consistent) even when it is not instant. The visible status is honest about
  which mode it is in.
- **Serverless/edge SSE limits** (if ever forced onto a serverless host):
  connection-time caps and per-account concurrent-stream limits would make the
  primary stream unreliable — which is precisely why polling exists and why the
  recommendation is a persistent host.

## Verification

Live behaviour was verified with **two separate browser contexts** (different
cookie jars = different devices) against the real HTTP surface in Playwright
(`src/e2e/phase7-chat.spec.ts`, `src/e2e/phase7-realtime.spec.ts`): a Founder
write appears on the Partner's open screen with no reload and exactly once;
unread badges update cross-device; an offline period shows the banner, disables
sending and keeps the draft, then resumes and delivers the missed message; and
the board repaints a remote task without a reload. See the Phase 7 test output
for results.
