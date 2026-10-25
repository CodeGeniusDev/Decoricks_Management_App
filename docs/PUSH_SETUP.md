# Push Notifications — Setup Guide

Who this is for: the owner (to set the keys once) and each partner (to turn
notifications on for their own devices).

Push notifications do not work until the owner puts three environment variables
on the server. Until then every partner sees:

> The owner has not enabled push keys for this deployment yet

That message is correct and normal — it means the server has no keys, not that
the partner did something wrong.

Push is **deployment-wide**: one set of keys for the whole app. The Founder is
affected exactly like everyone else.

---

## 1. How it works (60 seconds)

1. A partner's browser creates a **subscription** (a URL + two keys) and stores
   it in the app (`pushSubscriptions` collection, one row per device/browser).
2. When something happens (a mention, an overdue task, low stock…), the server
   writes a notification row and — best effort — sends the same title and body
   to every stored subscription for that person.
3. The browser wakes `/sw.js` (the service worker), which shows the OS
   notification. Clicking it opens the app on the right screen.

Push is an **add-on**. If it fails, the in-app bell still has every alert.

---

## 2. Owner: generate the keys (once, on your own laptop)

```bash
npx web-push generate-vapid-keys --json
```

It prints a `publicKey` and a `privateKey`. The private key is a secret: never
paste it into chat, an issue, a doc or a commit.

## 3. Owner: put them on Render

Render dashboard → your service → **Environment** → add all three:

| Variable                       | Secret? | Where it is read                               |
| ------------------------------ | ------- | ---------------------------------------------- |
| `VAPID_PRIVATE_KEY`            | SECRET  | server, at runtime. Never sent to the browser. |
| `VAPID_SUBJECT`                | no      | server, at runtime. `mailto:you@decoricks.com` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | no      | **build** time (public key, safe to expose)    |

Rules that matter:

- `VAPID_SUBJECT` must be a `mailto:` or `https:` contact. `web-push` rejects
  anything else, and a subject pointing at `localhost` is rejected by Apple.
- The public key is baked into the build, so add all three **before** you
  deploy, then use **Clear build cache & deploy**. A restart alone used to be
  enough to break push; the app now derives the browser's key from the private
  key at runtime, so a restart is safe — but keep the three consistent anyway.
- Use a **different key pair per environment** (production, staging, a laptop
  test). Keys are not reusable across deployments.

## 4. Partner: turn notifications on

You must do this **once per device and per browser**. There is no "all my
devices" switch.

### Desktop (Chrome or Edge)

1. Open the app and sign in.
2. Click the **bell** in the header.
3. Click **Enable desktop alerts**.
4. The browser asks for permission → **Allow**.

If you clicked "Block" once, the browser remembers it forever. Fix it at
`chrome://settings/content/siteDetails?site=<the app address>` → Notifications →
Ask (or Allow), then reload and try again.

### Android (Chrome)

1. Open the app in Chrome and sign in.
2. Menu (⋮) → **Add to Home screen** → install.
3. Open the installed app, tap the **bell** → **Enable desktop alerts** → Allow.

### iPhone / iPad (Safari)

iOS only allows web push from an **installed** app, and only on **iOS 16.4 or
newer**.

1. Open the app in **Safari** (not Chrome — Chrome on iOS cannot do this) and
   sign in.
2. Tap the **Share** button → **Add to Home Screen** → Add.
3. Open the app **from the Home Screen icon**, tap the **bell** →
   **Enable desktop alerts** → Allow the iOS prompt.
4. Check iPhone **Settings → Notifications → <app>** allows banners, and that
   Focus / Do Not Disturb is off while testing.

### Which alerts arrive

Every notification type can arrive as a push, and the mute switches in the
notification panel apply: a type you muted in the app never pushes. The two
integrity types (sync failure, sync conflict) are always delivered.

---

## 5. Test it (two people needed)

1. Partner A enables notifications on a device, then **closes the tab** (or
   minimises the app on the phone).
2. Partner B opens **Chat**, types `@` + the other person's exact display name
   (for example `@Abdullah Abbad`) and sends.
3. A "You were mentioned" notification should appear on the closed device.

Task alerts are time-based, so they only arrive when the server happens to look
(see §7). A chat mention is instant and is the reliable test.

## 6. If the keys change

- Nobody has to do anything on their devices: existing subscriptions stay valid,
  because the subscription belongs to the browser, not to the sender's key.
- Do it in the **build** environment if you can (add the new values, then
  redeploy) so the baked-in public key matches the private key.
- If the app logs `[push] VAPID drift`, the two do not match. Push still works
  (the derived key wins), but fix the environment variable at the next deploy.
- If you change the **domain** or the app URL, everyone must re-enable: the
  subscription belongs to the old origin.

## 7. Time-based alerts on a free plan (read this)

Overdue tasks, due-soon tasks and low stock are **not** on a timer inside the app.
There is no cron on Render Free, and the instance sleeps when nobody uses it. The
app checks for them "lazily": when someone opens the **notification bell** or the
**dashboard**, the server runs a sweep (at most once every 15 minutes) and fires
everything that has crossed its line.

