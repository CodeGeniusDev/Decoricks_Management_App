# Decoricks Management App — Phase 10 Audit Report

**Generated:** 2026-10-22  
**Branch:** `usability-phase-2` @ `a99b29d` (large uncommitted working tree)  
**Method:** read-only inspection of `/docs/SPEC.md`, `/docs/REALTIME.md`, `/docs/METRICS.md`, `/docs/OFFLINE_AND_NOTIFICATIONS.md`, `/docs/PHASE5-QA-REPORT.md`, package.json, full source tree, git history. Gates run: `tsc --noEmit`, `next lint`, `vitest run` (798/798), `next build` — all PASS.

> **STOP POINT:** This audit is complete. Per instructions, I am stopping and waiting for your decision on what to fix before starting Step 2.

---

## 1) Conflicts between docs and SPEC.md (must resolve)

| Conflict | Evidence | Impact | Resolution needed |
|---|---|---|---|
| **Hosting / SSE** | SPEC §8.1 says **Vercel (serverless)** + NextAuth + Vercel Blob. REALTIME.md §9/§59 says **single persistent Node host required** (MongoDB change streams + long-lived SSE). Code uses **custom auth**, no NextAuth. | Critical for Phase 5 deploy. On Vercel/serverless SSE + change streams won't work reliably; app already has polling fallback. | Choose host (see Step 5.1). SPEC §8 is outdated vs shipped design. |
| **Auth system** | SPEC §8.2 lists `NEXTAUTH_SECRET`/`NEXTAUTH_URL`. Code is custom session+CSRF (`src/lib/auth/*`, `src/middleware.ts`). | Env/config/docs mismatch. | Update SPEC/env docs to match custom auth. |
| **Offline scope** | SPEC §6.9 lists create orders/tasks/chat + update tasks/profile offline. OFFLINE_AND_NOTIFICATIONS.md **D1** says only finance+budget creates offline; chat online-only. Code implements Phase 9 as finance+budget creates + offline UI/sync. | Scope differs from SPEC. | Accept D1 (document supersession). |
| **Realtime delivery** | SPEC §7.10 says "Real-time updates via **WebSocket**". REALTIME.md says **SSE + polling fallback**. Code ships SSE. | Minor wording; code is correct. | Update SPEC §7.10. |
| **Server offlineQueue** | SPEC §3.1.20 defines a server `offlineQueue`. OFFLINE_AND_NOTIFICATIONS.md **D2** recommends dropping it (ledger idempotency + audit + notifications). Code has no durable server offlineQueue collection used for replay. | Acceptable if documented. | Confirm D2. |
| **Sync algorithm** | SPEC §6.7 says batch up to 10 per request. OFFLINE_AND_NOTIFICATIONS.md **D3** says sequential one-at-a-time. | Implemented sequentially. | Confirm D3. |
| **Notifications transport** | SPEC silent on module-scoped notifications in events. Code adds `notifications` as user-scoped module. | Works with dataless design. | Document as extension. |

---

## 2) Inventory (actual)

| Category | Count | Notes |
|---|---|---|
| API route files | **87** | `src/app/api/**/route.ts` |
| Page files | **32** | `src/app/**/page.tsx` (includes `(auth)`, `(app)`, probes) |
| Unit test files | **51** | `src/**/*.test.ts` (798 tests passing) |
| E2E specs | **17** | `src/e2e/*.spec.ts` (3 device projects) |
| Collections (modelled) | **31** | across `src/lib/models/*.ts` |

**Working tree:** 161 modified, 1 staged-add, 46 untracked. Nothing committed in this session.

---

## 3) Requirement checklist vs SPEC.md

