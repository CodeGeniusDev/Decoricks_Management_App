# Decoricks Management App — Final Status (Phase 10 → launch handover)

**Status date:** 2026-10-25
**Branch / HEAD:** `phase-10` @ `ab80de2`
**Local runtime used for the gates:** Node **v26.8.1** (no `nvm`/`fnm`/`volta` on this machine)

> This file **supersedes** the 2026-10-22 "Phase 10 Audit Report". That was a
> **Step-1 findings pass** (read-only, nothing fixed, "STOP AND WAIT"). Since
> then Phase 10 has closed almost every item it raised. This is the honest
> reconciliation: what is **done** (with commit), what is **deferred** (with
> reason), and what is **NOT VERIFIED**.

---

## 1. Verification gates (real output, run on `ab80de2`)

| Gate | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | **PASS** (exit 0) |
| Lint | `next lint` | **PASS** — "No ESLint warnings or errors" |
| Unit tests | `vitest run` | **PASS** — **61 files, 858 tests**, 26.3s |
| Production build | `next build` | **PASS** — "Compiled successfully", 65 routes |
| E2E suite | `playwright test` (chromium + Mobile Chrome + Tablet/webkit) | **PASS** — **294 passed, 0 failed, 56 skipped** |

- **E2E target:** `decoricks_test` **only**. `playwright.config.ts` runs the webServer with `E2E_TEST_MODE=1` and `MONGODB_TEST_DB=decoricks_test`; `scripts/seed-e2e.ts` refuses a bare `test` DB or any DB equal to the app DB. `decoricks_prod` was **not** touched.
- **Node 22 build: NOT VERIFIED.** The pin (`.nvmrc` = `22`, `engines.node` = `>=20.0.0 <23.0.0`, commit `abd3fbd`) is correct, but this machine only has Node **v26.8.1**, so the production build was **not exercised under Node 22 locally**. The operator will set `NODE_VERSION=22` in Render.

---

## 2. Playwright suite — per-spec-file results

19 spec files run in **3 device projects** each (chromium, Mobile Chrome, Tablet/webkit), plus the `auth.setup.ts` login setup. Totals are summed across the three projects.

| Spec file | Passed | Skipped | Failed | Not run |
|---|---:|---:|---:|---|
| `layout.spec.ts` (incl. **/design** gallery + responsive) | 102 | 0 | 0 | — |
| `usability-help.spec.ts` | 30 | 0 | 0 | — |
| `phase4-performance.spec.ts` | 27 | 0 | 0 | — |
| `phase3-finance.spec.ts` | 24 | 0 | 0 | — |
| `phase8-reports.spec.ts` | 19 | 2 | 0 | — |
| `phase4-budget-profit.spec.ts` | 12 | 0 | 0 | — |
| `phase8-dashboard.spec.ts` | 12 | 0 | 0 | — |
| `phase7-realtime.spec.ts` | 9 | 0 | 0 | — |
| `phase2-auth.spec.ts` | 8 | 4 | 0 | — |
| `phase10-security.spec.ts` | 7 | 14 | 0 | — |
| `phase10-create-board.spec.ts` | 6 | 0 | 0 | — |
| `phase11-sync.spec.ts` | 6 | 12 | 0 | — |
| `phase12-session-bootstrap.spec.ts` | 6 | 0 | 0 | — |
| `phase6-board.spec.ts` | 6 | 0 | 0 | — |
| `phase3-collab.spec.ts` | 4 | 8 | 0 | — |
| `phase5-inventory-sales.spec.ts` | 4 | 2 | 0 | — |
| `phase7-chat.spec.ts` | 4 | 8 | 0 | — |
| `phase9-notifications.spec.ts` | 3 | 0 | 0 | — |
| `phase9-offline.spec.ts` | 3 | 6 | 0 | — |
| `auth.setup.ts` (setup project) | 2 | 0 | 0 | — |
| **Total** | **294** | **56** | **0** | **none** |

**About the 56 skips — not a gap.** Every skip is an intentional, self-documented
device-dedup: `test.skip(testInfo.project.name !== 'chromium', '…run once')`.
These specs either **open their own browser contexts** (multi-device realtime,
sync, collab) or **mutate shared global server state** (rate limiter, lockout,
role backfill), so they run **once on the `chromium` project** and are skipped on
the two duplicate device projects. **0 tests were left unrun.**

