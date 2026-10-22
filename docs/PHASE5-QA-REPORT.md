# Phase 5 — Final Production Readiness, Security & End-to-End QA

Date: 2026-10-21 · Branch: `usability-phase-2` · Last commit: `a99b29d` (2026-10-19)
Working tree at the time of measurement: **141 modified files, 35 untracked files — none of it committed.**

Every number below was produced by running something in this repository on 2026-10-21, not
inferred from reading code. Where a claim rests on a command, the command is printed with it.

---

## Verdict

**The application is not production-ready yet, and the reason is not the application.**

Two things stand between this tree and a deploy:

1. **Nothing that was tested exists in Git.** The whole audited tree — every Phase 5 fix, the
   realtime layer, the security specs, the audit tooling — is uncommitted. Netlify builds from the
   repository, so a deploy today would ship `a99b29d`: a build that has none of the fixes verified
   below, including the ones that stop duplicate financial writes and the one that makes finance
   sync at all. This is a deploy blocker, not a housekeeping note.
2. **Four verifications can only be performed against the deployed environment** (§7.4). They are
   listed individually rather than assumed, because each one is a place where a serverless host can
   differ from the production server that was tested here.

Everything that _could_ be verified in this environment was verified, and the suite is green:
**270 passed / 56 skipped / 0 failed** end-to-end plus **781 unit tests** and a clean
lint + typecheck + production build. The skips are scoped guards, not evasions — each of the 22
`test.skip(` sites is quoted in §8.

Sections 1–9 are the evidence. Section 10 is the checklist. "Decisions left to the owner" is the
short list of things that need a product answer, not an engineering one.

---

## 1. Regression audit — every module

### 1.1 What was actually verified, and against which data

The brief asks that every module be verified against **real persisted data**. That request has a
limit in this deployment that must be stated before any green tick is read:

```
$ npx tsx scripts/index-audit.ts
Database: "test" (resolved from MONGODB_DB)
Collections: 31
  products 0    orders 0    tasks 0    stock 0    stockMovements 0    purchases 0
  returns 0     suppliers 0 expenses 0 income 0   transfers 0         budgets 1
  transactions 1 profitDistributions 1 accounts 3 financeCategories 13
  messages 14   chatChannels 3  chatChannelReads 5 notifications 1
  users 4       roles 4     sessions 8  loginAttempts 24  auditLog 533
```

The application database holds configuration and a **single** financial cycle: one ledger row
(₨ 2,500.00 income), one budget, one approved distribution. There are no products, orders, tasks or
stock movements at all. So "the Sales module was verified against real records" would be false, and
the audit does not claim it.

What was verified instead:

- **Real persisted records** — the 1-transaction / 1-budget / 1-distribution cycle, the 4 users, 4
  roles, 13 categories, 3 accounts, 14 chat messages and 533 audit entries — read back through the
  application's own math by `scripts/verify-finance.ts` (§5.3), and displayed by every screen in the
  full-sweep test (§1.2). This is genuine production data, and it reconciles.
- **Operational data at volume** — orders, returns, stock movements, purchases, multi-row ledgers,
  task boards, mentions, archives — created and read back through the real UI against a persistent
  MongoDB database (`decoricks_test`) by the Playwright suite, plus 10,000-row synthetic ledgers in
  the unit suite. Persisted, queried, and re-read after a reload; but not the business's own records.
- **What remains unverified**: the app's behaviour over _real_ accumulated operational history. It
  cannot be verified yet, because there is none. The first weeks of live use are the missing evidence.

### 1.2 Coverage hole found and closed

Grepping the entire e2e suite for the routes it visits found screens that **no test had ever opened**:

| Screen                                                              | Before             | Now          |
| ------------------------------------------------------------------- | ------------------ | ------------ |
| `/profile`                                                          | visited by nothing | in the sweep |
| `/sales/returns`                                                    | visited by nothing | in the sweep |
| `/finance/transactions`, `/finance/accounts`, `/finance/categories` | visited by nothing | in the sweep |
| `/cash-flow`, `/profit-loss`, `/inventory/*` sub-screens            | visited by nothing | in the sweep |

`layout.spec.ts` iterated 10 of the 23 index routes. A new describe block walks **all 23 screens**
and asserts, per screen: HTTP status < 400, `#main-content h1` visible, and — the part that makes it
a regression test rather than a smoke test — **zero** failing `/api/` responses, zero `pageerror`
uncaught exceptions and zero `console.error` across the whole walk:

```
$ npx playwright test src/e2e/layout.spec.ts --project=chromium -g "every screen"
  3 passed (1.2m)
```

Excluded deliberately, with the reason recorded in the test: `/design` (a component gallery that
renders sample data — see "Decisions left to the owner") and `[id]` detail routes, which need a real
id and are covered where they exist (chat, distribution, tasks).

### 1.3 Runtime errors, React warnings, duplicates

From the cold full gate (§8.1) — every `[WebServer]` line the entire run produced, deduplicated:

```
2  [api-refusal] GET /api/dashboard/reconciliation 403 FORBIDDEN: Only the Founder can perform this action
1  [api-refusal] POST /api/products 403 FORBIDDEN: You do not have permission to perform this action
1  [api-refusal] GET /api/tasks 403 PASSWORD_CHANGE_REQUIRED: You must change your password before continuing
1  [api-refusal] GET /api/tasks 401 UNAUTHENTICATED: Authentication required
1  [api-refusal] GET /api/stock/summary 403 FORBIDDEN: You do not have permission to perform this action
1  [api-abort] Error: aborted
1  [instrumentation] process clock is not on Asia/Karachi … 5.00h … Current TZ="UTC".
```