| Module | SPEC requirement | Status | Evidence | Risk |
|---|---|---|---|---|
| **Auth/Sessions** | Custom cookie session, HttpOnly/SameSite/Secure, CSRF, logout | **done** | `src/lib/auth/session.ts`, `src/middleware.ts`, `src/app/api/auth/*`, e2e phase2/phase10 | Med (A1 lockout DoS, A4 TTL 7d vs 30m) |
| **Roles/Permissions** | 4 roles, matrix, server enforcement | **done** | `src/lib/roles.ts`, `src/lib/authorization.ts`, `src/app/api/roles/*`, `src/app/api/users/*` | Med (client matrix drift A7) |
| **Audit log** | Append-only, Founder-only read | **done** | `src/lib/audit.ts`, `src/app/api/audit-log/route.ts` | Low |
| **Finance ledger** | Append-only, reversal-only, idempotency, integer paisa | **done** | `src/lib/finance-ledger.ts`, `src/lib/finance.ts`, tests phase3/phase4 | **High** (D1 non-tx reversal) |
| **Accounts/Categories** | CRUD with validation | **done** | `src/app/api/finance/accounts/*`, `categories/*`, `finance-defaults.ts` | Med (index timing D3) |
| **Budgets** | Create/edit/approve/actuals computed | **done** | `src/lib/budget-*.ts`, `src/app/api/budgets/*` | Low |
| **P&L/Cash Flow** | Per METRICS/SPEC formulas | **done** | `src/lib/profit-loss.ts`, `src/lib/cash-flow.ts`, metrics tests | Low (E6/E7 minor) |
| **Distributions** | calc/approve/distribute, largest-remainder | **partial** | `src/lib/distribution-*.ts`, routes exist | **High** (E1 no ledger posting, E2 cumulative vs per-month) |
| **Reconciliation** | Founder-only independent checks | **done** | `src/app/api/dashboard/reconciliation/route.ts`, `src/lib/metrics/reconciliation.ts` | Low |
| **Products/Inventory/WAC** | WAC, movements, negative stock guard | **done** | `src/lib/stock-*.ts`, `src/lib/inventory-*.ts`, tests | Low (archived mismatch E4) |
| **Purchases** | Create/cancel with reversals | **done** | `src/app/api/purchases/*`, `src/lib/stock-service.ts` | Low |
| **Sales/Orders/Returns** | Lifecycle, COD, pricing, returns | **done** | `src/app/api/orders/*`, `src/app/api/returns/*`, `src/lib/order-pricing.ts` | Low |
| **Tasks/Board** | Boards/columns/cards/comments/move | **done** | `src/app/api/boards/*`, `src/app/api/tasks/*`, e2e phase6 | **High** (D2 board idempotency) |
| **Chat** | Channels/messages/mentions/references | **done** | `src/app/api/chat/*`, `src/lib/chat-*.ts`, e2e phase7 | Low |
| **Suppliers** | CRUD | **done** | `src/app/api/suppliers/*`, page exists | Med (untested, no sync) |
| **Notifications** | Bell/list/prefs/push, dedupe | **done** | `src/app/api/notifications/*`, `src/lib/notifications/*`, hooks | Med (single-read publish S7) |
| **Realtime (SSE)** | Events stream + polling fallback | **done (design)** | `src/app/api/events/route.ts`, `src/lib/realtime/*`, `src/lib/sync/*` | **High** (S1 serverless, S2 polling delete bug) |
| **Offline queue (creates)** | Finance+budget creates, Dexie, sync route | **done** | `src/lib/offline/*`, `src/app/api/offline/*`, `public/sw.js` | Med (creates only, S6 Web Locks) |
| **Reports/Exports** | Period report, CSV, PDF | **done** | `src/app/api/reports/*`, `src/lib/reports/*` | Low |
| **Dashboard/Metrics** | Widgets, reconciliation | **done** | `src/app/api/dashboard/*`, `src/lib/metrics/*` | Low |
| **Settings** | Users/roles/business/audit | **done** | pages/components + routes | Med (matrix drift, 2nd Founder possible) |
| **Health** | `/api/health` | **done** | `src/app/api/health/route.ts` | Low |
| **Design gallery** | Founder-only route | **broken** | `src/app/(app)/design/page.tsx` | **High** (returns 200 to Partner, e2e failing) |
| **Probes/debug** | Hidden pages/routes | **present** | `src/app/probe-bare/`, `(app)/probe-await/`, `(app)/probe-sync/`, `.bak` file | Med (untracked, should not ship) |

---

## 4) Known issues carried forward (from audit + Phase 5)