**You can fix this — §9.** `GET /api/cron/notifications` is the same sweep with an
external clock attached to it. Wire one free monitor at it and the alerts become
time-based; leave it unconfigured and everything below stays true.

Consequences without that timer, stated honestly:

- An overdue task at 03:00 produces its alert at the **next** visit, not at
  03:00.
- The uptime monitor pinging `/api/health` **does not** evaluate anything. That
  endpoint deliberately makes no database call, so it only keeps the process
  awake. It helps the app answer fast; it does not generate alerts.
- A sleeping server sends **no** push at all — for any type — because the code
  that sends it is not running.
- Dedupe means a catch-up after a quiet night produces **one** alert per event,
  never a pile of duplicates.

## 8. Troubleshooting

| What you see                                                  | What to do                                                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The owner has not enabled push keys for this deployment yet" | The server has no `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`. Owner: set them and restart.                                                                            |
| "The browser refused the push subscription"                   | The browser blocked push for the site, or the tab is not on HTTPS. Reset site permission, reload, retry.                                                         |
| "Notifications are blocked in your browser settings"          | Site settings → Notifications → Ask first. On iOS: Settings → Notifications → the app.                                                                           |
| iPhone shows nothing                                          | Not installed from the Home Screen icon, Safari only, iOS 16.4+, Focus off.                                                                                      |
| Works on the laptop, not the phone                            | Each device needs its own enable. Check the phone is signed in to the same account.                                                                              |
| Stopped working after a deploy                                | Old service worker: reload the app once, then re-open the bell. If still dead, disable + re-enable.                                                              |
| Bell has the alert, the OS never showed one                   | Look for `[push] send failed` in the Render log — it now names the HTTP status (401 = VAPID/subject, 410 = the subscription died and was removed automatically). |
| Time-based alerts arrive late                                 | Expected (§7). Someone must open the app, or add the trigger in §9.                                                                                              |
| Nothing at all, no log lines either                           | Check the app is awake (`/api/health`) and that the subscription row exists in `pushSubscriptions`.                                                              |

## 9. The real timer: `GET /api/cron/notifications`

This route exists so a free external cron service can be the clock the app does
not have. It contains **no rules of its own**: the only thing it does is call the
same throttled, deduped sweep the bell already triggers. Anything it detects, it
detects exactly the way opening the app would have — and a monitor polling faster
than every 15 minutes simply gets `executed: false` instead of a second sweep.

### 9.1 Generate the secret (once, on your own laptop)

```sh
openssl rand -base64 32
```

That prints roughly 44 characters. Copy it **once**, straight from the terminal
into Render — never into a chat message, an issue, a commit or a document. The
route requires at least 32 characters: a shorter value is treated as "not
configured", so the route answers 404 and never runs (and Render logs one
`[cron] CRON_SECRET is set but is shorter than the required 32 characters` line
that names neither the value nor its length).

### 9.2 Set it on Render

Dashboard → your service → **Environment** → add key `CRON_SECRET` → paste the
value → **Deploy**. It is read at request time, so no rebuild is needed to change
it, but a restart is: rotate it by editing the variable and redeploying.

**If you never add `CRON_SECRET`, nothing is exposed.** The route answers 404 like
a route that was never built, opens no database connection and runs no sweep. This
is why the variable is optional.

### 9.3 Point a monitor at it (cron-job.org — the free option that works)

| Setting          | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| URL              | `https://<your-app.onrender.com>/api/cron/notifications`  |
| HTTP method      | `GET`                                                     |
| Request header   | Name `x-cron-secret`, Value = your `CRON_SECRET`          |
| Schedule         | Every 15 minutes (hourly is fine; the sweep is throttled) |
| Timezone         | Asia/Karachi — so the business-day boundary is local      |
| Email on failure | On                                                        |

Two facts about cron-job.org that matter, both from their own docs: a job is
**disabled automatically after 25 consecutive failures**, and the request timeout
is **30 seconds**. So a typo in the header value stops the timer quietly after a
few hours — check the job's status if alerts stop arriving. The sweep normally
finishes in well under a second for four partners.

### 9.4 Reading the response