`0` matches for `api-error | Unhandled | MongoServerError | TypeError | deprecat`. Every line above
is a **deliberate refusal asserted by a test**, the abort is the SSE stream being torn down by a
closing tab, and the instrumentation line is the new boot warning firing because the gate is
deliberately run under `TZ=UTC` to prove it detects the hazard (§7.3). Nothing in the run is an
unexplained error, and no React warning reached the console during the 23-screen walk.

Duplicate detection: `verify-finance.ts` reports `no identical rows` on the application database.
Against `decoricks_test` it reports 10 groups of identical rows — every one of them a fixed-date
record the suite re-seeds on each run ("E2E order revenue", "E2E dashboard chart seed"). Explained,
not a defect, and it is why the duplicate check is advisory rather than fatal.

### 1.4 `/design` — sample data still on screen

`src/app/(app)/design/page.tsx` is a component gallery: it renders cards, badges and tables from
hardcoded sample values. It is not demo data pretending to be business data — no module reads it, no
statistic is derived from it — but it _is_ fake content reachable in a production deploy. Removing
it was **not** done because it is a product decision, not a defect fix. See "Decisions left to the
owner".

---

## 2. Authentication and security

### 2.1 Authorization coverage, measured at the source

`scripts/route-audit.mjs` parses all **87 route files / 128 exported handlers**, grows each
handler's range over the file-local helpers it calls (most routes guard inside `loadX()`/`saveX()`
helpers, so a naive per-function scan mislabels them), and records which controls are reachable:
`guard`, `validation`, `audit`, `retry`. Result: **every handler that touches data is guarded at
source**; the families flagged for manual reading were read by hand and are covered by the HTTP
tests below. A source scanner can show a guard is present; it cannot prove it executes — which is
why the second phase of the audit is HTTP requests, and why `phase10-security.spec.ts:119` says so
in a comment rather than claiming proof.

### 2.2 Live behaviour, with two real authenticated accounts

`src/e2e/phase10-security.spec.ts` drives the **production build** (`next start`, `NODE_ENV=production`)
with separate sessions for a Founder and a Partner (`partner_afnan`). All 7 tests pass on all three
projects. These are API-access assertions, not UI-visibility assertions:

| Test                                                                                        | What it establishes                                                                                             |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| anonymous requests are refused on every module API, and nothing is written                  | 401 across the API surface, and the refusals are _side-effect free_ — the collections are re-counted            |
| a Partner is refused Founder-only APIs, and the refusal carries no data                     | 403 + response body contains no records (reconciliation, users, roles, audit log, products POST, stock summary) |
| a state-changing request without a CSRF token is refused before it can write                | 403 on an unsafe `/api/` method through the real middleware                                                     |
| another session's CSRF token is refused — replay across accounts fails                      | cross-account token replay fails                                                                                |
| malformed input, unknown ids and invalid params fail with the right status and leak nothing | 400/404 shapes; no stack, no Mongo error text, no query echoed                                                  |
| five failed logins lock the account, and the lock refuses even the correct password         | rate limiting is enforced _after_ the fifth failure, including for the right password                           |
| deactivating a user kills the session they already hold                                     | revocation is effective on the next request, not at next login                                                  |

Grant/revoke was tested with the actual API, not the sidebar: `phase11-sync.spec.ts:298` asserts that
a revoked permission is absent from a **new stream** and absent from the **cursor payload**, so the
module's data stops arriving rather than merely disappearing from a menu.

### 2.3 Sessions, cookies, and what was deliberately left alone

Verified in code and behaviour:

- `decoricks_session` — `httpOnly`, `sameSite=lax`, `secure: NODE_ENV === 'production'`, server-side
  record in `sessions` indexed `sessions_tokenHash` (unique); token stored as a hash, not raw.
- Sliding inactivity window (`SESSION_TTL_MINUTES` default 7 days) with a 60-second slide floor, so
  the realtime poller cannot turn into a write storm.
- `decoricks_csrf` is readable by design (the client must send it as a header); the session cookie is
  not.
- `E2E_TEST_MODE` gates **only** the test-database resolution — it is not an authentication shortcut.
  Grepping for dev-only auth bypasses found none. Passwords are bcrypt with cost 12, minimum length
  12 with complexity, and `PASSWORD_CHANGE_REQUIRED` is enforced at the API layer (visible in §1.3's
  403).
- Errors reaching clients are the app's safe envelope (`api-response.ts`); §1.3 shows no stack or DB
  text in any response during the run.

**CSRF fail-open, unchanged on purpose.** `assertCsrf` returns without checking when the
`x-csrf-required` marker is absent from the request headers. The marker is stamped by
`middleware.ts`, so on any request that reaches the handler through the normal chain the guard is
live — and `phase10-security.spec.ts:234` proves the refusal works against the real production
server. Inverting it to fail-closed would mean every handler invoked _without_ the middleware (30+
API unit tests call route functions directly) would start refusing legitimate traffic; on a
mis-deployed Edge Function the blast radius is the whole application. The change is not free of
outage risk, it is not needed by any measured defect, so it is reported as a **residual risk with a
production verification step** (§7.4 V3) instead of being smuggled into a QA pass.

---

## 3. Cross-device real-time synchronisation

### 3.1 Tested, with separate authenticated sessions

Two and three **browser contexts with independent authenticated sessions** against the production
build. `phase11-sync.spec.ts` (6 tests) and `phase7-realtime.spec.ts` (3) pass on all projects; the
board and chat repaint tests are chromium-only by design.

