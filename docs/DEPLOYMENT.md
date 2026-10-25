# Deployment Preparation — Koyeb and Render

Status: **preparation only.** Nothing in this document has been deployed, pushed,
or run against a live host. It records the exact configuration a deploy needs
for BOTH Koyeb and Render.

Host stance (updated 2026-10-25 — operator's decision recorded):

- **Koyeb — NOT recommended.** Koyeb was acquired by Mistral; the availability of
  new free-tier signups under the new ownership is unclear. Do not build on the
  Koyeb free tier until the operator re-checks its current signup/policy.
- **Render Free + a keep-awake monitor — CHOSEN as the first host.** See §6b for
  the monitor and the free-instance-hours math, and §10 for the deploy checklist.
  Netlify stays a documented fallback (`docs/SERVERLESS_OPTION.md` §Decision).
  This is preparation only: nothing here has been deployed, and the free-plan
  region question (§6a) is still confirmed live in the picker at creation time.

Related docs: `docs/DB_MIGRATION.md` (test → `decoricks_prod` cutover),
`docs/BACKUP_RECOVERY.md`, `docs/KNOWN_LIMITATIONS.md`.

---

## 0. Before any deploy — the two non-negotiables

1. **`MONGODB_DB` must be set explicitly to `decoricks_prod`.** The Atlas
   "Connect" URI has an empty path after the host, so if `MONGODB_DB` is unset
   the driver silently falls back to a database literally named `test`. That is
   the production hazard described in `docs/DB_MIGRATION.md`; do not deploy
   until the cutover there is done and `decoricks_prod` holds the data.
   **This is now enforced, not advisory:** in a real production process
   (`NODE_ENV=production`, not a test runner) `src/instrumentation.node.ts` calls
   `assertProductionRunnable()` before the server is ready and **exits with a
   non-zero code** — refusing to start — when the resolved database is unset,
   the bare `test`, or a `decoricks_test` / `test_*` sandbox. Render therefore
   shows the deploy as **failed** instead of routing traffic to a
   misconfigured instance. `src/lib/mongodb.ts` enforces the same rule per
   request as a second line of defence.
2. **`MONGODB_TEST_DB` must NEVER be set on a host.** `src/lib/db-name.ts`
   refuses to serve a first DB call unless the process is a test runner
   (`NODE_ENV=test` or `E2E_TEST_MODE=1`). On a production host that variable
   would crash the app. It is a test-runner-only switch; keep it out of every
   dev and prod copy of the env. The same reasoning excludes `E2E_TEST_MODE` —
   both must be **absent** in production, and leaving them out is what makes the
   startup gate actually bite.

Required config is validated at boot too: a missing `MONGODB_URI` or
`SESSION_SECRET` (or `SESSION_MAX_LIFETIME_MINUTES < SESSION_TTL_MINUTES`) makes
`getEnv()` throw, which the same startup gate turns into a clean non-zero exit
rather than a half-up server.

The app also pins its process clock: set `TZ=Asia/Karachi` (see §4). The date
layer renders Karachi wall time and re-parses it in the process zone, so a
generic +05:00 name (or UTC) shifts every stored timestamp by hours.

---

## 1. Environment variables (NAMES ONLY — never paste values into a doc/commit)

Secrets (`MONGODB_URI`, `SESSION_SECRET`, VAPID private key, `FOUNDER_PASSWORD`)
go into the host's encrypted secret store, not the repository.

Runtime (server-side, all `process.env`):

| Name                             | Required  | Notes                                                                  |
| -------------------------------- | --------- | ---------------------------------------------------------------------- |
| `MONGODB_URI`                    | yes       | Atlas SRV URI. **SECRET.**                                             |
| `MONGODB_DB`                     | yes       | Set explicitly to `decoricks_prod`.                                    |
| `SESSION_SECRET`                 | yes       | ≥16 chars; signs CSRF tokens. **SECRET.**                              |
| `SESSION_TTL_MINUTES`            | optional  | Default 720 (12h sliding window).                                      |
| `SESSION_MAX_LIFETIME_MINUTES`   | optional  | Default 10080 (7d absolute). Must be ≥ TTL or the app refuses to boot. |
| `SESSION_SLIDE_INTERVAL_SECONDS` | optional  | Default 60.                                                            |
| `PASSWORD_MIN_LENGTH`            | optional  | Default 12.                                                            |
| `BCRYPT_COST`                    | optional  | Default 12.                                                            |
| `LOGIN_MAX_ATTEMPTS`             | optional  | Default 5.                                                             |
| `LOGIN_WINDOW_MINUTES`           | optional  | Default 15.                                                            |
| `LOCKOUT_MINUTES`                | optional  | Default 15.                                                            |
| `TZ`                             | yes       | Exactly `Asia/Karachi`.                                                |
| `MONGODB_TEST_DB`                | **never** | Test-runner only. Must be absent on the host.                          |

Optional Web Push (Phase 9). If unset, push is disabled and the app falls back
to in-app + browser notifications while open:

| Name                           | Required | Notes                                                                                                                                      |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `VAPID_PRIVATE_KEY`            | optional | **SECRET**, server-only.                                                                                                                   |
| `VAPID_SUBJECT`                | optional | e.g. `mailto:…`, server-only.                                                                                                              |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | optional | Inlined into the client **at build time**. Must be present in the BUILD environment, and changing it needs a rebuild, not just a redeploy. |

Do **NOT** put these on the production host runtime env (seed-only, used by
`npm run seed` on a trusted machine):

- `FOUNDER_EMAIL`, `FOUNDER_NAME`, `FOUNDER_PASSWORD` (the last is a secret).

---

## 2. Health check

Both hosts accept an HTTP health-check path. Use the app's **liveness** endpoint
— it deliberately makes **no database round trip**, so a cold start cannot be
marked unhealthy behind a slow first Mongo handshake:

- **Platform health path: `GET /api/health`** (`src/app/api/health/route.ts`).
  Returns `200 { "status": "ok", "uptimeSeconds", "timestamp" }` as soon as the
  Node process is serving HTTP. No DB call, so it is safe for the host's
  automated probe (Render/Koyeb poll this).
- **Operator/deep check: `GET /api/health/database`**
  (`src/app/api/health/database/route.ts`). This DOES call `healthCheck()` (a DB
  `ping`): `200 { database: "healthy" }` when storage is reachable, `503` when
  not. **It is Founder-only now** — the route calls `requireFounder` before doing
  anything, so an anonymous or non-Founder caller gets `401`/`403`, not a status.
  It also leaks nothing: the body carries only a coarse `healthy`/`unreachable`
  verdict plus a timestamp — no cluster name, database name, server version or
  error detail. Use it by hand from a signed-in Founder session; do **not** point
  the platform probe or the keep-awake monitor here (a cold first call can take
  ~1–2s, and it now requires a session). Only `/api/health` stays public.

Set the host health check to `http://<host>/api/health`. Point any uptime /
keep-awake monitor (see §6b) at `/api/health` too — it is the public, DB-free,
instant probe. Do not mark a deploy "live" until `/api/health` is green AND the
startup log line from `src/lib/mongodb.ts` announces the resolved database as
`decoricks_prod` — never `test`. If the process was misconfigured it will have
**exited non-zero at boot** (see §0), so a green `/api/health` already implies a
valid `MONGODB_DB`.

---

## 3. Region — put the app next to the Atlas cluster

MongoDB Atlas and the app host should share (or nearly share) a cloud region so
every request is a short hop, not a trans-oceanic one.

**Atlas region (operator-provided):** **AWS Mumbai `ap-south-1`**, 3-node replica
set — recorded in §3a. It still **cannot be derived from the connection string /
driver** (a read-only probe found the SRV host opaque and `serverStatus` carried
no region token), so its source is the operator's Atlas console, not a probe.

Given `ap-south-1`, pick the closest host region:

- **Koyeb** free instance is offered in **Frankfurt (eu-central)** or
  **Washington, D.C. (us-east)**. Paid/Eco instances add more.
- **Render** offers **Oregon, Ohio, Virginia (US), Frankfurt (EU), Singapore
  (APAC)**. Static sites are on a global CDN (no region to choose). Render does
  **not** let you change a service's region after creation — you redeploy in the
  new region and cut over.

Example mapping (verify your Atlas region first):

| Atlas region                       | Nearest Koyeb                      | Nearest Render   |
| ---------------------------------- | ---------------------------------- | ---------------- |
| AWS eu-central-1 (Frankfurt)       | Frankfurt                          | Frankfurt        |
| AWS us-east-1 / -2 (Virginia/Ohio) | Washington, D.C.                   | Virginia or Ohio |
| AWS ap-south-1 (Mumbai)            | (neither is close; pick Frankfurt) | Singapore        |

---

## 3a. Atlas cluster facts (operator-provided, 2026-10-25)

The operator supplied these directly (they are still not recoverable from the
connection string / driver — see §3):

- Cluster: **Decoricks-Cluster0**, **AWS Mumbai (`ap-south-1`)**, a **3-node
  replica set**.
- Storage: **~9.56 MB of 512 MB** used (M0). A read-only `listDatabases` this
  turn measured **test 3.28 MB + decoricks_test 5.98 MB = 9.26 MB total**, so a
  `decoricks_prod` copy (~3.3 MB) fits with very large headroom. The 512 MB is
  **shared across every database on the cluster**.
- **Atlas cloud backups are INACTIVE on this free cluster.** Therefore the
  encrypted `npm run backup` archives + their `.meta.json` SHA-256 (see
  `docs/BACKUP_RECOVERY.md`) are the **only recovery path**. There is no
  Atlas-managed snapshot to fall back on; a lost backup with a lost passphrase is
  unrecoverable. Keep both the `.enc` file and the passphrase off-machine.
- **Nearest Render region to `ap-south-1` (Mumbai) is Singapore** — the only
  Render region in/near the Indian subcontinent (Oregon/Ohio/Virginia/Frankfurt
  are all far). **To be confirmed in the Render region picker at service-creation
  time** (and see §6a: free-plan availability per region is NOT VERIFIED).
- The **dedicated Atlas database user for the deployed app is NOT created yet.**
  It is only needed at deploy time, not for the Stage-1 copy-and-switch.
  Stage 1 uses the operator's existing connection only; no Atlas user is
  created, changed, or deleted.

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

> **Koyeb is NOT recommended** (see the status block at the top): acquired by
> Mistral, and new free-tier signup availability under the new ownership is
> unclear. Kept here only so the config is on record if the operator re-checks
> and still chooses it.

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
the free _PostgreSQL_ database, which this app does not use (it uses Atlas).
This is a documented claim from Koyeb's page, not something deployed or
measured here.

---

## 6. Build and start — Render

> **Render Free is the staging candidate** (see the status block at the top),
> pending the operator's decision — not a recommendation to deploy.

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

## 6a. Render Free web service — the four questions

Answers are taken from Render's official pages fetched for this section
(`render.com/docs/free` and `render.com/docs/regions`). No host is recommended;
this only records what the free tier does. Items not stated on those pages are
marked NOT VERIFIED.

**1. Is a payment card required to create a free web service?**
No. The official "Create a Free instance" flow is: sign up → _New_ → choose
Web Service → choose the **Free** compute plan → deploy ("That's it!"). No card
or payment-method step appears in that flow, and the same page repeatedly
describes the "if you haven't added a payment method" case (see §2 below),
which only makes sense if a free service can exist without a card.
_Source: `render.com/docs/free`._

**2. Will a free service ever be charged automatically?**
Not for the free instance hours themselves: when the 750 monthly free instance
hours run out, Render **suspends** all free web services until the next month —
it does not bill (source: `/docs/free`, "Free instance hours"). Charges can only
arise from exceeding the workspace's **monthly included outbound bandwidth** or
**build pipeline minutes**, and even then only **if a payment method is on file**:

- Exceed included bandwidth → "Render bills you for a supplementary amount.
  **If you haven't added a payment method, Render instead suspends all of your
  Free services** for the remainder of the month."
- Exceed pipeline minutes → bills a supplementary amount, **unless** no payment
  method / a spend limit is set — then it **disables new builds** instead.

So: **without a payment method, a free web service is never auto-charged** — it
is suspended (services) or has builds disabled, for the rest of the month.
**With** a payment method added, overage beyond the included amounts **can be
billed automatically**. Source: `render.com/docs/free`.

**3. Which regions are available?**
Render's official regions page lists five regions for its services:
**Oregon (US‑West), Ohio (US‑East), Virginia (US‑East), Frankfurt (Germany),
Singapore.** Static sites use a global CDN (no region). A service's region is
chosen at creation and **cannot be changed later** (redeploy in the new region).
**NOT VERIFIED:** whether the **Free** compute plan is selectable in _every_ one
of those five regions — the regions page does not state a free-plan-only subset.
Confirm the region picker during creation before relying on a specific one.
_Source: `render.com/docs/regions`._

**4. Monthly free instance hours**
**750 Free instance hours per workspace per calendar month.** Details from
`/docs/free`:

- A free web service consumes these hours only **while running**; a spun-down
  service does **not** consume them.
- Hours **reset to 750 each month**; unused hours do **not** roll over.
- Exhausting them **suspends** all free web services until the next month.

Related free-tier limits (same page, for context, not a recommendation): the free
web-service plan is **0.1 CPU / 512 MB RAM**; it **spins down after 15 minutes**
with no inbound traffic and takes **~1 minute** to spin up; local filesystem
changes are lost on spin-down/redeploy; rollbacks limited to the two most recent
deploys; no scaling, persistent disks, SSH, or one-off jobs.

---

## 6b. Keep-awake on Render Free (external uptime monitor)

**Decision (recorded 2026-10-25):** Render Free + an external keep-awake monitor
is the chosen first host. Netlify stays a documented fallback
(`docs/SERVERLESS_OPTION.md` §Decision). Nothing here is deployed; this is the
plan of record for when the operator gives the go-ahead.

**Why a monitor is needed.** Quoted from Render's own docs, `render.com/docs/free`
(VERIFIED this turn):

> "Render *spins down* a Free web service that goes 15 minutes without receiving
> any inbound traffic. This includes both HTTP requests and WebSocket messages
> from existing connections."
>
> "A Free web service spins back _up_ whenever it next receives an HTTP request or
> new WebSocket connection. This process takes about one minute."

**How.** A free uptime monitor — **UptimeRobot** (free tier polls as often as every
5 minutes) or **cron-job.org** — sends `GET https://<host>/api/health` on a fixed
schedule shorter than 15 minutes. Use **every 10 minutes** (10 < 15, so the idle
timer never expires and the service never spins down). Point it at **`/api/health`
only** — it is public, makes no DB call, and answers instantly. Do **not** point it
at `/api/health/database` (now Founder-only and heavier, §2) and not at
`/robots.txt` (a spun-down free service gets a canned "disallow all" that does _not_
wake it — VERIFIED, `/docs/free`). The single ping keeps the whole Node process —
and therefore its Mongo pool and change-stream watcher — warm.

**Is this allowed?** Separate what Render actually says from what is inferred:

- **VERIFIED (docs):** spin-down is defined purely by _inbound_ HTTP/WS traffic,
  and inbound requests are normal and expected; **nothing in `/docs/free` or the
  FAQ forbids an external pinger.** A 10-minute `GET /api/health` is just inbound
  traffic.
- **VERIFIED (docs) cautions:** free instances are explicitly "**Do not use … for
  production applications**" (staging posture, not an SLA), and "Render may suspend
  a Free web service that initiates an **uncommonly high volume of traffic over the
  public internet**" — the example given is "Accessing an external database". That
  clause is about **outbound** volume and is qualitative; a 4-user internal tool's
  Atlas traffic is ordinary, but it is the honest reason Free is staging-only.
- **COULD NOT VERIFY:** an explicit Render sentence granting that third-party
  keep-alive pinging is *permitted*, and any numeric egress threshold. The
  terms-of-service page surfaced no keep-alive/abuse clause in this pass. So the
  correct statement is **allowed-by-omission + community-standard practice**, not
  "allowed" as a quoted permission.

**What 750 free instance hours mean for one always-on service.** VERIFIED
(`render.com/docs/free`):

> "Render grants *750 Free instance hours* to each workspace per calendar month …
> A Free web service consumes these hours **as long as it's running** (spun-down
> services don't consume Free instance hours) … [consuming them all] **suspends**
> all of your Free web services until the start of the next month … reset to 750
> [monthly, no rollover]."

- Keeping the service awake means it is *always running*, so it burns hours
  continuously. For **one** service, 24/7: a 30-day month = **720 h**, a 31-day
  month = **744 h**, February = **672 h** — **all ≤ 750.** So a **single**
  always-on free web service **fits inside the monthly 750 and is not suspended on
  instance-hours grounds** — but it sits near the ceiling (only ~6–30 h of slack in
  a long month).
- The 750 is **per workspace and shared**. A **second** always-on free web service
  roughly doubles the draw to ~1,440–1,488 h, so the workspace would hit 750 around
  the 16th and Render would suspend **all** free web services for the rest of the
  month. **Keep Decoricks the only always-on free web service in the workspace.**
- **Without** a monitor, an idle app spends most of the month spun down and uses
  far fewer hours (partners just pay a ~1-minute cold first hit after quiet). The
  monitor trades those hours away for instant response. Build pipeline minutes and
  outbound bandwidth are separate allowances the pings barely touch (inbound
  bandwidth is free — VERIFIED, `/docs/faq`).

**The Mongo pool stays warm while the process is awake.** The driver's connection
pool (`src/lib/mongodb.ts` — `minPoolSize:2`, `heartbeatFrequencyMS:10000`) lives
in the process. Because the monitor never lets the process idle-spin-down, those
connections are never torn down: a real request reuses an established TLS connection
instead of paying the ~300–400 ms handshake + first-query latency the cold path
measures (`docs/SERVERLESS_OPTION.md` §4). Note the ping hits `/api/health`, which
deliberately makes **no** DB call — it keeps the _process_ alive, and the pooled
connections persist simply because the process stays alive. The pool is in-memory,
not a filesystem artifact, so it dies only with the process (spin-down / redeploy /
restart), not from Render's "local files are lost" behavior.

**What partners still see after a deploy or restart.** The monitor prevents **idle**
spin-downs only. It does **not** prevent a **redeploy** (new code/config) or Render's
documented "might restart a Free web service at any time" (VERIFIED, `/docs/free`).
Each tears the process down, so the **first DB-touching request after a
deploy/restart is cold again**: boot `ensureAuthIndexes` + a fresh handshake
(~1–2 s in the local production-build measurement, §10 preamble), the change-stream
watcher reconnects, the in-memory rate-limit buckets and 2 s role cache refill, and
every tab's `EventSource` reconnects. So: expect **one** brief slow first load per
deploy/restart regardless of the monitor, and a momentary gap in instant realtime
that closes on reconnect — while the monitor removes the *idle*-overnight cold
starts entirely.

---

## 6c. First-deploy troubleshooting (Render Free)

Ordered by what actually bites on a first Render Free deploy of this app.
"**VERIFIED**" = quoted from Render's own docs this turn; "**NOT VERIFIED**" =
general Node/Next/Mongo behaviour given as guidance but not found on a Render page
in this pass.

**1. Next.js build runs out of memory on a small instance.**

- Symptom: the build fails with Render's `Out of memory` reason, or the log shows
  `JavaScript heap out of memory`. The Free runtime is **0.1 CPU / 512 MB**
  (VERIFIED, `/docs/free` glossary "`free`: 0.1 CPU / 512 MB RAM").
- **VERIFIED to help** (Render `troubleshooting-deploys`): "If your instance logs
  `JavaScript heap out of memory` errors, Node's heap limit might be lower than
  your instance's available memory. Set `--max-old-space-size=<megabytes>` lower
  than your instance's available memory." On Render set `NODE_OPTIONS=--max-old-space-size=<MB>`
  in the **build** environment. The build runs on Render's **build pipeline**, whose
  memory is separate from the 512 MB runtime — so the heap cap should track the
  _build_ machine, not 512.
- **VERIFIED** (Render `troubleshooting-deploys` / `faq`): an `Out of memory` **build**
  points to "memory limits while building … Pipeline tiers", and "Render also offers
  a **performance pipeline tier** for teams with builds that require additional memory
  and/or CPU" — which "carr[ies] an additional charge and do[es] not provide a monthly
  included amount". So the performance tier is a **paid** escape hatch, not a Free one.
- Cheapest-first, behaviour-preserving levers (**NOT VERIFIED** on a Render page —
  standard Next.js practice): (a) the `NODE_OPTIONS` heap cap above; (b) reduce what
  the build needs (skip source maps / heavy type generation in CI); (c) temporarily
  promote the runtime plan just to prove the build, then drop back to Free. If it
  still OOMs on the standard pipeline, the honest answer is the paid performance
  pipeline tier, or building the artifact elsewhere and shipping a Docker image.
- **COULD NOT VERIFY:** Render's exact free/standard build-pipeline memory number —
  the docs reference `build-pipeline#pipeline-tiers`, which I did not open this pass,
  so pick the heap value by measuring, not from a published figure.

**2. Atlas network-access failures.**

- Symptom at boot: server selection fails — `MongooseServerSelectionError` /
  `Server selection timed out` / DNS errors — and because `getDatabase()` runs at
  startup the process dies.
- Cause is almost always the Atlas **IP allowlist**: Render Free has **no fixed
  static egress IP** (static outbound IPs are a Render paid feature), so the app
  reaches Atlas from addresses Atlas doesn't recognise. Fix per Step 5: add Render's
  published egress range _if_ one exists, otherwise allow `0.0.0.0/0` gated by the
  least-privilege `decoricks_app` user. **NOT VERIFIED** that Render publishes a
  stable per-service egress list on Free — assume it does not.
- Secondary: `mongodb+srv://` needs the driver to resolve `_mongodb._tcp…` SRV/TXT
  records; if SRV lookups are blocked in the environment, use the **standard** Atlas
  connection string (explicit hosts + `replicaSet`). (General MongoDB guidance —
  NOT VERIFIED as a Render page.)
- Also confirm the URI uses the **`decoricks_app`** user (not the console owner
  account) and that its password's special characters are percent-encoded — a raw
  `@`/`:` in the userinfo is a classic silent auth failure. **Never print the URI.**

**3. Boot refusal when `MONGODB_DB` resolves to a test-shaped name.**

- This is **our** guard firing correctly (VERIFIED in this repo): in a real
  production process `src/instrumentation.node.ts` → `assertProductionRunnable()`
  makes the process **exit non-zero** rather than serve the wrong DB, so Render
  marks the deploy **failed** (see §0).
- Symptom: `[startup] refusing to run production against database "test"` (or "no
  explicit database is configured").
- Fix: set `MONGODB_DB=decoricks_prod` explicitly; ensure the `MONGODB_URI` has an
  empty path after the host (so it cannot fall back to `test`); confirm
  `MONGODB_TEST_DB` and `E2E_TEST_MODE` are **absent** on the host (their presence
  marks the process a test runner and would disarm the gate — §0). This failed boot
  is the safety net working, not a bug to route around.

**4. Timezone (TZ).**

- Symptom: dates render ~5 hours off, or the boot log prints the
  `warnIfClockIsNotKarachi()` warning. Render containers default to UTC (VERIFIED,
  `/docs/free`), and `src/instrumentation.node.ts` pins Karachi only when `TZ` is
  _unset_ — it never overrides an explicit value.
- Fix: set `TZ=Asia/Karachi` in Render's environment (§4). A warning still present
  after deploy means the platform handed the process a different zone than the env
  claims.

**5. Cold start after 15 minutes idle (no monitor).**

- Symptom: the first click after a quiet period hangs ~1 minute and may show
  Render's loading page. VERIFIED (`/docs/free` + `faq`): free services "spin down
  … 15 consecutive minutes" and "take about a minute to spin back up"; "Paid compute
  plans do _not_ spin down."
- Fix: run the §6b keep-awake monitor (`GET /api/health` every 10 min). Without it,
  expect the cold first hit; the client already softens it — polling and the offline
  queue replay writes on wake (§8). If a ~1-minute spin-up is still unacceptable to
  the partners, that is the signal to move to a paid always-on plan, not to ping
  harder.

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

- **Your Atlas cluster's region** — now **operator-provided** (`ap-south-1`
  Mumbai, §3a), but still **not recoverable from the connection string or the
  driver**; a probe cannot confirm it independently. Storage measured read-only
  via `listDatabases` (9.26 MB of 512 MB) agrees with the operator's ~9.56 MB.
- **No live deploy** — nothing here was built or run on Koyeb or Render. Cold
  start timings, health-check behavior, and sleep/queue interactions on the
  actual hosts are NOT VERIFIED (described from official docs + client code).
- **Koyeb card requirement & free-tier always-on**, **Render free-tier spin-down
  (15 min), 750 monthly free instance hours and instance-hour suspension**,
  **Railway $5 trial without a card**, and **Fly.io card-required** facts below
  are quoted from each provider's official pages at the time of writing;
  providers change terms, so re-check before committing.
- **Render accepted payment methods** — the "all major credit and debit cards"
  line in §9a is from Render's docs but its `payment-methods` / `billing` /
  `pricing` pages returned 404 when re-fetched for §6a, so the exact accepted-
  methods list is **NOT VERIFIED** this turn. The §6a free-service facts that
  WERE verified come from `render.com/docs/free` and `render.com/docs/regions`.
- **Whether the Render Free plan is selectable in all five regions** — the
  regions page does not state a free-plan subset. NOT VERIFIED (see §6a).
- **Exact free-tier performance** of this Next.js app (512 MB / 0.1 vCPU) under
  its SSE + change-stream load is NOT VERIFIED.

### 9a. Payment / card facts used above (from official pages)

- **Render** — accepts "all major credit and debit cards" (processed by Stripe).
  Free web services need no card to start, but exceed the free allotment / 15-min
  spin-down without a payment method and the free services are suspended for the
  month. Regions: Oregon, Ohio, Virginia, Frankfurt, Singapore.
- **Koyeb** — **NOT recommended** (acquired by Mistral; new free-tier signup
  availability unclear — see the top status block). Historically it **required a
  credit card** ("Why does Koyeb require a credit card? We require a credit card
  to prevent fraud and abuse."), processed by Stripe. Free Web Service was offered
  in Frankfurt or Washington, D.C. (512 MB / 0.1 vCPU / 2 GB SSD) and did not
  auto-scale to zero. Re-check all of this before considering Koyeb.
- **Railway** — Free Trial grants a one-time $5 and can be started without a
  card ("try a free VM without an account"). Paid subscriptions accept **credit
  cards only** ("Railway only accepts credit cards for plan subscriptions").
- **Fly.io** — requires an active, valid **credit card** for most accounts
  (multi-app / public-image deploys); monthly charges are **credit-card only**.
  No general free tier for new users; pay-as-you-go with egress/VM pricing.

No production host is chosen here. **Koyeb is NOT recommended** (Mistral
acquisition, unclear free signups); **Render Free is the staging candidate**,
pending the operator's decision. Whether Render is reachable "without an
international credit card" for YOUR situation depends on the card, and the
always-on vs sleeping choice depends on what the partners will tolerate — both
are the operator's call.

---

## 10. Render — final step-by-step checklist (Free, Singapore)

This is the exact sequence to run when the operator gives the go-ahead. It has
**NOT** been executed — nothing here is deployed. It assumes the `decoricks_prod`
cutover in `docs/DB_MIGRATION.md` is complete and `decoricks_prod` holds the real
records, and that `test` is being kept read-only as the 30-day rollback.

> Local (not Render) measurements that back this checklist, taken 2026-10-25 on
> this working tree with a production build: `next start` honoured `PORT` and
> bound `*:PORT` (all interfaces — the IPv4 `0.0.0.0` equivalent Render needs);
> process launch → "Ready" ≈ 1.2s (Next reports ~0.45s internally); the first DB
> call (the boot-time `ensureAuthIndexes` warming the pool) added roughly 1–2s to
> the very first storage-touching request; `GET /api/health` answered `200` with
> **no** DB round trip; and starting with `MONGODB_DB=test` under
> `NODE_ENV=production` made the process **exit 1 with the startup refusal** and
> leave the port unbound. None of this was run on Render itself.

### Step 1 — Connect the private repo, branch `abdullah`

1. Render dashboard → **New** → **Web Service** → connect the **private** GitHub
   repo for this app (via the GitHub app / OAuth — do not use a fine-grained
   token that lacks the repo).
2. **Branch:** `abdullah` (the deployment branch maintained in
   `docs/DB_MIGRATION.md`). Auto-deploy on push can stay off until the operator
   trusts the pipeline.

### Step 2 — Region (confirm in the picker)

- Choose **Singapore (APAC, `ap-southeast-1`)** — the nearest Render region to
  the Atlas cluster in AWS Mumbai `ap-south-1` (§3a). **You MUST confirm Singapore
  is selectable for the Free plan in the region picker at creation time** — §6a
  records that Render's docs do not state a free-plan region subset, so this is
  unverified until seen live. Region cannot be changed after creation (you would
  redeploy in the new region). If Singapore is not offered on Free, stop and
  reconsider rather than silently picking a far region.

### Step 3 — Runtime, build, start, health

- **Runtime:** Node — pin an LTS the build passes on (local dev is Node 26;
  prefer **Node 20 or 22 LTS** on Render). Set via the dashboard or an
  `.nvmrc`/`engines` entry; the build must be re-run to change it.
- **Build command:** `npm ci && npm run build`
- **Start command:** `npm run start`  (which runs `next start`; it reads `PORT`
  and binds all interfaces — verified locally above).
- **Health check path:** `/api/health`  (liveness, no DB — see §2). Do **not**
  use `/api/health/database` for the platform probe.
- **Instance type:** **Free** (0.1 CPU / 512 MB). Know the tradeoffs (§6a, §8):
  spins down after ~15 min idle, ~1-minute cold start, 750 free instance
  hours/month, rollbacks limited to the last two deploys.

`npm run build` only compiles — no seed, migration, or e2e step runs during build
or start (§4f below). The only boot work is `instrumentation` →
`ensureAuthIndexes` (idempotent index creation), guarded against the build phase.

### Step 4 — Environment variables (names + how to generate each value)

Fill these in Render → Environment. Mark the secrets as **Secret Values**. Never
commit any value. `SESSION_SECRET` must be **fresh and production-only — never
the local one** (a shared secret means sessions/CSRF tokens are forgeable across
environments).

| Name | Value / how to generate |
| --- | --- |
| `MONGODB_URI` | Atlas SRV connection string using the **dedicated `decoricks_app` database user** (least-privilege, see Step 5). **SECRET.** |
| `MONGODB_DB` | Exactly `decoricks_prod`. The startup gate (see §0) refuses to boot if it is unset or test-shaped. |
| `SESSION_SECRET` | A fresh random secret, ≥16 chars: `openssl rand -base64 32`. **SECRET**, production-only. |
| `TZ` | Exactly `Asia/Karachi` (Render defaults containers to UTC otherwise). |
| `NODE_ENV` | `production`. (`next build`/`next start` set it themselves; setting it explicitly documents intent. Do **not** add `NODE_ENV` to any `.env.local` — it breaks local `next build`.) |
| `MONGODB_TEST_DB` | **MUST BE ABSENT.** Test-runner only; setting it on the host crashes the app and would also disarm the startup gate. |
| `E2E_TEST_MODE` | **MUST BE ABSENT.** Same reasoning — it marks the process as a test runner and exempts it from the production DB guard. |
| `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` / `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | **Optional — only if Web Push is wanted.** Leave all three unset to disable push (the app then falls back to in-app + browser notifications). If enabling: generate once with `npx web-push generate-vapid-keys`, paste the public key into `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (must be set in the **build** environment — it is inlined into the client bundle, so changing it needs a rebuild, not just a redeploy), the private key into `VAPID_PRIVATE_KEY` (**SECRET**), and `VAPID_SUBJECT` as a `mailto:` or `https:` contact. |

`FOUNDER_EMAIL` / `FOUNDER_NAME` / `FOUNDER_PASSWORD` are **seed-only** and must
**NOT** be on the host — the Founder already exists in `decoricks_prod` (Step 6).

### Step 5 — Atlas Network Access (and the limited user)

1. **Atlas Database Access:** create a dedicated user `decoricks_app`
   (password authentication) scoped to **least privilege** — e.g. a custom role
   with `readWrite` **only** on `decoricks_prod` (no cluster-level admin, no
   `atlasAdmin`). Give it a **long random password** (e.g. `openssl rand -base64 32`,
   URL-encode before putting it in the URI) — this credential is what bounds the
   open-network fallback in point 2, so it must be strong and never the owner
   account's password. Use this user's credentials in `MONGODB_URI`. Do not reuse
   the owner/admin account the console "Connect" button hands out.
2. **Atlas Network Access (IP allowlist)** — prefer the narrowest option that
   actually exists:
   - **Preferred:** add **Render's published outbound IP ranges** if Render
     exposes a static/published set for the service. On the **Free** plan Render
     does **not** provide a fixed static egress IP (static outbound IPs are a
     paid feature), so this is usually **not available on Free** — check the
     Render service's egress info at deploy time; if a published range exists,
     add each CIDR to the Atlas allowlist and stop there.
   - **Otherwise (typical on Free):** allow `0.0.0.0/0` — the whole network —
     **but only because** the connection is gated by the strong-credential,
     least-privilege `decoricks_app` user with its **long random password** — i.e.
     the network is open, the *account* is not. This is the documented fallback.
     Rotate the `decoricks_app` password periodically and keep its role minimal so
     an open allowlist stays bounded by credentials, not by network position.

### Step 6 — Deploy, then verify the resolved database

1. Trigger the first deploy. Watch the Render build/start logs.
2. In the **runtime logs** confirm the startup line
   `[mongodb] using database "decoricks_prod" (MONGODB_DB)`. If the process
   instead **exits non-zero** with `[startup] refusing to run production against
   database "test"…` (or "no explicit database is configured"), the deploy is
   **correctly failing** — fix `MONGODB_DB` / the URI path, redeploy.
3. `GET https://<host>/api/health` → expect `200 {"status":"ok"}` (public, no DB).
   `GET https://<host>/api/health/database` is **Founder-only** now: open it in the
   signed-in Founder browser (Step 7) → expect `200 {"database":"healthy"}`; a bare
   `curl` with no session correctly returns `401`, and the body never carries a
   cluster/database name, version or error detail.

### Step 7 — First login (no password reset)

The Founder **already exists** in `decoricks_prod` (restored from `test`), and it
was verified this turn that its `mustChangePassword` is **`false`**. So:

- Go to `https://<host>/login` and sign in as **`abdullah@decoricks.com`** with
  the **current** production password. **No forced password change applies** —
  login goes straight to the dashboard; you are not bounced to
  `/change-password`.
- **Do not** create or reset any password, and do not run `npm run seed` against
  the host (seed is for a fresh sandbox and would mark the Founder
  `mustChangePassword: true`). The password lives wherever the operator already
  keeps it; this doc never records it.
- If the Founder ever has `mustChangePassword: true` (a freshly **seeded** db),
  login returns a password-change-required state and guarded routes 403 until the
  change is completed — that is **not** the current `decoricks_prod` state.

### Step 8 — Post-deploy sanity (read-only)

- One login, load the dashboard, confirm live `decoricks_prod` records render
  (not an empty database). Open `/api/health/database` once **as the signed-in
  Founder** (it 401s anonymously now). Do not run write
  smokes against production — the ledger is append-only and real.

### Rollback (Render side)

1. **Code:** Render → Deploys → last green deploy → **Rollback** (Free tier keeps
   the two most recent). Rolling code back never touches the database.
2. **Config:** if the app resolved to `test`, the fix is `MONGODB_DB` (a config
   change + redeploy), not a data operation — the startup gate already stopped it
   serving bad data.
3. **Data:** a data rollback is a **restore** governed by
   `docs/BACKUP_RECOVERY.md` — restore the latest verified pre-change encrypted
   backup into a clean target and re-check counts. Atlas cloud backups are
   **inactive** on this cluster (§3a), so the nightly `decoricks_prod` backup +
   its `.meta.json` SHA-256 are the only recovery path; the untouched `test`
   database is the 30-day safety net (deletable no earlier than **2026-11-24**,
   after a final backup).

### §4f note — nothing data-changing runs automatically

`package.json` has **no** `postinstall` / `prepare` / `prebuild` hooks: `build` is
only `next build` and `start` is only `next start`. `seed`, the migrations, the
`cleanup:e2e` script and `playwright` are separate `npm run` scripts that must be
invoked explicitly (and the writing ones additionally require
`DECORICKS_ALLOW_PROD_DB=1` + a `--confirm`/`--apply` flag). Therefore a Render
`npm ci && npm run build && npm run start` can never seed, migrate, backfill, or
run e2e against `decoricks_prod` on its own.
