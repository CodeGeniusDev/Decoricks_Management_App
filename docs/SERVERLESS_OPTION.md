# Running Decoricks on a Serverless Host — Evaluation

**Scope.** Read-only analysis of what happens to this app if it is hosted on a
serverless platform (Netlify free, Vercel if allowed) instead of the planned
single persistent Node host (Render free, see `docs/DEPLOYMENT.md` §10). No
deployment was performed, no code was changed, and no database was written.
Measurements in §4 were taken against **`decoricks_dev` only**. `decoricks_prod`
and `test` were not touched. This document does **not** recommend a host; it
states what works, what degrades, and what the user would feel, and gives the
smallest safe changes if a serverless move is ever chosen. (The operator's
subsequent decision — Render Free + monitor first — is recorded in §Decision
below; the §1–§5 evaluation itself stays neutral.)

App facts used throughout: Next.js `^15.1.4` (App Router), React 19, MongoDB
Atlas (M0, AWS `ap-south-1` / Mumbai) via the `mongodb` driver `^6.21.0`,
Node runtime route handlers, one database-level change stream feeding an
in-process SSE fan-out.

---

## Decision (recorded 2026-10-25)

The operator has since decided. The analysis below (§1–§5) is kept unchanged as
the evidence for that decision; the evaluation itself made no recommendation, and
this section records the choice made on top of it. **Nothing in §2 has been
implemented, and nothing has been deployed.**

- **Chosen first host: Render Free + an external keep-awake monitor.** The app
  stays on the single persistent Node process it was designed for, so
  authentication, authorization, the DB-backed lockout, the change stream, SSE,
  the in-memory rate limiters and the warm Mongo pool all keep working as today
  (§5, first column). The monitor (a free UptimeRobot / cron-job.org pinging
  `GET /api/health` every 10 min) removes the idle spin-downs. Setup, the 750
  instance-hours math and the first-deploy failure modes are in
  `docs/DEPLOYMENT.md` §6b / §6c / §10. **No serverless code changes are made for
  this path** — that is the whole reason it was picked first.
- **Netlify Free — documented fallback only, not taken.** If a serverless move is
  ever made, it requires implementing §2 changes **A, B, C and E** first (D is
  optional). Their individual effort/risk is in §2; rolled up:

  | Required change (§2) | Effort | Risk |
  | -------------------- | ------ | ---- |
  | A — Mongo-backed login/admin rate limits (TTL) | **M** (~0.5–1 day + tests) | Med |
  | B — Serverless-safe Mongo client (reuse in prod, small pool) | **S** (~2–4 h + tests) | Low |
  | C — Disable SSE → explicit polling | **S–M** (~half day + tests) | Low–Med |
  | E — Force `TZ=Asia/Karachi` on the platform (config, not code) | **XS** (<1 h) | Low |

  **Total ≈ 2–3 engineer-days**, and every change must be **env-gated** so the
  Render persistent host stays byte-for-byte unchanged. Until A/B/C/E land,
  Netlify means the degradations in §5 (polling-only realtime, diluted per-IP
  throttling, per-instance cold handshake) — which is exactly why it is the
  fallback, not the first move.
- **Vercel Hobby — EXCLUDED.** Vercel's own pricing FAQ: "Our **Hobby plan is for
  personal, non-commercial use.**" Decoricks is a business internal tool, so the
  free Hobby plan is not an option; only the paid **Pro** plan would be, which is
  outside this free-hosting evaluation.
- **The hardening done as part of this decision** (item 1): `/api/health/database`
  is now Founder-only and leak-free (`src/app/api/health/database/route.ts` +
  tests). `/api/health` stays the public, DB-free liveness probe that the monitor
  and platform hit. This is a small security improvement, not a serverless change,
  and applies regardless of host.

---

## 1. Process-global state: what breaks or weakens on serverless

A serverless platform runs many short-lived, independent instances that start
empty, are frozen between requests, and share nothing. Everything below is
**per-process** today (the app assumes one persistent Node host — Checkpoint 1).
For each item: what happens across many cold/ephemeral instances, and whether it
is a _security_ weakness or only a correctness/perf loss.

