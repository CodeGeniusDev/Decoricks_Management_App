# Decoricks Management App

A production-shaped business-management web app for **Decoricks**, a four-person
furniture business. It brings the money books, stock, sales, budgets, tasks and
team chat into one system the partners can use from a phone browser.

**Status:** feature-complete for the intended MVP and hardened through Phase 10
(security, data-correctness, realtime, backup). Deployed for **staging /
controlled use** on **Render Free + MongoDB Atlas M0**. It is **not** a
high-availability production SLA — that is a hosting decision, not a code gap.
The audit and remaining limitations live in [`docs/AUDIT.md`](docs/AUDIT.md) and
[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md).

---

## Tech stack

| Concern | Choice |
|---|---|
| Framework | Next.js 15 (App Router) + React 19 + TypeScript |
| Styling | Tailwind CSS 3 |
| Database | MongoDB (Atlas M0) via the official driver |
| Auth | **Custom** cookie-session + CSRF (no NextAuth); bcrypt (cost 12) |
| Validation | Zod (all API input + env) |
| Realtime | Server-Sent Events over MongoDB change streams, with an automatic cursor-polling fallback |
| Offline | Dexie (IndexedDB) create-queue for finance + budget |
| Money | Integer **paisa**, append-only ledger, reversal-only corrections |
| Charts / animation | Recharts, GSAP |
| Unit tests | Vitest |
| E2E tests | Playwright (3 device projects) |
| Hosting | **Render Free** web service (`next start`), Node 22, `TZ=Asia/Karachi` |

---

## What it does (modules)

- **Dashboard** — the day's headline figures, one parallel snapshot.
- **Finance** — unified append-only ledger: income, expense, transfer, partner
  capital / withdrawal, reinvestment; reversal instead of deletion; idempotent
  writes.
- **Budgets**, **Profit & Loss**, **Cash Flow**, **Profit Distribution** —
  computed from the ledger; actuals are never stored, always recomputed.
- **Reconciliation** (Founder-only) — independently recomputes every headline
  figure and must show zero difference.
- **Inventory** — products, weighted-average-cost stock, movements, purchases,
  with an atomic negative-stock guard.
- **Sales** — orders (server-authoritative pricing from the product list),
  COD lifecycle, returns; creating an order reserves stock.
- **Tasks** — kanban board (drag or Move-to), cards, columns, comments.
- **Chat** — channels, mentions, replies, unread counts (online-only).
- **Suppliers**, **Weekly Summary**, **Reports/Exports** (CSV + PDF).
- **Notifications** — in-app bell + preferences + Web Push.
- **Sync** — the offline queue made visible per device.
- **Settings** — Users & Roles, Permissions, Business Settings, Notifications,
  Audit Log (read-only), Data Export.

Roles: **Founder** (full access) and three **Partners** (Hasnat / Ali / Afnan)
with deliberately different defaults, all server-enforced and Founder-grantable.

---

## Getting started

```bash
npm install
cp .env.local.example .env.local     # fill MONGODB_URI (+ set MONGODB_DB)
npm run seed                          # create the 4 role documents + the Founder
npm run dev                           # http://localhost:3000
```

The seed reads `FOUNDER_EMAIL` / `FOUNDER_NAME` / `FOUNDER_PASSWORD` from the
environment and refuses to run against the test database. The Founder must
change the password on first sign-in.

**Required env (names only — see `.env.example`):** `MONGODB_URI`, `MONGODB_DB`,
`SESSION_SECRET`. `TZ=Asia/Karachi` and `NODE_VERSION=22` on the host. Optional:
session TTL/lockout/password-policy knobs, and the three VAPID keys for push.
`MONGODB_TEST_DB` is **test-runner only** — leave it out of dev/prod.

---

## Scripts

| Command | Does |
|---|---|
| `npm run verify` | typecheck + lint + test + build (the four gates) |
| `npm run dev` / `build` / `start` | Next.js dev, production build, serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `next lint` |
| `npm run test` | Vitest unit/integration run |
| `npm run test:e2e` | Playwright suite (seeds `decoricks_test`, port 3111) |
| `npm run seed` / `seed:e2e` | seed Founder+roles / seed e2e fixtures |
| `npm run backup` / `restore` | encrypted DB dump / restore (dry-run; `restore:apply` into a `test_` sandbox) |
| `npm run verify:finance` | recompute the money figures for a sanity check |
| `npm run migrate:task-assignees(:apply)` | task-assignee migration (dry-run / apply) |

