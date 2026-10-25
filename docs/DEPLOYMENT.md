# Deployment Preparation — Koyeb and Render

Status: **preparation only.** Nothing in this document has been deployed, pushed,
or run against a live host. It records the exact configuration a deploy needs
for BOTH Koyeb and Render, so the operator can choose a host later without
re-deriving it. No host is recommended here.

Related docs: `docs/DB_MIGRATION.md` (test → `decoricks_prod` cutover),
`docs/BACKUP_RECOVERY.md`, `docs/KNOWN_LIMITATIONS.md`.

---

## 0. Before any deploy — the two non-negotiables

1. **`MONGODB_DB` must be set explicitly to `decoricks_prod`.** The Atlas
   "Connect" URI has an empty path after the host, so if `MONGODB_DB` is unset
   the driver silently falls back to a database literally named `test`. That is
   the production hazard described in `docs/DB_MIGRATION.md`; do not deploy
   until the cutover there is done and `decoricks_prod` holds the data.
2. **`MONGODB_TEST_DB` must NEVER be set on a host.** `src/lib/db-name.ts`
   refuses to serve a first DB call unless the process is a test runner
   (`NODE_ENV=test` or `E2E_TEST_MODE=1`). On a production host that variable
   would crash the app. It is a test-runner-only switch; keep it out of every
   dev and prod copy of the env.

The app also pins its process clock: set `TZ=Asia/Karachi` (see §4). The date
layer renders Karachi wall time and re-parses it in the process zone, so a
generic +05:00 name (or UTC) shifts every stored timestamp by hours.

---

## 1. Environment variables (NAMES ONLY — never paste values into a doc/commit)

Secrets (`MONGODB_URI`, `SESSION_SECRET`, VAPID private key, `FOUNDER_PASSWORD`)
go into the host's encrypted secret store, not the repository.

Runtime (server-side, all `process.env`):

| Name | Required | Notes |
| --- | --- | --- |
| `MONGODB_URI` | yes | Atlas SRV URI. **SECRET.** |
| `MONGODB_DB` | yes | Set explicitly to `decoricks_prod`. |
| `SESSION_SECRET` | yes | ≥16 chars; signs CSRF tokens. **SECRET.** |
| `SESSION_TTL_MINUTES` | optional | Default 720 (12h sliding window). |
| `SESSION_MAX_LIFETIME_MINUTES` | optional | Default 10080 (7d absolute). Must be ≥ TTL or the app refuses to boot. |
| `SESSION_SLIDE_INTERVAL_SECONDS` | optional | Default 60. |
| `PASSWORD_MIN_LENGTH` | optional | Default 12. |
| `BCRYPT_COST` | optional | Default 12. |
| `LOGIN_MAX_ATTEMPTS` | optional | Default 5. |
| `LOGIN_WINDOW_MINUTES` | optional | Default 15. |
| `LOCKOUT_MINUTES` | optional | Default 15. |
| `TZ` | yes | Exactly `Asia/Karachi`. |
| `MONGODB_TEST_DB` | **never** | Test-runner only. Must be absent on the host. |

Optional Web Push (Phase 9). If unset, push is disabled and the app falls back
to in-app + browser notifications while open:

| Name | Required | Notes |
| --- | --- | --- |
| `VAPID_PRIVATE_KEY` | optional | **SECRET**, server-only. |
| `VAPID_SUBJECT` | optional | e.g. `mailto:…`, server-only. |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | optional | Inlined into the client **at build time**. Must be present in the BUILD environment, and changing it needs a rebuild, not just a redeploy. |

Do **NOT** put these on the production host runtime env (seed-only, used by
`npm run seed` on a trusted machine):

- `FOUNDER_EMAIL`, `FOUNDER_NAME`, `FOUNDER_PASSWORD` (the last is a secret).

---

## 2. Health check

Both hosts accept an HTTP health-check path. Use the app's own endpoint:

- Path: `GET /api/health`
- Returns `200 { "status": "ok", "database": "healthy" }` when the DB is
  reachable; `503` when it is not (`src/app/api/health/route.ts`). It also calls
  `getEnv()`, so a missing/invalid required variable surfaces here as a failure
  rather than a blank screen.

Set the health check to `http://<host>/api/health` and point the public port at
the app (see §3). Do not mark a deploy "live" until `/api/health` is green AND
the resolved database name (printed on startup by `src/lib/mongodb.ts`) is
`decoricks_prod` — never `test`.

---

## 3. Region — put the app next to the Atlas cluster

MongoDB Atlas and the app host should share (or nearly share) a cloud region so
every request is a short hop, not a trans-oceanic one.