| #    | State                                                                                | Where                                                                                                                                                                             | Today's guarantee                                                                                                        | What happens with many short-lived instances                                                                                                                                                                                                                                                                                                                                                                                                                  | Security weakness?                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | Login rate limiter (10/min per IP)                                                   | `src/lib/rate-limit.ts` `loginRateLimiter`, consumed in `api/auth/login/route.ts` keyed `ip:${x-forwarded-for}`                                                                   | Throttles brute force per IP, in-process `Map`                                                                           | Map is empty in each instance. An attacker's requests are load-balanced across N instances, so the effective ceiling is ~`10 × N` per minute for the same IP; a brand-new cold instance resets the window to 0.                                                                                                                                                                                                                                               | **Weakening, not a hole.** This limiter is a _throttle_; the real brute-force defense is the DB-backed lockout (1.2), which still holds. Per-IP throttling becomes unreliable.                                                                                                           |
| 1.2  | Change-password limiter (5/min/IP), admin limiter (30/min/IP)                        | `changePasswordRateLimiter`, `adminRateLimiter`; `api/auth/change-password`, `api/users*`, `api/roles*`                                                                           | Per-IP in-process throttle on auth/role/user writes                                                                      | Same dilution as 1.1 — the effective limit scales with instance count and resets on cold start.                                                                                                                                                                                                                                                                                                                                                               | **Weakening.** These protect write endpoints that are also authorization-gated (`authorize`) and audit-logged; the limiter is defense-in-depth, so losing its accuracy raises brute-force/guinea-pig throughput but does not grant access.                                               |
| 1.3  | Chat send limiter (20/10s per user+channel), record-search limiter (40/10s per user) | `messageSendLimiter`, `recordSearchLimiter`; `api/chat/.../messages`, `api/chat/references`                                                                                       | Blunts a stuck client hammering the channel / fan-out search                                                             | Diluted per-instance. A runaway client can post ~`20 × N` before being throttled.                                                                                                                                                                                                                                                                                                                                                                             | **Not a security issue.** Anti-footgun throttle for a 4-person team; volume abuse only, still bounded by auth.                                                                                                                                                                           |
| 1.4  | Account lockout                                                                      | `src/lib/auth/lockout.ts` → `loginAttempts` collection, sliding 15-min window, 5 attempts, 15-min lock                                                                            | **DB-backed**, shared by every instance; `loginAttempts_ttl` 24h + `loginAttempts_lookup` indexes in `ensureAuthIndexes` | **Survives serverless unchanged** — state lives in MongoDB, not memory. The only per-instance piece is the 1.1 throttle that sits _in front_ of it.                                                                                                                                                                                                                                                                                                           | **No.** This is the actual credential-stuffing gate and it is correct across instances. (Caveat: lockout is keyed by email identifier, so it cannot stop distributed per-IP probing of _many_ accounts — but that is a property of the design on any host, not a serverless regression.) |
| 1.5  | Realtime bus (SSE fan-out + replay buffer)                                           | `src/lib/realtime/bus.ts` `realtimeBus` on `global._decoricksRealtimeBus`; 256-signal in-memory buffer, per-process monotonic `seq`                                               | Fans a signal to every live SSE connection in the process; exact `Last-Event-ID` resume within the buffer                | Each instance has its own bus. A write handled by instance A publishes to A's listeners only; a tab whose stream is held by instance B never sees it. `seq` ids are per-process, so a reconnect landing on a different instance reports `gap` and the client does one full poll.                                                                                                                                                                              | **No.** Signals are dataless ("module X advanced"); the client refetches through normal authorized reads. It is lost _instant_ delivery, not leaked or unauthorized data.                                                                                                                |
| 1.6  | Change-stream watcher                                                                | `src/lib/realtime/watcher.ts` — one `db.watch()` per process on `global._decoricksChangeStreamStarted`, a `while(true)` reconnect loop with `for await` + `setTimeout` backoff    | Feeds the bus; degrades to polling if unavailable                                                                        | A function instance is frozen/killed once the request returns; a long-lived `for await` cursor cannot be kept alive. The watcher essentially never runs on serverless. The code already treats it as best-effort and the client falls back to polling.                                                                                                                                                                                                        | **No.** Realtime becomes polling-only; authorization still enforced per request. Feature degrades, security does not.                                                                                                                                                                    |
| 1.7  | SSE route                                                                            | `src/app/api/events/route.ts` — `runtime='nodejs'`, `force-dynamic`, a single `ReadableStream` held open with a 20s heartbeat `setInterval`                                       | One authenticated long-lived stream per tab                                                                              | The platform's function **max duration** bounds the stream (Netlify sync 60s, Vercel Hobby 300s): the connection is killed on the timeout and the browser reconnects (`retry: 3000`). A frozen instance stops the heartbeat, so the proxy may also drop it. Effectively SSE ≈ short-lived stream + reconnect, which combined with 1.6 means realtime is polling with extra steps.                                                                             | **No.** Auth is resolved _before_ the stream opens (`discoverViewScopes` → 401 if no session); no data crosses the wire that the client can't fetch itself.                                                                                                                              |
| 1.8  | In-memory role cache                                                                 | `src/lib/authorization.ts` `cachedRoles`/`cachedAt`, `ROLE_CACHE_TTL_MS = 2_000`, `invalidateRoleCache()` on write                                                                | Caches the role matrix 2s; synchronous invalidation makes revocation instant on a single host                            | Per-instance cache. A revocation performed on instance A is not pushed to instance B, so B can serve a stale matrix **for up to 2 seconds**. The code _documents_ this as intended for the multi-instance case ("the short TTL is only a safety net ... (Vercel serverless, SPEC §8.1)").                                                                                                                                                                     | **Marginal, bounded.** Worst case is a 2s window where a just-revoked permission still applies on an instance that didn't do the write. Same risk exists today if a DB edit is made out-of-band. Acceptable, but worth knowing.                                                          |
| 1.9  | MongoDB client + connection pool                                                     | `src/lib/mongodb.ts` — module-level `client`/`clientPromise`; `global._mongoClientPromise` reuse is **dev-only**; production uses the module var. `maxPoolSize:10, minPoolSize:2` | One pooled client per process; 2 warm connections avoid the ~300-400ms handshake on the first request after idle         | Every cold instance opens its **own** fresh pool (up to 10 conns). Many concurrent cold starts = a connection storm against the Atlas cluster. On M0 (limited concurrent connections) this can hit connection ceilings. The `globalThis` reuse does **not** help across serverless invocations, and a frozen instance may keep sockets that Atlas has already reaped (handled by `resetMongoClient`/`withMongoRetry`, at the cost of a failed first attempt). | **No** (correctness/reliability + a **capacity** risk). `minPoolSize:2` is the opposite of serverless-friendly (holds idle sockets). Not a data-exposure issue, but a scaling and M0-limit issue.                                                                                        |
| 1.10 | Process TZ pin                                                                       | `src/instrumentation.node.ts` `pinKarachiClock()` sets `process.env.TZ='Asia/Karachi'` if unset                                                                                   | Whole date layer assumes an Asia/Karachi process clock                                                                   | Runs at cold start per instance (fine), but a platform that **pins `TZ=UTC`** makes it a no-op and every stored timestamp shifts +5h (measured in Phase 5 §7). This is a data-correctness hazard independent of the process-global issue.                                                                                                                                                                                                                     | **No** for serverless _if_ `TZ=Asia/Karachi` is set explicitly; **yes** if the platform forces UTC. Flagged because serverless hosts commonly hand you UTC.                                                                                                                              |
| 1.11 | Misc logging singletons                                                              | `announcedDatabase`, `loggedOpen`, `loggedUnsupported`, `streamOpen/streamGaveUp`                                                                                                 | Log-once guards                                                                                                          | Harmless; they just log once per process. No correctness/security impact.                                                                                                                                                                                                                                                                                                                                                                                     | **No.**                                                                                                                                                                                                                                                                                  |