Node is pinned to **22** via [`.nvmrc`](.nvmrc) and `package.json` `engines`
(`>=20 <23`).

---

## Testing

- **61** Vitest unit/integration files (~850 tests) covering the finance/inventory
  engines, auth refusals, authorization, realtime cursors, offline state machine
  and API routes. `mongodb-memory-server` backs the suites that need a real Mongo.
- **19** Playwright spec files run across **3 device projects** (Desktop Chrome,
  Pixel 5, iPad Pro) against an isolated `decoricks_test` database.

Run the gates: `npm run verify`. Run e2e per `docs/E2E_RUNBOOK.md`. Current pass
counts and what was/wasn't run are recorded in [`docs/AUDIT.md`](docs/AUDIT.md).

---

## Architecture notes

- **One server-side gate.** Every `/api/*` mutation flows
  `apiFetch → route → getAuthenticatedUser (session+CSRF) → authorize(module, action) → MongoDB`.
  There are no `"use server"` actions, so middleware CSRF covers the whole
  mutating surface. Founder-only routes use `requireFounder`.
- **Money is append-only.** Corrections post an opposite (reversal) entry;
  idempotency keys make a replay safe; integer paisa avoids float drift.
- **Realtime is permission-safe.** The SSE stream carries *dataless* signals
  ("module X advanced"); clients re-fetch through the same guarded routes. On a
  single persistent Render host SSE works; the polling fallback works anywhere.
- **DB-name safety.** `MONGODB_DB` is pinned; the resolver refuses to boot in
  production against a test-shaped name. See `docs/DB_MIGRATION.md`.

---

## Deployment

Deploy is performed manually to **Render Free** (Auto-Deploy off). The full,
step-by-step runbook — Atlas setup, Render service, env generation, keep-awake
monitor, first-deploy troubleshooting — is
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). The serverless hosting evaluation and
the recorded decision are in [`docs/SERVERLESS_OPTION.md`](docs/SERVERLESS_OPTION.md).

---

## Documentation index

| Doc | What it covers |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | Full functional specification |
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | How partners use it (plain language + Roman Urdu) |
| [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md) | Add users, rotate secrets, restore, monthly checks |
| [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md) | First two weeks of parallel use |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Render + Atlas deploy runbook, keep-awake, troubleshooting |
| [`docs/SERVERLESS_OPTION.md`](docs/SERVERLESS_OPTION.md) | Hosting evaluation + the recorded decision |
| [`docs/BACKUP_RECOVERY.md`](docs/BACKUP_RECOVERY.md) | Encrypted backups and verified restore |
| [`docs/DB_MIGRATION.md`](docs/DB_MIGRATION.md) | `test` → `decoricks_prod` copy-and-switch runbook |
| [`docs/SECURITY.md`](docs/SECURITY.md) · [`docs/OWASP_SUMMARY.md`](docs/OWASP_SUMMARY.md) | Security posture |
| [`docs/REALTIME.md`](docs/REALTIME.md) · [`docs/OFFLINE_AND_NOTIFICATIONS.md`](docs/OFFLINE_AND_NOTIFICATIONS.md) | Realtime + offline design |
| [`docs/METRICS.md`](docs/METRICS.md) · [`docs/E2E_RUNBOOK.md`](docs/E2E_RUNBOOK.md) | Formulas + e2e how-to |
| [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) | Honest limits and deferrals |
| [`docs/AUDIT.md`](docs/AUDIT.md) | Final status of every item + gate results |

---

## Security

Custom sessions, fail-closed authorization, CSRF enforced in session resolution,
security headers (CSP/HSTS/nosniff/frame), append-only audit log, bcrypt
passwords, rate limiting, lockout with no unbounded growth. Secrets are **names
only** in docs and never committed. See [`docs/SECURITY.md`](docs/SECURITY.md).

---

*Proprietary — Decoricks. This README describes the application; the per-item
build status and remaining work live in `docs/AUDIT.md`.*