**Your Atlas cluster's region could NOT be verified from the connection string
or the driver.** A read-only probe this turn connected with the real URI and
ran only read-only admin commands: the SRV host is opaque (it does not encode a
cloud provider/region), and `serverStatus` returned no region token. The region
must be read from the Atlas console (Cluster → Configuration) or the Atlas Admin
API — neither of which was run here. **Treat the actual region as NOT VERIFIED.**

Once you know the Atlas region, pick the closest host region:

- **Koyeb** free instance is offered in **Frankfurt (eu-central)** or
  **Washington, D.C. (us-east)**. Paid/Eco instances add more.
- **Render** offers **Oregon, Ohio, Virginia (US), Frankfurt (EU), Singapore
  (APAC)**. Static sites are on a global CDN (no region to choose). Render does
  **not** let you change a service's region after creation — you redeploy in the
  new region and cut over.

Example mapping (verify your Atlas region first):

| Atlas region | Nearest Koyeb | Nearest Render |
| --- | --- | --- |
| AWS eu-central-1 (Frankfurt) | Frankfurt | Frankfurt |
| AWS us-east-1 / -2 (Virginia/Ohio) | Washington, D.C. | Virginia or Ohio |
| AWS ap-south-1 (Mumbai) | (neither is close; pick Frankfurt) | Singapore |

---

## 4. Timezone (TZ=Asia/Karachi)

Set `TZ=Asia/Karachi` as an environment variable on BOTH hosts.

- Koyeb: add it as an Environment variable on the service (it is exported to the
  container process).
- Render: add it under Environment; Render containers default to UTC otherwise.

`src/instrumentation.node.ts` pins Karachi when `TZ` is unset and warns on every
boot when the running clock is not Karachi, but it never overrides an explicit
value — so set it explicitly rather than relying on the pin.

---

## 5. Build and start — Koyeb

Koyeb can build from a Git repo (Docker/Buildpack) or deploy a prebuilt image.
For a Next.js Node app, use the Node buildpack (or a Dockerfile).

- Install/build command:
  ```
  npm ci && npm run build
  ```
- Run/start command:
  ```
  npm run start
  ```
  `next start` binds to the port Koyeb injects as `PORT`. Expose the app on the
  Koyeb-assigned `PORT` and set the health check path to `/api/health`.
- Node version: pin an LTS the build passes on. Local development is on Node 26
  (not required); prefer Node 20/22 LTS on the host and confirm `next build`
  succeeds. There is no `engines` field in `package.json`, so set it explicitly
  in the Koyeb service config.
- Env: fill §1 into Koyeb's environment (secrets via the secret store). Confirm
  `MONGODB_DB=decoricks_prod`, `TZ=Asia/Karachi`, and **no** `MONGODB_TEST_DB`.

**Free-instance behavior (§8):** Koyeb's free Web Service runs on the free
instance type (512 MB RAM / 0.1 vCPU). Koyeb's own pricing FAQ says services do
NOT automatically scale to zero — "Scale-to-Zero … You can also manually pause
your Services" (a paid/roadmap feature). So on the Koyeb free tier the app stays
awake and does not cold-start on idle; the free 5-hour active limit applies to
the free *PostgreSQL* database, which this app does not use (it uses Atlas).
This is a documented claim from Koyeb's page, not something deployed or
measured here.

---

## 6. Build and start — Render

Render auto-detects a Node/Next app or uses `render.yaml` / a Dockerfile.

- Build command:
  ```
  npm ci && npm run build
  ```
- Start command:
  ```
  npm run start
  ```
  Render injects `PORT` (default 10000); `next start` honours `PORT`. Set the
  health-check path to `/api/health` in the dashboard.
- Node version: set via the dashboard runtime or `.nvmrc`/`engines`. Same
  guidance as Koyeb — pin an LTS the build passes on (local dev is Node 26).
- Env: fill §1 into Render's Environment; add secrets as "Secret Values".
  Confirm `MONGODB_DB=decoricks_prod`, `TZ=Asia/Karachi`, and **no**
  `MONGODB_TEST_DB`.
- Region: choose during creation to match Atlas (§3); it cannot be changed later.

**Free-tier behavior (§8):** Render FREE web services **spin down after ~15
minutes of inactivity** and take a cold start (tens of seconds) on the next
request. They also have limited monthly free instance hours; without a payment
method, exceeding the free allotment suspends the free services for the rest of
the month. This is Render's documented behavior, not measured here.

---

## 7. Rolling back a bad deploy

Both hosts keep the previous successful build/artifact. Preferred order:

1. **Roll back at the host first** (fastest, reversible):
   - Render: Deploys → pick the last green deploy → **Rollback**. This re-promotes
     the previous build with the config it was built with.
   - Koyeb: re-deploy the previous successful revision/commit (or roll back the
     service to the prior image/tag).
