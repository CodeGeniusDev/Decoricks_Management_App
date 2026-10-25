## Hosting & infrastructure limits (final decision: Render Free + keep-awake monitor)

These are the real, current limits of the chosen setup. Read this before calling
the deployment "production".

### Render Free web service

- **Render says Free instances are not for production.** Their own docs state
  Free web services should **not be used for production applications**. This
  deployment is a **staging / controlled-evaluation** host, not a guaranteed
  production SLA. (VERIFIED — render.com/docs/free.)
- **15-minute spin-down.** A Free web service is put to sleep after **15 minutes
  with no inbound traffic**, and the next HTTP request pays a cold start of
  **roughly one minute** while it wakes. A keep-awake monitor pinging
  `/api/health` every ~10 minutes is what keeps it warm (see DEPLOYMENT.md §6b).
- **750 instance-hours per workspace per calendar month (shared).** This is a
  **workspace-wide** pool, not per service. One service running 24/7 is
  ~720–744 h and fits within a month; a **second** always-on Free service
  (~1,440–1,488 h) would exhaust the pool and **suspend all Free web services**
  until the next month. Spun-down time does **not** count. No rollover.
- **One cold first request after every deploy or restart.** Render may restart a
  Free service at any time, and every deploy/restart brings a fresh process: the
  **first** request is slow (cold Next.js boot + first Mongo connection
  handshake), later requests are warm. Partners will see one slow tap after a
  deploy until the monitor or their first click wakes it.
- **Tiny box: 0.1 CPU / 512 MB RAM.** Build can hit out-of-memory on a small
  instance (see DEPLOYMENT.md §6c) — mitigations documented there.
- **Egress limits.** Render may suspend a Free service that initiates an
  uncommonly high volume of traffic to the public internet. Normal app traffic
  (a few partners, one Atlas connection) is well within this, but it is a stated
  Free-plan caveat.

### MongoDB Atlas (M0 free tier)

- **Shared 512 MB storage.** The M0 cluster has a **512 MB** disk shared by the
  whole cluster. It is ample for a four-person business's ledger, orders, tasks
  and chat at this stage, but it is a hard ceiling — growth (images in the DB,
  long audit history, large exports kept in collections) must be watched, not
  assumed infinite.
- **Cloud backups are INACTIVE.** The M0 tier does **not** provide continuous
  cloud backups / point-in-time recovery. **Recovery depends entirely on the
  local encrypted `npm run backup` archives** described in
  `docs/BACKUP_RECOVERY.md`. If those nightly archives are not running and kept
  off-device, there is **no other copy** of the data. Treat the nightly backup
  (launchd job) as mandatory, not optional.
- **A single region, no replica set.** M0 is a single shared instance — no
  automatic failover. If it is briefly unavailable the app returns the generic
  503 from `/api/health/database` (Founder-only) / fails reads; it is not a
  high-availability setup.

### Application-level limits that remain (by explicit decision)

- **In-memory rate limiters are per-process.** They work correctly on one Render
  instance (our case), but would not be shared across multiple instances — not a
  concern on a single Free service.
- **Offline queue is create-only** (finance + budget creates). Edits/deletes and
  orders/tasks/chat are online-only; an offline entry is stored per-device and
  replayed on the Sync screen.
- **No React-render (jsdom/RTL) tests, no coverage tooling, `scripts/`
  untested** — deferred (see below and AUDIT).

---

## Phase 10 (Checkpoint 1/2) - Deferred

- **React-render tests:** Deferred (see AUDIT).
- **Legacy collection cleanup:** Deferred (E6/E7 and others Low) pending review.
- **npm audit:** 9 remaining vulnerabilities tracked (braces/@vitest/mocker) — overrides added where safe; breaking upgrades deferred.
- **Tailwind 4 / vitest 4–5:** Deferred to avoid breaking changes.
- **SSE/change streams hosting:** Requires persistent Node host; Vercel/serverless not reliable. Polling fallback exists. Decision deferred to Step 5.
- **Full Playwright e2e:** Long-running in this environment; scoped QA recommended.

## Phase 10 (Checkpoint 1/2) - Additional

- **In-memory rate limiters:** `loginRateLimiter`, `changePasswordRateLimiter`, `adminRateLimiter` are per-process only (not shared across instances). Use Redis/shared store for multi-instance.
- **CSP uses inline scripts:** `next.config.js` CSP allows `unsafe-inline` for Next.js hydration; consider nonce-based CSP if hardened further.
- **9 remaining npm audit findings:** Tracked (braces/@vitest/mocker etc.); overrides added where safe; breaking upgrades deferred.
- **Tailwind 4 and vitest 4/5 deferrals:** Deferred to avoid breaking changes.
- **React-render tests:** Deferred (no jsdom/RTL in this phase).
- **Legacy collections:** Cleanup deferred (E6/E7 and other Low items).

## Post-launch (deferred by explicit decision)

- **Founder "Export now" button (in-app, audit-logged).** Decided NOT to build in
  Phase 10 — directive: "no more features after the HelpPanel commit." The CLI
  already produces the identical encrypted archive (`npm run backup`, see
  `docs/BACKUP_RECOVERY.md`), so the capability exists without the button. When
  built, it should be Founder-only, stream the AES-256-GCM archive as a download,
  and record a `backup_exported` audit entry (reuse `src/lib/backup/*`; the
  passphrase must never transit through the browser — see the key-location note in
  `docs/BACKUP_RECOVERY.md`).
- **Rename the Atlas database `test` → `decoricks`.** Pending explicit go-ahead;
  plan and rollback are in `docs/DB_MIGRATION.md`. Not executed.