| Answer                       | Meaning                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200` with `executed: true`  | A sweep ran. The three numbers are **how many alerts were created**, per type.                                                                               |
| `200` with `executed: false` | Nothing to do: a sweep already ran within the last 15 minutes. Normal.                                                                                       |
| `404`                        | `CRON_SECRET` is unset or too short. The route is disabled, deliberately invisible, and gives no hint why.                                                   |
| `401`                        | Wrong or missing `x-cron-secret` header. Fix the monitor's header name/value.                                                                                |
| `429`                        | Too many **failed** attempts from that IP in the last minute (10), or process-wide (30). A correct monitor can never reach this — successes are not counted. |
| `503`                        | The sweep or the database failed. **This is the one worth reading the logs for** (`[sweep] notification sweep failed`).                                      |

The body never contains a task title, a product name, a message, a user id or a
link — counts only — so it is safe if the monitor stores response bodies or emails
them to you. The secret you submitted is never written to the app log either.

### 9.5 It also keeps the instance awake

Every hit wakes the Free instance before a partner does, so this route doubles as
the keep-alive in `docs/DEPLOYMENT.md` §6b: with a 15-minute timer in place the
app rarely serves a cold start, and the separate `/api/health` monitor becomes
optional rather than load-bearing. That is a side effect, not the purpose — the
health probe stays the right monitor for "is the app up at all", because it makes
no database call and therefore cannot fail for a data reason.

### 9.6 If you would rather use UptimeRobot

**UptimeRobot's free plan cannot send a custom header** — custom headers are a
paid (Pro / Solo) feature per their own FAQ, and a free HTTP monitor is limited to
GET/HEAD/POST with no header fields. So the header secret above does not work
there. The alternatives, in order of how safe they are, have been written up but
**not implemented**, and one of them needs the owner's decision; see
`docs/DEPLOYMENT.md` §6b. Do not put the secret in a query string without reading
the risk note there: URLs are logged by every proxy and service between the
monitor and the app, response caches and error reports included.

### 9.7 What is verified, and what is not

Verified by tests, offline: the 404-when-unset and 404-when-too-short paths, the
constant-time comparison (inspected at the `timingSafeEqual` call, on fixed-length
digests, even for a guess of a different length), 401/429 behaviour and per-IP
isolation, the counts-only body against an exact key allowlist, that middleware
admits exactly this one path and still refuses every sibling, that 120 one-minute
polls cost 8 sweeps, and that a re-run creates zero duplicate alerts against a
real unique index.

**NOT verified:** anything that needs a real external service. No request from
cron-job.org has actually reached this route, so their header UI, their retry and
timeout behaviour under a real 401, and the Render-side wake-up are all still
unproven — the first time you wire it, watch the Render log for
`[cron] notification trigger accepted` and confirm the monitor shows HTTP 200.

## 10. What has been verified, and what has not

Verified locally against a test database with throwaway keys: a real chat
mention created a real notification row, the server sent a real encrypted Web
Push request whose VAPID signature checked out, the payload decrypted to exactly
the stored title/body/link, and the app's own service worker displayed it with
the tab closed.

**NOT verified by the agent:** anything that needs the real push services or real
phones. FCM (Android/Chrome), Apple's APNs (iPhone), the actual banner on an
iPhone or Android home-screen app, behaviour on the production domain, and
behaviour while the Render instance is asleep. Those need one partner with a real
device, following §4 and §5.

---

## 11. Roman Urdu (short version)

- **Push notifications tabah se kaam nahi kar rahe?** Is ka matlab hai ke owner
  ne server par VAPID keys set nahi ki. Yeh pareshani sab ki hai, Founder ki bhi.
- **Owner ke liye:** laptop par `npx web-push generate-vapid-keys --json`
  chalayein, aur teenon values Render ke Environment mein daal dein.
  `VAPID_PRIVATE_KEY` kabhi kisi ko na bhejein. Phir **Clear build cache &
  deploy** karein.
- **Har partner ke liye:** app khol kar **bell** par click karein, phir
  **Enable desktop alerts** dabayein aur browser ko **Allow** karne dein. Yeh
  har device aur har browser par alag alag karna hai.
- **iPhone:** Pehle Safari mein app khol kar **Add to Home Screen** karein, phir
  Home Screen wale icon se khol kar enable karein. iPhone par push sirf installed
  app mein chalti hai, aur iOS 16.4 ya us se naya hona chahiye.
- **Test:** Koi partner aapka naam `@` ke sath Chat mein likh kar message bheje,
  aur aap tab band kar ke dekhein — notification aani chahiye.
- **Agar keys badal jayein:** sab kuch apne aap theek ho jata hai, dobara enable
  karne ki zaroorat nahi — bas agar app ka URL/domain badle to sab ko dobara
  enable karna hoga.
- **Der se aane wale alerts:** Overdue task aur low stock ke alerts tab hi bante
  hain jab koi app kholta hai (server par timer nahi hai). Chat ka message foran
  aata hai.
- **Timer lagana chahte ho to (§9):** Laptop par `openssl rand -base64 32`
  chalayein, output ko Render ke Environment mein `CRON_SECRET` ke naam se
  daalein, phir cron-job.org par ek free job banayein jo har 15 minute
  `https://<app-ka-URL>/api/cron/notifications` ko GET kare aur uske sath header
  bheje `x-cron-secret: <wahi value>`. Is se alerts waqt par aayenge aur app
  soti bhi nahi. **Yeh secret kabhi kisi ko na bhejein** — yeh login password
  jaisa hai.
- **UptimeRobot free is kaam ke liye nahi:** Free plan mein custom header nahi
  bheja ja sakta, sirf paid plan mein. Secret URL mein `?secret=...` likh kar
  kabhi na daalein — URL har jagah record hota hai.
