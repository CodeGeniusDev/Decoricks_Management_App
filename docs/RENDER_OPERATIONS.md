# Render Operations Runbook

Everything day-to-day for the live service on Render. This document never
requires you to change code — it is all dashboard/Atlas operations.

Live service: **https://decoricks-management-app.onrender.com**
(database: `decoricks_prod`, DB user: `decoricks_app`).

---

## 0. The two settings that must stay exactly right

| Setting            | Required value                          | Where                                                                                                                                                                         |
| ------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Build Command**  | `npm ci --include=dev && npm run build` | Render dashboard → your service → **Settings** → Build & Deploy → Build Command                                                                                               |
| **`NODE_VERSION`** | `22`                                    | Settings → **Environment** (as an environment variable). This pins the build/runtime image; without it Render may pick a different Node than the one the app was verified on. |

Why the build command has `--include=dev`: `next build` needs the dev
dependencies (TypeScript, etc.). Without them the build fails with a missing
`typescript`/`next` compiler error. If you ever see the Render build log start
with only production installs, this line is the first thing to check.

---

## 1. Reading logs

**Dashboard:** service page → **Logs** tab.

- **Request** logs = every HTTP request with method, path, status and time.
  Good for "did the deploy start serving traffic?".
- **Build** logs = the last build's output. Read this after every deploy; the
  vulnerability summary line ("N vulnerabilities…") appears here.