2. If the bad deploy changed **data** (a migration/backfill ran), rolling back
   the code is NOT enough — the schema/rows may already differ. That is why the
   cutover plan (`docs/DB_MIGRATION.md`) keeps `test` untouched for 30 days as
   the rollback, and runs the chat migration + permission backfill ONLY on
   `decoricks_prod` AFTER the app is switched and smoke-tested. A data rollback
   means restoring the fresh pre-cutover backup into a clean target and
   re-verifying counts — do not improvise it against production.
3. **Never roll forward onto the wrong database.** If the app reports `test` on
   startup, stop; the rollback is a config fix (`MONGODB_DB`), not a redeploy.

A rollback of CODE never touches the database by itself; a rollback of the
DATABASE is a restore, governed by `docs/BACKUP_RECOVERY.md`, and is a separate,
approval-gated operation from a host redeploy.

---

## 8. When the instance sleeps — polling and the offline queue

Relevant mainly to Render's free tier (15-min spin-down). On Koyeb's free Web
Service the app stays up (see §5), so sleep is less of a concern there.

What happens on a cold start / dropped instance:

- **Realtime (SSE) drops.** The client uses a long-lived `EventSource` to
  `/api/events` (`src/lib/sync/sse-transport.ts`, `coordinator.ts`). A spin-down
  closes the stream; `EventSource` reconnects on its own, and the coordinator
  reconciles state on reconnect. While asleep, the server keeps no live change
  stream, so no cross-device pushes land until the next request wakes it.
- **Polling wakes and refreshes.** `src/hooks/usePolling.ts` refetches on a
  `setInterval` and on `focus`, tab-`visibilitychange`, and network `online`
  events. The first interaction after a spin-down triggers a request, which
  wakes the instance (cold start), and the next poll/focus lands against the
  live app.
- **The offline queue covers writes.** `src/hooks/useOfflineQueue.ts` persists
  user-initiated writes locally when the server is unreachable (spinning down,
  cold-starting, or offline) and flushes them when connectivity returns. A write
  made during a sleep window is not lost; it is replayed on reconnect.

Practical consequence: on a sleeping host, expect a multi-second first click
after idle, a brief gap in realtime updates that closes on the next
poll/reconnect, and queued writes that apply on wake. If the partners cannot
tolerate cold starts, choose an always-on (paid) instance on either host, or
Koyeb's free always-on Web Service. This behavior is inferred from the client
code and each host's documented sleep policy; it has NOT been measured against a
live Koyeb or Render instance.

---

## 9. What could NOT be verified (say so plainly)

- **Your Atlas cluster's region** — not recoverable from the connection string
  or the driver; must be read in the Atlas console / Admin API. NOT VERIFIED.
- **No live deploy** — nothing here was built or run on Koyeb or Render. Cold
  start timings, health-check behavior, and sleep/queue interactions on the
  actual hosts are NOT VERIFIED (described from official docs + client code).
- **Koyeb card requirement & free-tier always-on**, **Render free-tier spin-down
  (15 min) and instance-hour suspension**, **Railway $5 trial without a card**,
  and **Fly.io card-required** facts below are quoted from each provider's
  official pages at the time of writing; providers change terms, so re-check
  before committing.
- **Exact free-tier performance** of this Next.js app (512 MB / 0.1 vCPU) under
  its SSE + change-stream load is NOT VERIFIED.

### 9a. Payment / card facts used above (from official pages)

- **Render** — accepts "all major credit and debit cards" (processed by Stripe).
  Free web services need no card to start, but exceed the free allotment / 15-min
  spin-down without a payment method and the free services are suspended for the
  month. Regions: Oregon, Ohio, Virginia, Frankfurt, Singapore.
- **Koyeb** — **requires a credit card** ("Why does Koyeb require a credit card?
  We require a credit card to prevent fraud and abuse."), processed by Stripe.
  Free Web Service is offered in Frankfurt or Washington, D.C. (512 MB / 0.1
  vCPU / 2 GB SSD) and does not auto-scale to zero.
- **Railway** — Free Trial grants a one-time $5 and can be started without a
  card ("try a free VM without an account"). Paid subscriptions accept **credit
  cards only** ("Railway only accepts credit cards for plan subscriptions").
- **Fly.io** — requires an active, valid **credit card** for most accounts
  (multi-app / public-image deploys); monthly charges are **credit-card only**.
  No general free tier for new users; pay-as-you-go with egress/VM pricing.

No host is recommended. Whether each is reachable "without an international
credit card" for YOUR situation depends on the card, and the always-on vs
sleeping choice depends on what the partners will tolerate — both are the
operator's call.