**Bottom line of §1.** Nothing here becomes a _privilege-escalation_ or
data-leak path on serverless: authentication (session cookie → DB lookup),
authorization (`authorize` on every route), the DB-backed lockout, and auditing
all survive because their state is in MongoDB. What degrades is (a) the accuracy
of the per-IP **throttle** limiters, (b) all **realtime** behaviour (SSE + change
stream → polling), and (c) **connection-pool** efficiency. The one item with a
real, if bounded, security flavor is 1.8 (≤2s stale revocation across instances).

---

## 2. Smallest safe changes (proposed, NOT implemented) + effort & risk

Ordered by value. None are implemented in this task. "Effort" is rough
engineer-time for a change + tests; "Risk" is the chance of a regression to
current (persistent-host) behaviour.

| Change                                                 | What it is                                                                                                                                                                                                                                                                                                                                                                                                | Touches                                                                                      | Effort                      | Risk        | Notes                                                                                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Mongo-backed rate limits (login + admin first)**  | Replace the `Map` in `SlidingWindowRateLimiter` for `loginRateLimiter` and `adminRateLimiter` with an atomic counter document per key + a **TTL index** (mirror the existing `loginAttempts` pattern). One `findOneAndUpdate({$inc}, {upsert:true, setOnInsert:{expiresAt}})` per request; `retryAfter` from the doc's window start. Keep the chat/search limiters in memory (volume only, not security). | `src/lib/rate-limit.ts` (+ a `RateLimitAttempt` model + index in `ensureAuthIndexes`)        | **M** (~0.5–1 day + tests)  | **Med**     | Adds one write per auth/admin request (must be cheap + tolerant like `loginAttempts`). Do login & admin first per the brief; change-password is the same helper.                         |
| **B. Serverless-safe Mongo client**                    | Make the `globalThis` reuse apply in **production too** (it already exists for dev) so a warm instance reuses its pool across invocations; add a small `maxPoolSize` (e.g. 1–2) and **drop `minPoolSize` to 0** on serverless so idle instances don't hold sockets the platform may freeze. Gate the tuning on an env flag so the Render persistent host keeps `minPoolSize:2`.                           | `src/lib/mongodb.ts` `driverOptions()` + the `NODE_ENV` branch in `getClientPromise`         | **S** (~2–4h + tests)       | **Low**     | The pool-reuse-on-production change is tiny; the real decision is `minPoolSize` per host. Do **not** lower it for Render (its first-request-after-idle cost is the whole reason it's 2). |
| **C. Disable SSE on serverless, use polling**          | Add an env gate (e.g. `DECORICKS_REALTIME=poll`) that makes `/api/events` return `405`/short-response and stops `ensureChangeStreamWatcher()`; the client coordinator already has a polling fallback. This is the _documented_ degradation, just made explicit instead of emergent.                                                                                                                       | `src/app/api/events/route.ts`, `src/lib/realtime/watcher.ts`, client `sync/sse-transport.ts` | **S–M** (~half day + tests) | **Low–Med** | Must confirm the polling cadence is acceptable UX (updates lag to the poll interval). No change to authorization.                                                                        |
| **D. Tighten role-cache staleness for multi-instance** | Either shorten `ROLE_CACHE_TTL_MS` (e.g. 2s → ~1s) on serverless, or move to an etag/version stamp on the `roles` doc so a check is one indexed read only when the version changed. The current design already self-documents 2s as the safety net.                                                                                                                                                       | `src/lib/authorization.ts` `getRoles`                                                        | **S** (~1–3h)               | **Low**     | Optional; 2s is already small. Only do this if the ≤2s revocation window in 1.8 is deemed unacceptable.                                                                                  |
| **E. Force `TZ=Asia/Karachi` on the platform**         | Not code: set `TZ=Asia/Karachi` in the host env (already required for Render in `docs/DEPLOYMENT.md` §10). Verify `warnIfClockIsNotKarachi()` stays silent.                                                                                                                                                                                                                                               | deployment config only                                                                       | **XS**                      | **Low**     | Critical correctness gate regardless of §1; serverless hosts hand you UTC by default.                                                                                                    |