**/design coverage (was the old P1 QA failure — see §3):** now green on all three
projects — `layout.spec.ts` asserts the Founder sees the component gallery, a
Partner gets a real **404**, and an anonymous visitor never sees it.

---

## 3. Previously-open items → final status

Legend: **done** = fixed + covered by a passing test; **deferred** = intentional,
documented; **NOT VERIFIED** = not exercised in this pass.

### 3a. Security (old §4 "open")

| Item | Status | Commit / evidence |
|---|---|---|
| Lockout extended on every attempt while locked (DoS) | **done** | `79f7e9a` (fix) + `34b1e62` (test) |
| `loginAttempts` unbounded, no purge/TTL | **done** | `79f7e9a` (TTL/purge) |
| No IP rate limit on login / change-password / admin | **done** (per-process) | `79f7e9a`; see §4 — limiter is in-process, correct for the single Render Free instance, not shared across replicas |
| Session TTL 7d vs SPEC 30m | **done** (policy) | `457a6ee` — 12h sliding + 7d absolute max, env-configurable |
| CSRF fail-open when marker missing | **done** | `90b891e` — fail-closed |
| Forced-password-change not applied on ~12 routes | **done** | `90b891e` — gate on all `requireAuth` routes |
| Client permission matrix drift | **done** | `68793e3` — client parity with server roles |
| Hardcoded E2E password / founder email defaults | **done** | `1467f5a` + e2e `c67b0db` (refuse empty creds, one source IP per client) |
| No security headers | **done** | `9d7ce9a` (CSP, HSTS, nosniff, frame-ancestors, referrer) + `68793e3` |
| Secrets in git history | **NOT VERIFIED** | Pattern scan only; no full history secret-scan run |

### 3b. Data / finance (old §4 "open")

| Item | Status | Commit / evidence |
|---|---|---|
| Ledger reversal non-transactional (double-count risk) | **done** | `bf8e6eb` — reversals made transactional |
| Board idempotency broken | **done** | `2a1cc7c` — partial-unique index + replay support |
| `transactions` idempotency index timing | **done** | `34ba643` (ensure on write paths) + `1ca6a2c`/`4ad83d4` (dry-run tool) + `d281aa4` (chat partial index) |
| Month-prefix wrong during 00:00–04:59 PKT | **done** | `7d512d2` — local calendar month/year for Karachi serials |
| Distribution "not posting to ledger" | **deferred** (by design) | `8810f3e` — clarified cumulative retained earnings + payout flow; a payout is recorded against the distribution, not minted as a new cash-ledger movement |

### 3c. Realtime / sync (old §4 "open")

| Item | Status | Commit / evidence |
|---|---|---|
| "SSE not viable on serverless" | **done** (hosting resolves) | Single persistent host (Render Free), SSE works on the one instance — decision in `9bcce9e`/`2b9bf0f`; see §4 single-instance caveat |
| Polling delete bug (newest row) | **done** | `cfb2d0e` (notify on cursor decrease) + `7bd1c0a` (proof test) |
| Dead pages missing poll sources | **done** | `b447fb8`, `b4e392e`, `8a1350b`, and `eebed0c` (suppliers + weekly-summary) |
| Watcher retry loop / flood backoff | **NOT VERIFIED** | Not re-measured this pass; low risk on a single low-volume instance |
| Offline create-only + Web-Locks leader | **done** (create-only) | `339234c` two-tab leader-lock test; scope is create-only — see §4 |

### 3d. Deploy / docs (old §4 "open")

| Item | Status | Commit / evidence |
|---|---|---|
| No `netlify.toml` | **N/A** | Hosting decision is **Render Free**, not Netlify (`09ffd27`, `3f5a3d7`, `86bef22`) |
| No README | **done** | `241206c` — README rewritten as a real project README |
| No CI | **deferred** | Manual deploy; Auto-Deploy OFF on the service (operator deploys after `npm run verify`) |
| TZ not pinned in config | **done** | `src/instrumentation.node.ts` `pinKarachiClock()` sets `Asia/Karachi` when unset (floor; explicit wins). `.env.example` TZ note updated to reference Render, not Netlify |
| SPEC §8 outdated (Vercel/NextAuth/WebSocket) | **done** | `9bcce9e` — §7.4 + §8 reflect Render Free + Atlas M0 + custom auth + Node 22 |
| Large uncommitted working tree | **done** | Everything is committed on `phase-10` |
| `/api/health` DB-coupled & leaky | **done** | `236591f` (liveness w/o DB + readiness) and `9e2f50e` (`/api/health/database` Founder-only, leak-free) |
| Prod could boot against a test/sandbox DB | **done** | `d9cf7e3` — refuses to start in production against test/sandbox DB |