### Security (from prior review + this audit)
| Issue | Severity | Status | Evidence |
|---|---|---|---|
| Lockout extends on every attempt while locked (DoS) | **High** | **open** | `src/app/api/auth/login/route.ts:58`, `src/lib/auth/lockout.ts:77-78` |
| `loginAttempts` unbounded, no purge/TTL | **Med-High** | **open** | `src/lib/auth/lockout.ts:102-106` (no call sites), `src/lib/models/User.ts:183-186` |
| No IP rate limit on login/change-password/admin | **High** | **open** | `src/lib/rate-limit.ts` only chat send/search |
| Session TTL 7d vs SPEC 30m | **Med** | **open (policy)** | `src/lib/env.ts:20-24` |
| CSRF fail-open if marker missing | **Med** | **open** | `src/lib/auth/session.ts:170`, `src/middleware.ts:41,70-78` |
| Forced-password-change not applied on ~12 `requireAuth` routes | **Med** | **open** | `src/lib/authorization.ts:225-230` |
| Client permission matrix drift | **Med** | **open** | `src/lib/permissions-client.ts:74-117` vs `roles.ts` |
| Hardcoded E2E password in tracked files | **Med** | **open** | `src/e2e/helpers.ts:13`, `scripts/seed-e2e.ts:69` |
| No security headers | **Med** | **open** | `next.config.js` (no headers()) |
| Secrets in git history (placeholders + one mongo URI pattern) | **Med** | **NOT VERIFIED** | history shows placeholder URIs; real secret exposure unknown |

### Data/Finance
| Issue | Severity | Status | Evidence |
|---|---|---|---|
| Ledger reversal non-transactional (double-count risk) | **Critical** | **open** | `src/lib/finance-ledger.ts:596-611` |
| Board idempotency broken | **High** | **open** | `src/app/api/boards/route.ts:73-84` |
| `transactions` idempotency index timing | **High** | **open** | `src/lib/finance-defaults.ts:139-150` |
| Month-prefix wrong 00:00-04:59 PKT | **High** | **open** | `src/lib/serial.ts:37-38`, `budget-create.ts:45-46`, `task-service.ts:320-321` |
| Distribution not posting to ledger | **High** | **open (policy)** | `src/app/api/finance/distributions/[id]/distribute/route.ts:45-65` |

### Realtime/Sync
| Issue | Severity | Status | Evidence |
|---|---|---|---|
| SSE not viable on serverless | **Critical** | **open** | `src/lib/realtime/watcher.ts:89-93`, REALTIME.md |
| Polling delete bug (newest row) | **Critical** | **open** | `src/lib/sync/cursor.ts:118-128` |
| 8 dead pages, missing poll sources | **High** | **open** | page scan |
| Watcher retry loop/flood | **Med** | **open** | `src/lib/realtime/watcher.ts:170,192,198` |

### Deploy/Docs
| Issue | Severity | Status | Evidence |
|---|---|---|---|
| **No `netlify.toml`** | **Critical** | **open** | repo root (PHASE5-QA says blocked) |
| **No README** | **Med** | **open** | I created `README.md` now; not in git |
| **No CI** | **Med** | **open** | no `.github/` |
| **TZ not pinned in config** | **High** | **open** | `.env.example` leaves TZ commented; instrumentation only warns/pins if unset |
| SPEC §8 outdated (Vercel/NextAuth) | **Med** | **open** | conflicts listed above |
| Uncommitted work (161+46) | **Critical** | **open** | `git status` |

### QA
| Issue | Severity | Status | Evidence |
|---|---|---|---|
| `/design` returns 200 to Partner (404 expected) | **High** | **open** | `src/e2e/layout.spec.ts:514`, `test-results/.last-run.json` failed |
| No React-render tests, no coverage | **Med** | **open** | no jsdom/RTL |
| 11 routes untested, scripts untested | **Med** | **open** | inventory |

**Gates (actual):** `tsc --noEmit` OK, `lint` OK, `vitest` 51/51 798/798 OK, `next build` OK. E2E not run to completion this session.

---

## 5) What was NOT verified
- Full e2e suite end-to-end in this run
- Live Atlas database contents/indexes/rows
- Four simultaneous devices
- Real browser viewport sweep across every route
- Restore/backup scripts (do not exist yet)
- Security headers behavior with GSAP/charts/SW/SSE
- Dependency audit (`npm audit`)
- Git history deep scan for actual secrets (only pattern scan done)
- Production deployment smoke test
- iOS PWA push/background sync on real device

---

**STEP 1 COMPLETE. STOPPING AND WAITING FOR YOUR DECISION ON WHAT TO FIX.**
No code changes made. Audit written to `/docs/AUDIT.md`.