Effort scale: XS < 1h, S = 2–4h, M = ~1 day, L = multi-day. Risk is relative to
the _current_ persistent-host build staying correct (all these must be env-gated
so Render behaviour is unchanged).

---

## 3. Official platform limits (verified, with quotes)

Verified from the platforms' own documentation as of **October 2026**. Each line
is quoted or closely paraphrased from the cited page.

### 3a. Netlify

**Function execution limits** — [docs.netlify.com/build/functions/configuration](https://docs.netlify.com/build/functions/configuration/), limits table:

- "**Synchronous execution limit — 60 seconds**"
- "**Scheduled execution limit — 30 seconds**"
- "**Background execution limit — 15 minutes**"
- "**Buffered request/response payload — 6 MB**" · "**Streamed response payload — 20 MB**" · "**Background request/response payload — 256 KB**"
- Default function region is `cmh` (Ohio): "Netlify deploys functions for new sites to `cmh` (Ohio)". (Atlas is in Mumbai — an ~70–150ms geographic penalty per round trip unless the region is moved.)

**Next.js support** — [docs.netlify.com/frameworks/next-js/overview](https://docs.netlify.com/frameworks/next-js/overview/):

- "Netlify supports all major Next.js features with zero configuration, via our open-source **OpenNext adapter**. This adapter is thoroughly tested with every Next.js release."
- "we actively maintain the adapter to support **all Next.js versions starting from version 13.5**" → **Next 15 (our `^15.1.4`) is supported.**
- Feature matrix marks App Router, SSR, Route Handlers, **Response Streaming**, Server Actions, Middleware all "**Full Support**".
- Limitations relevant here: "**Edge Runtime Support:** SSR pages using the edge runtime run in your functions region with the Node.js runtime, rather than in edge locations." Middleware limitations: "Node.js Middleware: C++ Addons are not supported, Filesystem is not supported." (our `src/middleware.ts` only reads cookies/headers — compatible.)

**Free plan / commercial use** — [netlify.com/pricing](https://www.netlify.com/pricing/) + Netlify blog:

- Pricing is now **credit-based**: "Free — $0 forever … **Credits: 300 credit limit**". Usage costs: "**Bandwidth — 20 credits per GB**", "**Compute — 10 credits per GB-hour**", "**Web requests — 2 credits per 10k requests**", "Production deploys — 15 credits each".
- Commercial use **is** allowed on free: Netlify's launch post "Introducing Netlify's Free plan" states "On the Free plan, you can **deploy commercial projects**, personal sites, or other creative explorations", echoed on Netlify's community answers.

### 3b. Vercel

**Function limits** — [vercel.com/docs/functions/limits](https://vercel.com/docs/functions/limits) (`last_updated 2026-08-24`), with Fluid compute:

- "**Maximum duration — Hobby: 300s default and maximum.** Pro and Enterprise: 300s default, 800s maximum, and 1800s extended maximum Beta."
- "**Maximum memory — Hobby: 2 GB.**" · "Hobby: 2 GB / 1 vCPU."
- Edge runtime: "must **begin sending a response within 25 seconds** ... and can continue streaming data for up to **300 seconds**."
- "The maximum payload size for the request body or the response body of a Vercel Function is **4.5 MB**." Bundle "250 MB". Concurrency "auto-scales up to 30,000 (Hobby and Pro)".

**Free plan / limits** — [vercel.com/pricing](https://vercel.com/pricing) (Hobby $0/mo):

- "**Fast Data Transfer — 100 GB / month** included." · "**CDN Requests — 1M / month**." · "**Function Invocations — 1M / month**." · "**Fluid Active CPU — 4 hours / month**" + "Fluid Provisioned Memory 360 GB-hrs / month". Build Minutes: "Basic machines — Included". Deployment Storage "10 GB". Team "Developer seat — 1".

**Next.js support** — Vercel develops Next.js; Next 15 App Router is a first-class target (not separately quoted here — see "could not verify").

**Commercial use — NOT allowed on the free plan.** Vercel pricing FAQ: "Our **Hobby plan is for personal, non-commercial use.** Pro is designed for professional developers, freelancers, and businesses." Also: "If you have a free Hobby account, you are limited to the usage caps and cannot purchase additional usage." A business internal tool like Decoricks would require the **paid Pro plan** ($20/mo).

### 3c. What I could NOT verify

- **Netlify legacy hard numbers.** The current pricing page expresses free limits as **300 credits** with per-feature credit costs, not the older "100 GB bandwidth / 300 build minutes" figures; I could not find an authoritative page confirming those legacy numbers still apply, so they are omitted.
- **Netlify default vs max per-invocation duration.** The configuration page states the _execution limit_ (60s sync); I did not find a distinct "default" (e.g. 10s) figure on that page, so only the ceiling is quoted.
- **Netlify free-tier concurrent-function-execution cap** and **exact compute minutes** under credits — not clearly stated on the pages read.
- **A dedicated Vercel "Next.js 15 is supported" compatibility page.** Vercel ships Next.js, so support is implicit; I did not open a specific version-matrix page.
- Whether either free plan's egress **IP ranges** are stable enough for Atlas Network Access allow-listing (Netlify Private Connectivity static IPs "available in only some regions", Vercel Static IPs are a paid Pro/Enterprise feature) — a real constraint for securing the Atlas user, not re-verified against a firewall matrix here.

---

## 4. Cold-path measurement (local, `decoricks_dev` only)

Method: a throwaway Node script (since deleted) opened a **fresh `MongoClient`**
with the app's exact `driverOptions` (simulating a cold instance), attached the
driver's command monitoring, and ran each endpoint's read pipelines verbatim. It
performed **reads only** — the dashboard route's fire-and-forget notification
sweep was deliberately omitted because it inserts rows. Nothing in `decoricks_dev`
was modified. Host network → Atlas `ap-south-1` (Mumbai).

Round-trip counts are **exact** (command monitoring includes `getMore`, so cursor
batching is visible). Latencies carry a caveat: **`decoricks_dev` is a freshly
seeded sandbox** (1 user, 4 roles, 3 accounts, `sessions/products/stock/orders/
transactions/tasks/income/expenses` all **0 docs**), so absolute milliseconds
understate a populated `decoricks_prod`; the _number of round trips_ does not
depend on row counts except for large-collection reads, which only **add**
`getMore` trips as data grows.

| Path                                                                            | Mongo round trips               | Cold (fresh handshake)                          | Warm (pool reuse)                        |
| ------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| **Client `connect()` handshake**                                                | 0 app commands                  | **657–841 ms** (two independent cold instances) | n/a                                      |
| Auth path (session `$lookup` + role `find`) — _paid by every protected request_ | **2** (`aggregate` 1, `find` 1) | first reads **139–147 ms**                      | **134 ms**                               |
| **`/api/dashboard/summary`** (7 parallel aggregates)                            | **7** (`aggregate` ×7)          | —                                               | **446–522 ms**                           |
| **`/api/products`**-style list (find + count + stock agg)                       | **3** (`find` 1, `aggregate` 2) | —                                               | **67 ms**                                |
| **`/api/reports/period`** finance branch (full sorted ledger `find` + accounts) | **2** (`find` ×2)               | —                                               | **135–136 ms** (0 rows; grows with data) |

Derived numbers:

- **Per round trip ≈ 65–70 ms** warm (auth = 2 trips ≈ 134 ms), consistent with the
  `minPoolSize:2` rationale recorded in `src/lib/mongodb.ts` ("a single indexed
  point read costs ~65ms, a read that has to _open_ a connection costs ~300-400ms").
- **Cold penalty ≈ +0.7–0.85 s** purely to open Mongo, _before_ the platform's own
  Node/bundle cold start.
- **A cold `GET /dashboard/summary`** ≈ handshake (0.7–0.85 s) + auth (2 trips) +
  dashboard (7 trips, partly concurrent) ≈ **~1.3–1.5 s of DB-side latency**
  even on an empty DB, plus Next.js function cold start on top. On populated prod
  data the aggregates do more work and the same trip count costs more.

**Which pages feel slowest on serverless (cold):**

1. **Dashboard (`(app)/page`, `/api/dashboard/summary`)** — 9 total trips (auth 2 + 7 aggregates). The heaviest read in the app; every cold visit pays a Mongo handshake plus 7 aggregates.
2. **Weekly/Period summary (`/api/reports/period`) and Finance** — the ledger read is a _whole-collection_ `find`; `scripts/db-probe.ts` documents that it returns the first 101-doc batch and needs **one `getMore` per batch**, so this endpoint's trip count **grows linearly with transaction volume** — the worst scaling on serverless.
3. **Sales/Inventory lists** with count-for-pagination + a stock aggregate — ~3 trips each; acceptable warm, but each rides behind a cold handshake.
4. Everything is fronted by the **auth path (2 trips)** — a page that fans out to several API calls multiplies the handshake amortization only if the instance stays warm, which short-lived instances don't guarantee.

Lightweight, single-read endpoints (e.g. a paged list at 67 ms warm) are fine; the
cost is dominated by (a) the **cold handshake** and (b) the **aggregate/fan-out**
endpoints, both of which are exactly what serverless cold starts expose.

---

## 5. Host comparison (no recommendation)

Assumptions common to all columns: Atlas M0 (Mumbai) for the DB; the app's
`decoricks_app` least-privilege Mongo user; **`TZ=Asia/Karachi` must be set** on
any host (see §1.10 / `docs/DEPLOYMENT.md` §10). Legend: **works** = behaves as on
today's persistent host; **degrades** = functional but reduced; **broken** = the
feature cannot work as designed.

| Dimension                                         | **Render free + keep-alive monitor**                                                                                            | **Netlify free**                                                                                                                          | **Vercel (Hobby)**                                                                    | **Vercel (Pro, if paid)**                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| Runtime model                                     | Single persistent Node process (the current design)                                                                             | Serverless functions (ephemeral instances)                                                                                                | Serverless functions                                                                  | Serverless functions                       |
| Usable for a business/commercial tool?            | Yes (free tier, no ToS bar on internal commercial use of a hobby instance — confirm current Render terms)                       | **Yes** — free plan explicitly allows commercial projects                                                                                 | **No** — "Hobby plan is for personal, **non-commercial use**"                         | Yes (Pro is the business plan, $20/mo)     |
| Function/process duration bound                   | None (long-lived process)                                                                                                       | Sync **60 s**, background **15 min**                                                                                                      | Hobby **300 s** max                                                                   | 300–800 s (+1800 s beta)                   |
| Spins down when idle?                             | Yes — free instance sleeps after ~15 min idle; a keep-alive ping (e.g. hitting `/api/health`, which is now no-DB) keeps it warm | Instances freeze between invocations (platform-managed)                                                                                   | Instances freeze between invocations                                                  | Fluid compute, still ephemeral             |
| SSE `/api/events`                                 | **works** (persistent stream, 20s heartbeat)                                                                                    | **broken→polling** — 60 s ceiling forces reconnect; no persistent stream                                                                  | **degrades** — 300 s ceiling, reconnect loop                                          | **degrades** — same, longer ceiling        |
| Change-stream watcher (`db.watch`)                | **works** (one long-lived cursor)                                                                                               | **broken** — no long-lived process to hold the cursor                                                                                     | **broken**                                                                            | **broken**                                 |
| Realtime UX overall                               | **works** — instant                                                                                                             | **degrades** to polling (client already supports it)                                                                                      | **degrades** to polling                                                               | **degrades** to polling                    |
| Per-IP rate limiters (login/admin/chat)           | **works** (one process)                                                                                                         | **degrades** — diluted ×instances, reset on cold (see §1.1–1.3; needs §2-A)                                                               | same                                                                                  | same                                       |
| Account lockout                                   | **works** (DB-backed)                                                                                                           | **works** (DB-backed)                                                                                                                     | **works**                                                                             | **works**                                  |
| Role cache staleness on revoke                    | **works** (instant via sync invalidation)                                                                                       | **≤2 s** stale on non-writing instances (§1.8)                                                                                            | ≤2 s                                                                                  | ≤2 s                                       |
| Mongo connection pool                             | **works** (`minPoolSize:2` tuned for it)                                                                                        | **degrades** — cold handshake 0.7–0.85 s per instance; pool-per-instance can stress M0 (§1.9)                                             | same                                                                                  | same                                       |
| Next.js 15 App Router                             | works (`next start`)                                                                                                            | **works** — OpenNext adapter, 13.5+                                                                                                       | **works** (first-class)                                                               | works                                      |
| Middleware (cookie gate)                          | works                                                                                                                           | **works** (runs as Edge Function; no fs/C++ — ours is compatible)                                                                         | works                                                                                 | works                                      |
| Cold-start user-visible latency                   | Rare (persistent); ~1 min only after an idle sleep                                                                              | **common** — handshake (§4) + platform cold start on idle visits                                                                          | common                                                                                | common (mitigated by Fluid, still billed)  |
| Free-tier capacity fit for a 4-user internal tool | Comfortable (750 instance-hrs; keep-alive keeps it awake)                                                                       | Credit-based (300 credits): bandwidth/compute/requests all draw from one pool — **could not verify** the exact ceiling for this app (§3c) | 100 GB transfer, 1M invocations, **4 CPU-hrs/active** — non-commercial, disqualifying | Paid; limits are soft ($20 credit + usage) |
| Static egress IP for Atlas allow-list             | Available ranges published                                                                                                      | "Private Connectivity static IPs available in only some regions"                                                                          | **paid** feature (Pro/Enterprise)                                                     | paid                                       |

### What the user will notice (serverless vs Render persistent)

- **Realtime.** Today: changes appear within ~1–2 s via SSE. On Netlify/Vercel: the
  change stream and the long-lived SSE stream cannot persist, so updates fall back
  to **polling** — a remote teammate's new order/message appears after the poll
  interval, not instantly. The "Live" indicator would be misleading unless gated (§2-C).
- **First hit after idle.** On serverless, the first visitor after a quiet period
  waits the Mongo handshake (~0.7–0.85 s) _plus_ platform cold start _plus_ the
  endpoint's own round trips (§4) — most visible on the **dashboard** and **finance/
  period** pages. Render's persistent host only pays a cold start after its ~15-min
  sleep, which the keep-alive monitor avoids.
- **Brute-force throttling.** Slightly weaker on serverless until §2-A lands
  (per-IP limits dilute across instances); the DB lockout still blocks account
  guessing regardless.
- **Nothing else the user can see changes** for auth, permissions, or data
  correctness — those are DB-backed and host-independent, provided `TZ` is set and
  the ≤2 s role-cache staleness (§1.8) is acceptable.

### Pre-existing notes this matches

`docs/KNOWN_LIMITATIONS.md` already records: "SSE/change streams hosting: Requires
persistent Node host; Vercel/serverless not reliable. Polling fallback exists"; and
"In-memory rate limiters … are per-process only … Use Redis/shared store for
multi-instance." This document expands those two bullets into the full inventory
(§1), the concrete mitigations (§2), and the measured cold-path cost (§4).

---

_The §1–§5 evaluation was read-only: no deployment, no code change, no database
write; measurements were taken against `decoricks_dev` only, and it made no host
recommendation. The follow-up turns recorded the operator's decision (§Decision)
and implemented the one non-serverless hardening it asked for — making
`/api/health/database` Founder-only and leak-free — but still deployed nothing._