### 3e. QA / app (old §3, §4)

| Item | Status | Commit / evidence |
|---|---|---|
| `/design` gallery returned 200 to Partner | **done** | `c196f72` — gallery moved out of the `(app)` group, `notFound()` gives a real 404; e2e `layout.spec.ts` green on 3 projects |
| Probe/debug pages + `.bak` present | **done** | Removed — `src/app/probe-bare`, `(app)/probe-await`, `(app)/probe-sync`, `*.bak` no longer exist |
| No React-render tests, no coverage tooling | **deferred** | UI behavior is covered by Playwright; no jsdom/RTL render tests added — see §4 |
| Some routes lightly covered (e.g. suppliers CRUD) | **deferred** | Suppliers has realtime (`eebed0c`) but no dedicated CRUD e2e spec |
| Distribution detail flashed to skeleton on any finance change, closing an open "Show calculation" panel | **done** | `ab80de2` — silent in-place refresh (skeleton on first load only) + cross-device regression test; this was the one real E2E failure found in §2 |

---

## 4. Deferred by design (accepted trade-offs, with reason)

- **Rate limiters and change-stream watchers are per-process.** Correct on the single Render Free instance; would not be shared across replicas. Do **not** scale to >1 instance without moving rate-limit state to a shared store.
- **Offline queue is create-only** (finance + budget), per-device IndexedDB (Dexie). Edits/deletes are not queued offline. `docs/USER_GUIDE.md` §6 + `KNOWN_LIMITATIONS.md`.
- **No React/jsdom render unit tests.** Component/visual behavior is verified through the Playwright matrix instead.
- **Distribution payout is not a new cash ledger movement** — it is recorded against the distribution and reconciled, never double-booked (`8810f3e`).
- **Atlas M0 = 512 MB shared; Atlas cloud backups are INACTIVE.** Recovery depends entirely on the local encrypted `npm run backup` archives (`7827de3`, `79b443f`). `docs/KNOWN_LIMITATIONS.md`, `docs/MAINTENANCE.md`.
- **Render Free is not intended for production use per Render's own docs** (spin-down, 750 shared instance-hours, cold first request). Used as **staging / two-week parallel use only**. `docs/LAUNCH_CHECKLIST.md`, `docs/KNOWN_LIMITATIONS.md`.

---

## 5. NOT VERIFIED (honest gaps — never run in this pass)

- **Node 22 production build** — only Node v26.8.1 is installed here; the pin is correct but unexercised under 22.
- **Full git-history secret scan** — only a placeholder/pattern review was done.
- **Four simultaneous real devices / iOS PWA push + background-sync on hardware** — the e2e emulates contexts on one machine; no physical iOS push test.
- **Live `decoricks_prod` Atlas contents / index state** — this session performed **no** DB writes; only `decoricks_test` was seeded/run against.
- **Restore against the live production DB** — restore was only ever exercised **into a sandbox** DB (`7827de3`), never over production.
- **Render cold-start timing and the 750-hour budget** — a hosting property, not measurable locally.

---

## 6. Launch-handover commit map

| Area | Commit(s) |
|---|---|
| Node pin (`.nvmrc` + `engines`) | `abd3fbd` |
| Known-limitations (Render Free + Atlas M0, backups inactive) | `2b9bf0f` |
| User guide (Founder/Partner + Roman Urdu) | `0ee220c` |
| Maintenance (users, secrets, deps, restore, monthly, test-db gate) | `10a3077` |
| SPEC aligned to as-built | `9bcce9e` |
| README rewritten | `241206c` |
| Launch checklist (two-week parallel use) | `6783d71` |
| Distribution silent-refresh fix + e2e regression | `ab80de2` |
| `/api/health/database` Founder-only + leak-free | `9e2f50e` |
| Prod-refuses-test-DB boot guard | `d9cf7e3` |
| Nightly backup pinned to `decoricks_prod` | `79b443f` |
| Encrypted backup + sandbox restore + reconciliation proof | `7827de3` |