| Test                                                                                      | Establishes                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| the live path is an open SSE stream, scoped to the caller's own permissions               | the stream is real and authorized per-user, not a global firehose  |
| inventory: a remote create, count and archive update the open list with no reload         | create / update / **delete-adjacent** (archive) propagate live     |
| sales: a remote order and its cancellation reach the watching session live                | order write and its cancellation                                   |
| finance: a remote ledger entry moves the on-screen balance to the authoritative figure    | financial figures converge on the server value, not a client guess |
| a revoked permission leaves the module out of a new stream and out of the cursor          | permission changes propagate                                       |
| with the stream blocked the page still syncs, and returns to Live without losing a change | the polling fallback carries the product                           |

`phase3-collab.spec.ts` covers mentions (including "a mention of someone who is not an active chat
member stores text but alerts nobody") and channel archive/restore across devices;
`phase7-realtime.spec.ts` covers cursor advancement between sessions and that the cursor endpoint is
auth-gated and module-scoped.

### 3.2 The defects found here, and the fix each one got

Four genuine defects were in this layer. Each was reproduced by a test that failed first.

1. **Finance had no live signal at all.** `COLLECTION_MODULES` mapped the finance module to
   `ledger`, a collection that exists in no database. Every ledger write was published under a
   namespace the change stream never reports, so finance refreshed only on the poll.
   → `src/lib/realtime/types.ts` now maps `transactions: 'finance'`.
2. **Cold start swallowed the baseline.** The SSE route could emit a `cursor` frame before
   `db.watch()` had opened, so the client adopted a baseline that no live signal could ever exceed —
   a silently dead stream. → readiness handshake `awaitChangeStreamOpen(3000)` in
   `src/lib/realtime/watcher.ts`, and the baseline is now taken only after the stream is open.
3. **Pre-subscribe changes were lost.** A change landing between the page's initial fetch and the
   stream subscription was never applied, because the first snapshot's cursor was treated as
   redundant. → `src/lib/realtime/coordinator.ts` revalidates on the **first** snapshot instead of
   swallowing it.
4. **Same-second writes collapsed.** `clusterTime` has one-second resolution, so two changes in the
   same second produced one indistinguishable signal and the second was dropped. → monotonic
   per-module `ts` in `watcher.ts`, with a regression test.

### 3.3 What is _not_ verified, stated plainly

The suite runs multiple browser contexts against **one** `next start` process on **one** host. That
proves the protocol, authorization scoping, dedup, reconnect and stale-response handling. It does
not prove behaviour on physically separate devices over a network, and it does not prove anything
about Netlify's serverless runtime — where a Function instance cannot hold an open `db.watch()`
across invocations.

`phase11-sync.spec.ts:365` ("with the stream blocked the page still syncs") is the closest available
substitute for the serverless case, and it is green: when the stream carries nothing, the ~6-second
poll takes over and no change is lost. **The production carrier on Netlify is polling, not SSE**
(§7.2). That is a design consequence of the platform, verified as a fallback, and it should be
accepted explicitly rather than discovered on launch day.

---

## 4. Demo data, test data, and dev-only shortcuts

### 4.1 Two real defects in the _tools that delete and seed_

These are the findings that mattered here. Both were in operational scripts, and both produced
**false reassurance**.

**`scripts/cleanup-e2e-data.ts` swept a namespace that has never existed.** It deleted
`chatMessages` / field `text`, while the real collection is `messages` and the body field is
`content` (`src/lib/models/Chat.ts`). A dry run therefore printed "none found" for the one place
e2e chat data actually lives. A cleaner that reports a false zero is worse than no cleaner, because
the next step is `--apply`.

Fixed: correct collection and field, `chatChannels` added, and a sweep now says
`COLLECTION ABSENT — nothing was checked, do not read this as clean` instead of `0`, so an unexamined
namespace can never be reported as a pass. Verified in both directions:

```
$ npx tsx scripts/cleanup-e2e-data.ts                    # application database
   … every namespace: 0                       ← genuinely clean
$ MONGODB_DB=decoricks_test npx tsx scripts/cleanup-e2e-data.ts
   119 e2e records + 12 marker products       ← the scan is live, not decorative
```

**`scripts/seed.ts` guarded half of what its comment claimed.** The comment said it refuses to point
the seed at a test database "and vice versa", but only `MONGODB_TEST_DB` was checked. Setting the
_application_ variable at a test database bypassed it entirely, and the seed writes roles, a Founder
and SPEC financial defaults:

```
$ MONGODB_DB=decoricks_test npx tsx scripts/seed.ts     # before the fix
   Seeded 4 roles … completed        ← it ran, against the test database
```

The accidental run was checked afterwards: harmless (`$setOnInsert` only, the policy backfill is
filtered on `profitSharing: {$exists: false}`, the Founder was left untouched) — but that is luck
about which fields are idempotent, not a guard. Fixed by refusing on the **resolved database name**
after connect, which covers `MONGODB_DB`, the URI path and `MONGODB_TEST_DB` at once. Verified:
`decoricks_test` → exit 1 refused; `test_phase5` → exit 1 refused; the application database `test` →
exit 0 accepted (a bare `test` is deliberately _not_ test-shaped, because that is where the real
records live — `src/lib/db-name.ts`, pinned by `db-name.test.ts`).

The reciprocal guard was already correct and was proven rather than assumed:
`E2E_DB=test npx tsx scripts/seed-e2e.ts` → `Refusing to seed "test"…`, exit 1.

### 4.2 Mock data, dev-only shortcuts, seeds that could reach production

- **Dev-only shortcuts**: `E2E_TEST_MODE` affects only test-database resolution (§2.3). No auth
  bypass, no fake API response, no `TODO`-time stub was found in `src/app/api`.
- **Unit-test fakes** live in `src/lib/__tests__` and `src/test/setup.ts` and are not reachable from
  the app.
- **Seeds**: `npm run seed` targets the resolved application database and now refuses test-shaped
  names; `npm run seed:e2e` can only ever target a test-named database and refuses one that the app
  also resolves to (`assertTestTarget`). `scripts/diag-cursor-domain.mts`, `index-audit.ts`,
  `db-inventory.ts` and `verify-finance.ts` are read-only by construction.
- **Genuine records preserved**: the audit deleted nothing. `npm run cleanup:e2e` was run as a dry
  run only, and `--apply` was never executed against the application database. The application
  database's 31 collections still contain exactly the §1.1 volumes, including the 1-transaction
  financial cycle and the 533 audit entries.

### 4.3 Data needing the owner's approval before it is touched

Nothing was removed, so nothing is pending approval. Two things are worth a decision:

- `loginAttempts` (24) and `auditLog` (533) in the application database are pre-Phase-5 history from
  testing against the live database. They are legitimate application artefacts; deleting them would
  remove audit history, so it is left alone.
- `sessions` (8) holds live sessions. If any of those belong to a test run against the application
  database, revoking them is a Founder action, not a script.

---

## 5. Database reliability and financial integrity

### 5.1 Indexes: what the server actually holds

Indexes in this app are created lazily by `ensure*` helpers on first touch, so "the code declares an
index" is not the same statement as "the database has it". `scripts/index-audit.ts` asks the server:

```
$ npx tsx scripts/index-audit.ts
-- unique business keys --        9 of 9 OK
-- idempotency guards --          8 of 8 OK
-- unique index specs --         33 listed, with `sparse` printed for each
Missing unique indexes: 0
```

The `sparse` column matters: a unique index that is not sparse treats a _missing_ key as the value
`null`, and only one such document may exist — which is §5.2's first defect. Listing specs rather
than names also catches an index that exists under one name but is not actually unique.

`tasks.taskNumber_1` sits under a different name than the code declares (`tasks_taskNumber_unique`).
The server's copy **is** `unique + sparse`, so the guarantee is present and the drift is cosmetic:
`createIndexTolerant` (`src/lib/models/indexes.ts`) swallows codes 85/86 per index, so one
already-existing index cannot reject the rest of the batch. Recreating it under the declared name is
an optional cosmetic action and is on the approval list.

### 5.2 Duplicate prevention, verified in the data rather than the intent

The Phase 5 review found that **`idempotencyKey: undefined` serialises to BSON `null`**, and the
unique indexes are sparse. The first keyless write to a collection therefore planted a `null` row,
and _every later keyless write died on E11000 and surfaced as a misleading "already exists"_. Nine
write paths were affected (`src/lib/idempotency.ts` now centralises the rule: a keyless insert omits
the field entirely, so it stays out of the index and a genuine replay of a real key is still
rejected). `verify-finance.ts` still asserts no stored row carries `idempotencyKey: null`, on both
databases: **0 found**.

Duplicate-request behaviour is tested where it matters financially:
`phase9-offline.spec.ts` — "a mid-sync kill replays with the same key — still one row" and "two tabs
share one queue: a single drain, one landed row"; both green on all three projects.

### 5.3 Financial calculations against the stored records

A new instrument, `npm run verify:finance` (`scripts/verify-finance.ts`), re-runs the application's
own math over the **documents as stored**. It is read-only, and it prints the row counts it examined
before any result, because "the figures match the transactions" is only as strong as the data it was
said about.

```
$ npm run verify:finance                       # application database
Database: "test" … Configuration: 3 accounts, 13 categories
-- ledger (1 rows) --        row shape ok · no identical rows · revenue 250000 − expense 0 = net 250000
-- budgets (1 rows) --       totalBudgeted equals the sum of its categories
-- profit distributions (1)  split balance ✓ (all 250000 paisa accounted) · p&l chain recomputes ✓
                             split re-derives ✓ · recompute equals its own ledger at approval ✓
0 failing, 1 advisory (no reversal pairs in this data — this proves nothing)
```

Against `decoricks_test`, the same checks run over **205 ledger rows, 11 budgets and 3
distributions**: `row shape` valid for all 205, **22 reversal pairs netting to exactly zero**, no
account overdrawn, every budget's `totalBudgeted` equal to the sum of its category lines, every
distribution's partner + charity + retained equalling `netProfit` to the paisa, and each stored
snapshot re-derivable through `recomputeShares` — the same function the approve/adjust routes use.
**0 failing.**

The tool earned its keep while being written. Its first version compared a stored distribution
against the ledger _as it stands today_ and reported 18 discrepancies. That was wrong semantics, not
wrong data: an approved distribution is a **frozen snapshot** (SPEC §5.9), so rows written into the
month afterwards are history, not corruption. The check was rewritten to compare against the rows
that existed at the snapshot instant, holding that snapshot's COGS constant — which still catches
the genuinely dangerous case (a posted row edited or deleted underneath an already-paid-out figure)
while reporting the ordinary case as information. The FAIL path is proven live: those first 18
findings printed, and the exit code turned non-zero.

### 5.4 Connections and transaction boundaries

- Pool: `maxPoolSize 10`, `minPoolSize 2`; `global._mongoClientPromise` reuse is development-only, so
  a production process never shares a client across hot-reloads it does not have.
- Multi-document financial writes run under `withMongoRetry` (transient-outage retry) with the
  idempotency key as the replay guard — the retry cannot create a second row (§5.2).
- `MongoServerError` appeared **0 times** in the full gate's server output.

---

## 6. API and backend verification

**Status codes.** §1.3 is the complete server-output signature of the entire gate: six deliberate
4xx refusals that tests assert, one aborted-stream notice, and the intentional clock warning. **No
5xx at all**, and no recurring 4xx that needed investigating — each line above maps to a named test.

**No fake 200s.** `phase10-security.spec.ts` asserts the _refusal_ shape and then asserts nothing was
written, so a 200 with an empty body could not pass as "handled". §1.2's screen walk fails the build
on _any_ `/api/` response ≥ 400, so a silently failing endpoint on a screen that renders anyway is
caught.

**Diagnostic logging hygiene (fixed).** Route failures previously logged a full stack for expected
4xx refusals, which buries real faults in noise. `src/lib/http.ts` now separates the two classes —
`[api-refusal] METHOD /path STATUS CODE: message` on one line without a stack, `[api-error]` with a
stack and the request id for 5xx — pinned by
`src/lib/__tests__/http-log-hygiene.test.ts`. §1.3 is the observable result: five refusal lines, no
stacks, and the grep for `Unhandled|api-error` returning zero.

**Client-facing safety.** No stack traces, no Mongo error text and no query details in any response
body during the run (§2.2's leak test covers the malformed-input and unknown-id paths).

---

## 7. Production build and deployment readiness

### 7.1 Build gates, all green on the final tree

```
npm run typecheck        ✔   (tsc --noEmit, no output)
npm run lint             ✔   ✔ No ESLint warnings or errors
TZ=UTC npm run build     ✔   (production build succeeds under a hostile TZ)
npm run test             ✔   781 tests / 50 files, EXIT=0
npx prettier --check <every file this phase touched>   ✔   (8 scripts/sources + this report)
```

**Formatting, stated exactly.** `npx prettier --check .` over the whole repository is **not** green:
161 files are unformatted, 106 of them under `src/app` and `src/lib`. That is pre-existing — it long
predates Phase 5, and `npm run verify` has no formatting gate, so nothing enforced it. Every file this
phase created or edited is formatted and was checked as such, but this report does not claim a
repo-wide style pass it did not perform, and it did not reformat 106 unrelated app sources as a side
quest. Adding a `format` gate to `verify` is a one-line decision for the owner, best taken before the
debt grows further.

### 7.2 Netlify: what the platform needs, and what it forbids

Verified against the Netlify Next.js runtime docs and this repository's shape:

| Fact                                                                                      | Consequence here                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@netlify/next` is installed automatically; `command = "next build"`, `publish = ".next"` | No adapter to add. **There is no `netlify.toml` in this repository — it must be created for the deploy.**                                                                              |
| **Standalone mode is not required**                                                       | Nothing to change in `next.config.js`, which currently sets only `reactStrictMode` and `allowedDevOrigins`                                                                             |
| App Router route handlers → Netlify Functions                                             | All 87 route files become functions; each invocation is short-lived                                                                                                                    |
| `src/middleware.ts` → a **Netlify Edge Function**                                         | The CSRF marker stamping and route protection run on Edge — verify on the deployed URL, not locally (§7.4 V2)                                                                          |
| **Synchronous function timeout: 60 s**                                                    | A long-lived SSE response cannot survive as a normal function. `GET /api/events` must be treated as streaming, and any request that can exceed 60 s must move to a background function |
| **Streamed payload limit: 20 MB**                                                         | Bounds exports, not this app's JSON                                                                                                                                                    |
| `NEXT_PUBLIC_*` is inlined **at build time**                                              | `NEXT_PUBLIC_VAPID_PUBLIC_KEY` must exist before the build or push silently disables itself — now documented in `.env.example`                                                         |
| No `.nvmrc`, no `engines` field; local Node is v26.8.1                                    | Pin a runtime version in `netlify.toml` so the build does not silently move to a different Node                                                                                        |

`/api/events` already declares `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`, so Next will not
try to cache the stream. **The architectural conclusion stands regardless: on Netlify the realtime
carrier is the ~6-second poll, with SSE best-effort.** That is already the design (§3.3) and the
fallback is tested green — but the deploy will change which one is load-bearing, and the owner should
know that before launch, not after.

### 7.3 Environment separation

- `MONGODB_TEST_DB` must **never** be set in a deployed environment; it is test-runner-only and is
  refused outside a test runner (`src/lib/db-name.ts`).
- `MONGODB_DB` should be set **explicitly** in every environment. Left unset, the Atlas "Connect" URI
  (empty path component) makes the driver fall back to a database literally named `test` — which is
  exactly how the application database came to be called that here. Setting it removes the ambiguity
  for new deployments; changing it on the existing deployment would point the app at an empty database
  and must not be done casually.
- **`TZ` must be `Asia/Karachi` or unset** on every host. This is the sharpest deployment hazard
  found in Phase 5, and it is measured, not suspected. `getKarachiDate()` derives a civil date from
  the process zone name, so an equivalent offset under a different zone name is _not_ enough:

  | Process `TZ`        | Drift of `getKarachiDate()` from the true instant  |
  | ------------------- | -------------------------------------------------- |
  | `Asia/Karachi`      | −0.000 h                                           |
  | unset (pin applies) | −0.000 h                                           |
  | `UTC`               | **+5.000 h**                                       |
  | `Asia/Lahore`       | **+5.000 h** — same +05:00 offset, wrong zone name |

  A five-hour shift moves every civil-day boundary, which is what the finance layer derives daily
  totals, weekly summaries and Karachi-month distribution periods from. Netlify's runtime clock is
  UTC, so **this must be set explicitly** — and the pin in `pinKarachiClock()` only applies when `TZ`
  is _unset_, because an explicit value is respected rather than overridden.

- Fixed: `src/instrumentation.node.ts` now warns at boot when the derived date disagrees with the
  true instant by more than a minute, printing the measured drift and the current `TZ`, so this
  cannot be discovered from a wrong report weeks later:
  `[instrumentation] process clock is not on Asia/Karachi: … 5.00h … Set TZ=Asia/Karachi (an
equivalent offset under another zone name is not enough) …`
  Verified in three real production boots (warns under `TZ=UTC`, silent under `Asia/Karachi`, silent
  with `TZ` unset) and pinned by `src/lib/__tests__/instrumentation-clock.test.ts` (5 tests,
  including the `Asia/Lahore` trap).
- Cookies become `secure` only under `NODE_ENV === 'production'`; on Netlify that requires the HTTPS
  deploy (default) and a build with `NODE_ENV=production`.
- **No secret values were printed or committed in this audit.** `.env.local` is untouched and ignored.

### 7.4 Verifications that can only be completed on the deployed environment

| #   | Verification                                                                                                                                | Why it cannot be done here                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| V1  | `TZ=Asia/Karachi` effective in the running function (daily totals and the weekly summary land on the right civil day)                       | The local host is already on `Asia/Karachi`; only the deployed UTC host exercises the hazard                           |
| V2  | `middleware.ts` as an **Edge Function**: unauthenticated pages redirect, and `x-csrf-required` reaches the Node handler                     | Next's Edge runtime here is simulated; Netlify's Edge Function has a different runtime                                 |
| V3  | A state-changing `/api/` request **without** `x-csrf-token` returns 403 on the deployed URL                                                 | Proven against `next start` locally (§2.2); the deployed chain includes the platform Edge layer and CDN in front of it |
| V4  | Session cookie is `Secure` + `HttpOnly` over HTTPS, and `/api/auth/login` works behind the CDN                                              | Requires a real HTTPS origin                                                                                           |
| V5  | `/api/events` either streams or is absent without breaking sync; the poll carries it                                                        | 60 s function limit is a platform property, not reproducible locally                                                   |
| V6  | MongoDB Atlas reachability from a Function instance (network access list, connection reuse, change-stream privileges for the serverless IP) | Local runs use a developer network path                                                                                |

Also outstanding for launch, and not verifiable by any test: **push notifications**. `VAPID_PRIVATE_KEY`
/ `VAPID_SUBJECT` are unset, so `deliverPush` is a silent no-op by design; the in-app path is tested
(`phase9-notifications.spec.ts`), Web Push is not, and cannot be until keys exist.

---

## 8. Automated and manual QA results

### 8.1 The gate (cold, from seed → build → start)

`npx playwright test`, full 3-project run, database seeded first, **production build**, server started
with `NODE_ENV=production E2E_TEST_MODE=1 MONGODB_TEST_DB=decoricks_test`:

```
326 collected   [setup] 2 · [chromium] 108 · [Mobile Chrome] 108 · [Tablet] 108
270 passed
 56 skipped
  0 failed
EXIT=0    8.8m
```

### 8.2 Passed / failed / skipped / could-not-run — with reasons

- **Failed: none.**
- **Could not run: none.** Everything the suite covers ran, cold, against a production build.
- **Skipped: 56, all scoped, none hiding a failure.** All 22 `test.skip(` sites in the suite are
  `project.name !== 'chromium'` guards (verified: 0 unconditional skips, 0 `test.fixme`). 28 tests
  are desktop-only by design — multi-context realtime and performance measurement, which the
  emulated mobile/tablet projects would run three times without testing anything additional — and
  they appear twice each in the other projects as skips.
- **Unit: 781 tests / 50 files green under the host `TZ` _and_ under `TZ=UTC`.**
- **Manual QA on three form factors:** the responsive matrix is automated, not eyeballed — 8
  viewports (320/375/390/414/768/1024/1280/1440) × every route, asserting no horizontal overflow and
  correct shell/drawer behaviour, run under desktop, Mobile Chrome and Tablet projects. Keyboard
  access (skip link first tab stop, every interactive control has an accessible name), drawer focus
  trapping, Escape-to-close with focus restoration and modal opacity are asserted in
  `layout.spec.ts`.
- **Realtime/permission propagation** is exercised with two and three contexts; the mobile/tablet
  projects cover layout and interaction, not a second physical device (§3.3).

### 8.3 Per-area coverage (chromium, 108 tests)

| Spec                                                                                                 | Tests  | Area                                                        |
| ---------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------- |
| `layout.spec.ts`                                                                                     | 31     | shell, responsive matrix, a11y, **all 23 screens**          |
| `usability-help.spec.ts`                                                                             | 10     | contextual help, terminology, phone-readable reconciliation |
| `phase4-performance.spec.ts`                                                                         | 9      | route budgets, collapsed rail                               |
| `phase3-finance.spec.ts`                                                                             | 8      | ledger CRUD, reversal, balances, export                     |
| `phase8-reports.spec.ts`                                                                             | 7      | P&L, cash flow, Founder-only reconciliation                 |
| `phase10-security.spec.ts`                                                                           | 7      | §2 above                                                    |
| `phase11-sync.spec.ts`                                                                               | 6      | §3 above                                                    |
| `phase8-dashboard.spec.ts` / `phase7-chat.spec.ts` / `phase3-collab.spec.ts` / `phase2-auth.spec.ts` | 4 each | dashboard, chat, mentions/archives, auth flows              |
| `phase9-offline.spec.ts` / `phase7-realtime.spec.ts` / `phase4-budget-profit.spec.ts`                | 3 each | offline queue + replay, cursor, budget/profit               |
| `phase6-board.spec.ts` / `phase5-inventory-sales.spec.ts`                                            | 2 each | task board, inventory + sales                               |
| `phase9-notifications.spec.ts`                                                                       | 1      | notification bell                                           |

---

## 9. Fixes, in priority order

Priority per §9 of the brief: security → financial/data integrity → auth/DB/API failures →
cross-device sync → regressions → configuration.

| #   | Class               | Defect                                                                                                                                                  | Root cause                                                                                                  | Files changed                                                                          |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Data integrity      | A keyless write planted `idempotencyKey: null`, and every later keyless write to that collection failed with a false "already exists"                   | BSON serialises `undefined` → `null`; unique indexes are sparse, so `null` occupies the single allowed slot | `src/lib/idempotency.ts` (new) + 9 write paths in `src/app/api/**`, `src/lib/models/*` |
| 2   | Data integrity      | Finance module had **no** live signal; ledger writes synced only on the poll                                                                            | `COLLECTION_MODULES` named a nonexistent `ledger` collection                                                | `src/lib/realtime/types.ts`                                                            |
| 3   | Sync                | Cold start produced a permanently dead stream: the client adopted a baseline no signal could exceed                                                     | `cursor` frame emitted before `db.watch()` was open                                                         | `src/lib/realtime/watcher.ts` (+ `watcher-readiness.test.ts`)                          |
| 4   | Sync                | Changes landing between first fetch and subscription were never applied                                                                                 | first cursor snapshot swallowed as redundant                                                                | `src/lib/realtime/coordinator.ts` (+ `phase3-sync.test.ts`)                            |
| 5   | Sync                | Two writes in the same second collapsed into one signal; the second was lost                                                                            | `clusterTime` has 1-second resolution                                                                       | `src/lib/realtime/watcher.ts`, `types.ts` (+ `watcher.test.ts`)                        |
| 6   | Config/deploy       | `getKarachiDate()` silently shifted every civil-day boundary on a UTC host (measured **+5.000 h**), including a same-offset zone under a different name | civil date derived from the process zone _name_                                                             | `src/instrumentation.node.ts`, `instrumentation-clock.test.ts` (new), `.env.example`   |
| 7   | Operational tooling | The e2e cleaner reported `0` for the chat namespace it never examined                                                                                   | swept `chatMessages.text`; the real namespace is `messages.content`                                         | `scripts/cleanup-e2e-data.ts`                                                          |
| 8   | Operational tooling | The production seed ran against a test database despite a comment claiming it refused                                                                   | guard checked only `MONGODB_TEST_DB`, never the resolved name                                               | `scripts/seed.ts`                                                                      |
| 9   | API/diagnostics     | Expected 4xx refusals logged full stacks, burying real faults                                                                                           | one catch-all error log path                                                                                | `src/lib/http.ts`, `http-log-hygiene.test.ts` (new)                                    |
| 10  | Reliability         | One duplicate index name could reject an entire `createIndexes` batch, leaving collections unindexed                                                    | index creation treated 85/86 as a batch failure                                                             | `src/lib/models/indexes.ts` (new), model `ensure*` helpers                             |
| 11  | Config              | Database resolution was implicit; an Atlas URI with an empty path silently selects a database named `test`                                              | no explicit, validated resolution                                                                           | `src/lib/db-name.ts` (new), `src/lib/mongodb.ts`, `db-name.test.ts` (new)              |
| 12  | QA coverage         | 5 screens had never been opened by any test; route walk covered 10 of 23                                                                                | suite grew by feature, not by surface                                                                       | `src/e2e/layout.spec.ts`                                                               |
| 13  | QA coverage         | No instrument could state that the _stored_ financial records reconcile                                                                                 | claims rested on engine unit tests over synthetic ledgers                                                   | `scripts/verify-finance.ts` (new), `package.json` (`verify:finance`)                   |
| 14  | Config/docs         | `NEXT_PUBLIC_VAPID_PUBLIC_KEY` undocumented; silent push disablement at build                                                                           | build-time inlining of `NEXT_PUBLIC_*`                                                                      | `.env.example`                                                                         |
| —   | (test defect)       | `phase4-performance.spec.ts:275` and a `watcher.test.ts` assertion were wrong, not the app                                                              | overlapping-window assertion; fixed TZ margin                                                               | `src/e2e/phase4-performance.spec.ts`, `src/lib/realtime/__tests__/watcher.test.ts`     |

Temporary `[debug]` instrumentation and the superseded one-shot probes were removed after the
findings were confirmed; the instruments that reproduce claims baked into code comments were kept
(Appendix A).

---

## 10. Production-readiness checklist

| Area                                                                           | State                                                                      | Basis                                                                                                                                                      |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every module's routes and screens render with no API failure or uncaught error | **Complete**                                                               | §1.2–1.3 — all 23 screens, 3 projects, 0 failures                                                                                                          |
| Regression against **genuine** operational history                             | **Blocked**                                                                | §1.1 — the application database has no products/orders/tasks/stock; there is no history to verify against yet                                              |
| Sessions, expiry, cookies                                                      | **Partial**                                                                | HttpOnly/lax/sliding/revocation verified locally; `Secure` over HTTPS is §7.4 V4                                                                           |
| Server-side authorization on every protected API route                         | **Complete**                                                               | §2.1–2.2 — 128 handlers scanned, refusals asserted with real accounts, with no data in the refusal and no writes performed                                 |
| Founder-only team management                                                   | **Complete**                                                               | §2.2 — users/roles/audit-log refusals asserted for a Partner                                                                                               |
| CSRF                                                                           | **Partial**                                                                | Verified through the real middleware against `next start`; fail-open when the marker is absent is a documented residual risk; deployed chain is §7.4 V2+V3 |
| Rate limiting / lockout                                                        | **Complete**                                                               | §2.2 — lockout refuses even the correct password                                                                                                           |
| Input validation, safe errors, no stacks to clients                            | **Complete**                                                               | §2.2, §6                                                                                                                                                   |
| Audit logging                                                                  | **Complete**                                                               | `recordAuditEntry` coverage per route-audit; 533 real entries read back                                                                                    |
| Cross-device realtime sync                                                     | **Complete** (single-host) / **Unverified** (physical devices, serverless) | §3 — 9 tests with independent sessions; §7.4 V5                                                                                                            |
| Reconnect, dedup, stale-response handling                                      | **Complete**                                                               | §3.1, §3.2, `phase9-offline.spec.ts`                                                                                                                       |
| Permission changes propagate live                                              | **Complete**                                                               | §2.2 / `phase11-sync.spec.ts:298`                                                                                                                          |
| Database indexes                                                               | **Complete**                                                               | §5.1 — 9/9 business keys, 8/8 idempotency guards, 33 unique specs, 0 missing, 0 duplicates                                                                 |
| Duplicate financial writes prevented                                           | **Complete**                                                               | §5.2 — replay/kill/two-tab tests + `idempotencyKey: null` absent in both databases                                                                         |
| Financial calculations match transactions (**stored records**)                 | **Complete**                                                               | §5.3 — app DB reconciles; 205 rows / 22 reversal pairs / 11 budgets / 3 distributions verify with 0 failing                                                |
| Financial calculations at volume                                               | **Complete** (synthetic)                                                   | §5.3, `phase8-perf.test.ts` at 10,000 rows                                                                                                                 |
| Demo/mock data removed; test data isolated                                     | **Complete**                                                               | §4 — both guards proven in both directions; nothing deleted                                                                                                |
| Production build, lint, typecheck, unit tests                                  | **Complete**                                                               | §7.1                                                                                                                                                       |
| Netlify deployment configured                                                  | **Blocked**                                                                | §7.2 — **no `netlify.toml` exists**, no runtime pin; also blocked by the next row                                                                          |
| Tested code is deployable                                                      | **Blocked**                                                                | Verdict — 141 modified + 35 untracked files are uncommitted; Netlify builds from Git                                                                       |
| Deployed-environment verification (V1–V6)                                      | **Unverified**                                                             | §7.4 — cannot be performed locally                                                                                                                         |
| Web Push notifications                                                         | **Unverified**                                                             | §7.4 — VAPID keys not provisioned                                                                                                                          |
| Desktop / tablet / mobile QA                                                   | **Complete**                                                               | §8.2 — 8 viewports × all routes, 3 projects                                                                                                                |
| Test results recorded (pass/fail/skip/could-not-run)                           | **Complete**                                                               | §8.1–8.2                                                                                                                                                   |

**Do not read §7.1's green build as readiness.** The build passing is the weakest claim in this
report; the blockers are an uncommitted tree, a missing platform config, and six verifications that
require the deployed host.

---

## Decisions left to the owner

1. **Commit the tree** (or authorise committing it). Without this, none of the verified fixes can be
   deployed. Nothing was committed during this audit.
2. **Create `netlify.toml`** with `command = "next build"`, `publish = ".next"`, a pinned Node
   runtime, and the environment variables in §7.3.
3. **`/design` in production** — remove the route, hide it behind a permission, or accept it as an
   internal component gallery. It renders sample data on a live URL.
4. **CSRF fail-open hardening** (§2.3) — recommended as a separate, deliberately scheduled change
   with its own regression pass, not folded into a QA fix.
5. **Recreate `tasks.taskNumber_1` under the declared name** — cosmetic; the guarantee is already
   present.
6. **Whether to seed the application database with real operational data**, and when. The financial
   cycle there is a single month's income; the modules with zero rows are untested against reality
   until live use begins.

---

## Appendix A — audit instruments retained in the repository

Kept because code comments cite them as the measurement behind a claim, and a claim whose instrument
is deleted is no longer checkable. All are read-only.

| Instrument                                     | Command                                       | Answers                                                                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/index-audit.ts`                       | `npx tsx scripts/index-audit.ts`              | which indexes the server actually holds, unique specs with `sparse`, and the row counts that bound every "figures match records" claim                                                |
| `scripts/verify-finance.ts`                    | `npm run verify:finance`                      | whether the stored ledger/budget/distribution records satisfy the app's own math (§5.3)                                                                                               |
| `scripts/route-audit.mjs`                      | `node scripts/route-audit.mjs`                | per-handler guard / validation / audit / retry coverage across 87 API files                                                                                                           |
| `scripts/perf-probe.ts`, `scripts/db-probe.ts` | `npx tsx scripts/…`                           | what the browser waits for, and what the server waits for — cited in `src/lib/mongodb.ts`, `auth/session.ts`, `metrics/*`                                                             |
| `scripts/responsive-probe.ts`                  | `npx tsx scripts/…`                           | geometry assertions with the offending element printed                                                                                                                                |
| `scripts/sync-probe.ts`                        | `npx tsx scripts/…`                           | whether an HTTP write actually produces a `change` frame on an open `/api/events` stream, or only the connect-time baseline                                                           |
| `scripts/diag-cursor-domain.mts`               | `npx tsx scripts/diag-cursor-domain.mts [db]` | whether any stored row's `updatedAt` sits ahead of this process's clock — the **pre-launch check** for §7.4 V1, since one such row outranks every live signal and silently stops sync |
| `scripts/db-inventory.ts`                      | `npx tsx scripts/…`                           | the name-resolution and collection inventory cited by `src/lib/db-name.ts` and `scripts/seed-e2e.ts` (volumes are now covered by `index-audit.ts`)                                    |
| `scripts/cleanup-e2e-data.ts`                  | `npm run cleanup:e2e` (dry run)               | what test data exists; never run `--apply` against the application database                                                                                                           |

Deleted as true throwaways: `scripts/codemod-log-route-failure.mjs` (a one-time rewrite, already
applied) and `scripts/change-stream-probe.ts` (its question — is `db.watch()` alive against this
cluster — is answered and now guarded by the readiness handshake in §3.2).