- **Advanced → View log explorer** (or the Logs tab's type filter) for older
  entries and search. Filter examples: `status>=500`, `POST`, `/api/login`.

**CLI (same data):** `render logs -s <service-name> --tail -f` with
`--type app|build|deploy`. The CLI needs a Render API key — keep it out of
shell history (`render login` once, then nothing to paste anywhere).

What to look for during an incident: a wall of `500`s after a specific deploy
time (bad release), `MongoDB connection` errors (Atlas availability or a bad
credential after rotation), or `Edge Function timed out` lines (middleware).

## 2. Restarting the service

Use this when the app misbehaves but the code is fine (stuck connection,
memory creep). A restart does **not** change what is deployed.

Dashboard → your service → **More → Restart Service** (top-right menu).
Takes ~1–2 minutes; the free instance then cold-starts on the next request
(see §6 about cold starts and monitors).

If the problem is the _build itself_, use **Manual Deploy → Deploy latest
commit** instead — that rebuilds and replaces.

## 3. Rolling back to the previous deploy

Every successful build is kept in the deploy history, so a rollback is instant
and needs no rebuild.

1. Service page → **Deploys** (or "Image & Deploys") tab.
2. Find the last deploy that was known-good (match timestamps against when the
   problem started).
3. Click the **⋯** on that row → **Rollback to This Deploy**.
4. Confirm. Render promotes that existing build; traffic switches after the
   health check passes. Then verify with §8's smoke checklist.

A rollback does not revert Git. Fix forward in a commit afterwards, then deploy
normally — otherwise the next "Deploy latest commit" re-introduces the problem.

## 4. Rotating `SESSION_SECRET`

Two places must match. The app reads it only from the environment.

1. Generate a fresh value locally (prints only; pastes nowhere):
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
2. Render → service → **Settings → Environment** → edit `SESSION_SECRET` →
   paste → **Save**. This triggers a redeploy automatically.
3. **Effect:** every existing session is invalidated — all partners must sign
   in again. Expected; do it at a quiet moment.
4. If you develop locally with the same secret family, update `.env.local` too
   (never committed).

Do not put the new secret in a commit message, a chat, or an issue.

## 5. Rotating the `decoricks_app` Atlas password (and updating Render)

The app's DB user is `decoricks_app` — least-privilege, scoped to
`decoricks_prod`. Rotation order matters: change it in **Atlas first**, then
Render, and expect a brief auth failure window in between.

1. Atlas → **Database Access** → find `decoricks_app` → **Edit** →
   **Edit Password** → **Automatically generate a secure password** (or paste
   one you generated) → **Update User**. Copy the full replacement URI from
   Atlas (it contains the new password) — hold it only in your clipboard or a
   password manager.
2. Render → service → **Settings → Environment** → update `MONGODB_URI` to the
   new full URI → **Save** (redeploys).
3. Wait for the deploy, then confirm `https://decoricks-management-app.onrender.com/api/health`
   returns `{"status":"ok"}` and a login attempt works.
4. If the old password is cached anywhere (local `.env.local`, the launchd
   backup wrapper is **not** — it never uses the app user), update those too
   or rotate a separate credential for them.

The app user's new password must be reflected in `MONGODB_URI` **exactly** —
a mismatch surfaces in the logs as `Authentication failed` for
`decoricks_app`.

## 6. Uptime monitor on `/api/health`, every 10 minutes

The endpoint is unauthenticated and cheap:
`GET https://decoricks-management-app.onrender.com/api/health` →
`200 {"status":"ok"}` (no secrets, no DB dump — see `docs/SECURITY.md`).

Render's built-in uptime monitoring is paid, so use a free external monitor:

1. Sign up at any ping service (UptimeRobot, BetterStack free tier, etc.).
2. Create an **HTTP(s) monitor** with:
   - URL: `https://decoricks-management-app.onrender.com/api/health`
   - Method: GET, expected status **200**, keyword match `"status"` optional
   - Interval: **every 10 minutes**
   - Timeout: **≥ 60 seconds** — a free Render instance sleeps after inactivity
     and the first request wakes it (~30–60 s). A shorter timeout will page you
     on every cold start.
   - Notifications: email (and Slack/WhatsApp if available).
3. Decide who is "on call" for the alert before you need it.

A monitor at exactly 10-minute intervals also keeps the instance semi-warm,
which reduces (does not remove) partner-visible cold starts.

## 7. Watching the 750 free instance hours

The free tier gives **750 instance hours per calendar month per organization**
(shared by all free services — if you only have this one service, that is
roughly one always-on instance).

Where to see it in the dashboard:

1. Render → **Organization** (top-left switcher) → **Billing / Usage** tab.
   There is a **usage bar** showing hours consumed this month vs the free
   quota. As it passes the quota, free services are suspended until the 1st —
   so check it weekly, not when the site goes down.
2. Render emails the organization owner at the usage thresholds; confirm owner
   email is current under **Account → Notifications**.
3. Per-service CPU/RAM under the service's **Metrics** tab tells you _why_ hours
   burn (constant traffic vs restart loops). A crash-looping deploy can eat
   hours fast — check deploy logs if usage spikes.

Stretch the budget: the service sleeps after ~15 min idle (free tier), so
genuine idle time costs nothing; the uptime monitor (§6) is the main consumer.
If the bar still runs low before month-end, either temporarily disable the
monitor or upgrade just this service.

## 8. Read-only post-deploy smoke checklist (signed-in Founder)

Run this within ~5 minutes of any deploy or rollback. **Read-only — do not
create, edit, or delete anything.** Takes two minutes.

- [ ] `/api/health` in a fresh tab returns `{"status":"ok"}`.
- [ ] Log out, then sign in as the Founder from the production URL.
- [ ] **Dashboard** loads: cards render, numbers match what you last entered,
      no skeleton loaders stuck forever.
- [ ] Click every sidebar item once (Finance, Inventory, Sales/Orders, Tasks,
      Chat, Suppliers, Budgets, Weekly Summary, Settings): each list loads with
      data or a proper empty state — no error cards.
- [ ] Chat: open a channel, see the message list, no reconnect banner.
- [ ] Settings → your profile shows your email; the Users tab renders.
- [ ] Browser console (F12): no red errors on those pages.
- [ ] Render → **Logs → Request**: the requests you just made show `200`s (or
      `304`s); no `500`s.
- [ ] The mobile layout: open the site once in a narrow window (or your phone)
      and load the dashboard.
- [ ] Nothing demo-shaped appears: no old demo orders, tasks, or PKR 7,450
      Shopify expense (Stage-2 purge baseline).

Any ✗ = stop, take the Render deploy link + the failing request's log line,
and roll back (§3) if it blocks sign-in or the dashboard.
