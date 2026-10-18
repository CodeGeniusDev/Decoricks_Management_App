# Offline Financial Entry & Notifications — Architecture (Phase 9)

This is the Phase 9 design contract. It expands `SPEC.md` §6 (Offline Sync
Strategy) and §3.1.20/§3.1.21 (the `offlineQueue` and `notifications`
collections), and integrates with the Phase 7 real-time layer documented in
[`REALTIME.md`](./REALTIME.md). Where this document and `SPEC.md` differ, the
divergences are listed up front in **§0** and every one is flagged as a
decision for you, the product owner.

This is Checkpoint 1. Decisions received (18 Oct 2026): **D1** Finance+budget
only; **D2** No server queue; **D3** Sequential; **D5** reorderLevel; **D6** Add
largeExpenseThresholdPkr; **D7 Web Push (VAPID) INCLUDED in Phase 9 Step 2.**
Proceeding to Step 2 (Notifications + Push).

---

## 0. Conflicts and divergences with SPEC.md (READ FIRST)

The brief and the shipping code disagree with parts of `SPEC.md` §6, which was
written as a Phase 1 plan before Phases 3–7 landed. I am not silently picking a
side. Each item below states the conflict, my recommendation, and needs your
call.

### D1 — Offline scope is narrower than SPEC §6.9

`SPEC.md` §6.9 lists these as **supported offline**: create orders, create
expenses, create tasks, create chat messages, update tasks (status/assignee),
update own profile.

The Phase 9 brief says the opposite and much narrower: **only CREATE financial
transactions and budget entries** are offline; editing, reversing, approving and
deleting are online-only; **chat stays online-only**.

This is already partly reconciled by [`REALTIME.md`](./REALTIME.md), which ships
chat as online-only and defers "financial offline entry" to Phase 9. So the code
already agrees with the brief on chat.

- **Recommendation:** follow the brief. Phase 9 offline scope is exactly: create
  a finance ledger entry (income / expense / transfer / partner-withdrawal) and
  create a budget. No offline orders, tasks, chat, edits, reversals, approvals or
  deletes. `SPEC.md` §6.9's broader list is treated as an unimplemented ambition,
  not a requirement, and I will annotate it as superseded in SPEC.
- **Sub-question for you:** is **offline order creation** ("create order at a
  market stall with no signal") something you want later? It is the one item in
  SPEC §6.9 that has real business value beyond finance. My default: **out of
  scope for Phase 9**, revisit as its own phase.

> **DECISION D1:** Confirm offline scope = finance + budget creates only (no
> orders/tasks/chat offline). Confirm offline *order* creation is deferred.

### D2 — The server `offlineQueue` collection (SPEC §3.1.20) is redundant

`SPEC.md` defines a **server-side** `offlineQueue` collection AND a **client**
IndexedDB queue (§6.3) holding the same shape. Storing the full queued payload
again on the server is a second source of truth that can drift from the ledger.

The exactly-once and conflict guarantees that `offlineQueue` was meant to provide
are **already enforced** by mechanisms shipped in Phase 3:

- The `transactions` collection has a **unique-sparse `idempotencyKey` index**
  (`src/lib/models/Ledger.ts:184`), so a replayed create returns the original
  document instead of writing a duplicate — this is what `createLedgerEntry`
  does today (`src/lib/finance-ledger.ts:384`, `:450`).
- The `auditLog` already records every create.

- **Recommendation:** **do not create a durable server `offlineQueue`
  collection.** Failed / conflict sync attempts are recorded as `auditLog`
  entries (already required: "discard … is audit-logged on the server"), and the
  Founder's conflict alert is a `notifications` row. The queue lives only on the
  device. This is simpler and cannot drift. `SPEC.md` §3.1.20 is marked
  superseded (kept for the shape vocabulary only).
- **Alternative (if you want a server-visible sync trail):** a *transient*
  server `syncAttempts` log written by the sync route (idempotencyKey, outcome,
  reason) purely for Founder visibility — not a queue, no re-execution. Only if
  you ask for it.

> **DECISION D2:** Confirm we drop the durable server `offlineQueue` and rely on
> the existing ledger idempotency + audit + notifications. (Optional transient
> sync-attempt log: yes/no.)

### D3 — Sync is sequential, not batched (SPEC §6.7)

`SPEC.md` §6.7 says "Send all pending operations in **batch** … group up to 10
per request." The brief says **sequential, retry with backoff, safe against a
crash mid-sync, never duplicated.**

Batching many independent idempotent creates into one request makes crash
recovery and per-entry status much harder to reason about (a partial batch
success is exactly the ambiguity we must avoid).

- **Recommendation:** follow the brief — **one entry per request, in creation
  order**, each carrying its own `idempotencyKey`. The server processes exactly
  one operation and returns a definite outcome. This is what makes "sent but not
  confirmed → replay safely with the same key → never duplicated" trivially
  correct, because the Phase 3 idempotency already returns the original for a
  replayed key. We forgo the ≤10 batching as a premature optimization for a
  4-person tool.

> **DECISION D3:** Confirm sequential one-at-a-time sync (SPEC §6.7 batching
> dropped).

### D4 — Queue gains a `syncing` state (SPEC §6.3/§6.5 have only four)

SPEC's statuses are `pending | synced | failed | conflict`. The brief adds an
explicit in-flight **`syncing`** state so the UI can show what is being sent
right now and so crash recovery is unambiguous (a row left in `syncing` after a
reload is known to be "was mid-send → replay it").

- **Recommendation:** client queue states are
  `pending | syncing | synced | failed | conflict`. Minor, additive, no conflict
  with intent — noting it for completeness.

### D5 — Low-stock uses `Product.reorderLevel`, not `businessSettings.lowStockThreshold`

`SPEC.md` §3.1.18 lists a single global `lowStockThreshold` and a
`budgetApprovalThreshold`. The **shipped** inventory code does not use a global
threshold: low stock is **per product** against its own `reorderLevel`, compared
against sellable units summed across both locations
(`src/lib/stock-summary.ts:84` `isLowStock`, `:144`). This is a deliberate
improvement already in production (Phase 5).

- **Recommendation:** the `low_stock` notification **reuses**
  `buildStockSummary()` exactly as the dashboard and weekly report do — no new
  threshold logic, no global number. We do **not** wire `lowStockThreshold`.
- **Related:** the brief's "large expense above a Founder-configurable amount"
  **has no field today** — `budgetApprovalThreshold` is in SPEC but absent from
  the implemented `BusinessSettings` model. We must add it. See §2.5 and
  **DECISION D6**.

> **DECISION D5:** Confirm low-stock reuses per-product `reorderLevel` (no global
> threshold).

### D6 — "Large expense above a Founder-configurable amount" needs a new setting

Because there is no implemented absolute-amount threshold anywhere, this event
requires one new Founder-editable field on `businessSettings`.

- **Recommendation:** add `largeExpenseThresholdPkr: number` (integer paisa,
  optional; when unset, the event is disabled) to `BusinessSettings`
  (`src/lib/models/Ledger.ts:104`), surfaced under Settings → Business next to
  the existing budget thresholds. A `withdrawal_request` notification (any
  partner-withdrawal create) is separate and always fires to the Founder (the
  withdrawal route already requires `finance.approve`).

> **DECISION D6:** OK to add a `largeExpenseThresholdPkr` Founder setting? Default
> value? (Suggest: unset = disabled until Founder sets it.)

### D7 — Notification real-time delivery needs a `notifications` scope (SPEC §7 silent)

The Phase 7 live layer carries five permission-gated modules
(`tasks | chat | sales | inventory | finance`), all keyed to `collections`
change-streams and a global per-module cursor
(`src/lib/sync/types.ts:17`, `src/lib/sync/cursor.ts:25`). Notifications are
**per-user**, not per-module, so they do not fit that cursor model unchanged.

- **Recommendation (detailed in §2.6):** reuse the same SSE `/api/events` +
  polling transport, but add a **user-scoped** `notifications` stream whose
  cursor is "newest `createdAt` among *this user's* notifications". No record
  content rides the signal — the client refetches `/api/notifications` through
  the normal authed route, preserving the dataless/permission-safe invariant from
  REALTIME.md. This is an additive extension, not a rewrite.

### Also noted (not conflicts, just honesty)

- `SPEC.md` §1.2 defers "Email/SMS notifications" and "Export to PDF/Excel" out
  of Phase 1 — consistent with this brief (no email/SMS; PDF was added in Phase
  8 as its own phase).
- `SPEC.md` §6.10 line 1468 says "Real-time updates via **WebSocket**"; REALTIME.md
  already corrects this to SSE. Phase 9 uses SSE. No action.

---

## 1. Scope recap (Phase 9)

**In scope**

- Step 2: in-app notification center (bell + unread count + list + read/unread +
  mark-all-read + links + pagination + per-type settings), browser desktop
  notifications (gesture-gated), server-side dedup, delivery over the Phase 7
  layer with polling fallback, permission-aware.
- Step 3: offline **create** of finance ledger entries and budgets; installable
  PWA shell; IndexedQueue (Dexie); a sync engine; a server sync route that
  re-checks everything; a Sync screen; explicit conflict/failure handling;
  device-data security and wipe-on-logout.

**Out of scope (explicitly, per brief)**

- Offline edits / reversals / approvals / deletes / any non-create op.
- Offline chat, offline orders (unless D1 says otherwise), offline tasks.
- Native apps, email/SMS, any paid service, cron/worker that costs money.

---

## 2. Notifications architecture

### 2.1 Data model — extend `notifications` (SPEC §3.1.21)

We keep SPEC's shape and add the two things the brief requires that SPEC omitted:
**a dedupe key** and **read/pagination indexing**.

```javascript
{
  _id: ObjectId,
  userId: ObjectId,          // recipient
  type: String,              // 'low_stock' | 'task_overdue' | … (see 2.4)
  dedupeKey: String,         // server-computed, see 2.7 — THE dedupe mechanism
  title: String,             // human, e.g. "Low stock: Cushion Cover"
  message: String,           // human, e.g. "3 units left (reorder level 8)"
  data: {                    // IDs + labels ONLY — never figures a viewer may not see
    entityType: String,      // 'product' | 'task' | 'transaction' | 'budget' | …
    entityId: String,
    link: String,            // in-app route, e.g. "/inventory?product=…"
  },
  isRead: Boolean,           // default false
  readAt: Date,
  createdAt: Date
}

Indexes:
- { userId: 1, isRead: 1, createdAt: -1 }   // bell list + unread count
- { userId: 1, dedupeKey: 1 } unique         // ← dedupe: same event never twice
- createdAt: -1
```

The unique `{userId, dedupeKey}` index is what guarantees **the same event never
notifies twice**, even if the server wakes, double-fires, or a client tick races.
An insert that violates it is swallowed (a duplicate is *not* an error).

### 2.2 Per-user settings (new home on `users`)

Add to the `users` doc (`src/lib/models/User.ts`):

```javascript
notificationPrefs: {
  low_stock:        { enabled: true },
  task_overdue:     { enabled: true },
  task_due_soon:    { enabled: true },
  budget_warning:   { enabled: true },
  budget_critical:  { enabled: true },
  pending_approval: { enabled: true },
  sync_failure:     { enabled: true },
  sync_conflict:    { enabled: true },
  financial_event:  { enabled: true },
}
```

- `emitNotification()` reads the recipient's prefs and **skips** disabled types.
- Two categories are **not user-muteable** and always fire for the entitled role,
  because they are operational integrity, not preference: `sync_conflict` (to the
  affected user + Founder) and `sync_failure` after the retry budget is exhausted.
  (I'll confirm which are "sticky" in the settings UI copy so users aren't
  surprised.)

### 2.3 Permission-awareness (the hard rule)

A user must never receive — or even learn of — a notification about data they
cannot see. Enforced **server-side at emit time**, mirroring REALTIME.md's
"dataless signal, re-fetch through guarded routes" invariant:

1. Before emitting, resolve the recipient's permission for the notification's
   module (`authorize`-style check at emit time, not at click time). If the
   recipient lacks `<module>.view`, **suppress entirely** — no row, no bell.
2. `data` carries only IDs, labels and an in-app `link`. The numeric payload is
   **never** in the notification; the client opens `link`, which runs the normal
   permission-checked read. If a grant was revoked since emission, the click
   yields a 403 and the list item simply reads "you no longer have access."
3. Role-scoped routing at emit time:
   - low_stock → users with `inventory.view`
   - budget_warning/critical, pending_approval, financial_event, sync_conflict
     (Founder alert) → users with `finance.view` / Founder as appropriate
   - task_overdue / task_due_soon → the task's `assigneeIds` (each checked for
     `tasks.view`)
   - sync_failure / sync_conflict (entry owner) → the `userId` who queued it

### 2.4 Event catalogue and where each is generated

| type               | trigger                                   | recipients        | dedupe (per §2.7)                 |
| ------------------ | ----------------------------------------- | ----------------- | --------------------------------- |
| `low_stock`        | stock event drives a product ≤ reorderLevel | inventory.view   | per product per Karachi day       |
| `task_overdue`     | task dueDate passed, not in a done column | assignees (tasks.view) | per task per Karachi day    |
| `task_due_soon`    | dueDate within 24h, not done              | assignees          | per task once                     |
| `budget_warning`   | a budget's spend crosses `warning`%        | finance.view       | per budget per crossing           |
| `budget_critical`  | crosses `critical`% (default 100)         | finance.view       | per budget once                   |
| `pending_approval` | budget awaiting approval / distribution   | approver (Founder) | per entity once                   |
| `sync_failure`     | an offline entry exhausted its retry budget | entry owner      | per idempotencyKey once           |
| `sync_conflict`    | an offline entry resolved to `conflict`   | owner + Founder  | per idempotencyKey once           |
| `financial_event`  | withdrawal created / distribution locked / expense ≥ largeExpenseThreshold | Founder | per entity once |

**State-based events** (low_stock, budget crossings, pending_approval,
financial_event) are emitted from **server write hooks** — the existing create /
mutate routes call `emitNotification()` after a successful, audited write. This
reuses the exact thresholds already computed for the dashboard:

- budget thresholds come from `loadBudgetThresholds()`
  (`src/lib/budget-queries.ts:16` → `{ warning: 80, critical: 100 }` via
  `business-policy.ts`), and the % used is the same budget-actual computation the
  dashboard and reconciliation already use. **No new math.**
- low-stock comes from `buildStockSummary()` (`src/lib/stock-summary.ts`), whose
  `lowStock` flag is already the source of the dashboard's `lowStockCount`.

**Time-based events** (task_overdue, task_due_soon, and the daily low-stock /
budget sweep) have **no cron on a free host** — handled in §2.8.

### 2.5 Reuse map (what we do NOT rewrite)

- Budget warning/critical thresholds → `loadBudgetThresholds()` +
  `SPEC_DEFAULT_BUDGET_THRESHOLDS` (`src/lib/business-policy.ts:16`).
- Low-stock rule → `isLowStock(totalAvailable, reorderLevel)` inside
  `buildStockSummary()` (`src/lib/stock-summary.ts:84`).
- Overdue rule → the exact Phase 6 board predicate already in the report and
  dashboard: `dueDate` passed AND card not in a `isDoneColumn` column
  (`src/lib/reports/period-report.ts` overdue aggregation; mirrored read-only in
  `src/lib/metrics/dashboard-metrics.ts:403`). No new overdue logic.
- Withdrawal lock → `getWithdrawalLock()` (`src/lib/finance-ledger.ts:281`).
- Delivery → `realtimeBus` + `/api/events` + polling (`src/lib/sync/*`).
- Audit → `recordAuditEntry()` (`src/lib/audit.ts`).
- **New only:** the `largeExpenseThresholdPkr` setting (D6) and the notification
  service + dedupe.

### 2.6 Delivery path (Phase 7 integration)

Notifications ride the existing SSE/poll layer, added as a **user-scoped**
module:

- `SyncModule` gains `'notifications'`.
- `cursor.ts` gains a `notifications` source = `max createdAt` among the caller's
  own notifications (index `{userId, createdAt:-1}`), so the poll answer for this
  user is O(log n) and leaks nothing beyond "you have something newer".
- `/api/events` and `/api/sync/cursor` treat `notifications` specially: instead of
  a `<module>.view` grant, it is permitted for **any authenticated user** (it can
  only ever return *their own* newest timestamp). This is one branch in the
  `PERMISSION` resolution loop, not a fork of the transport.
- On a successful `emitNotification` insert (one that actually wrote, i.e. not
  deduped away), the server calls `realtimeBus.publish('notifications', ts)`.
  The connection filter routes it only to that user's open streams (the signal
  still carries no body).
- The client subscribes via the existing `useRealtimeSync('notifications', …)`
  hook (`src/lib/sync/useRealtime.ts:22`) and refetches
  `GET /api/notifications` (unread count + list) silently in place — no remount,
  no flicker.

Polling fallback is automatic (REALTIME.md): if the stream can't hold (paused
host), the 6s poll carries the same refetch. Nothing new to build there.

### 2.7 Server-side generation + dedupe

`emitNotification(db, { userId, type, dedupeKey, title, message, data })`:

1. Resolve recipient's permission (suppress if not permitted — §2.3).
2. Resolve recipient's `notificationPrefs` (skip if disabled, unless sticky).
3. `insertOne` with `{ userId, dedupeKey }`. On unique-index violation → treat
   as already-notified, return `{ created: false }`. **Never throws.**
4. If created, `realtimeBus.publish('notifications', now)` once.

Because the dedupe is a **unique index**, dedupe survives process restarts and
concurrent server instances writing the same event — the DB is the arbiter.
`dedupeKey` formats:

```
low_stock        →  low_stock:{productId}:{YYYY-MM-DD (Karachi)}
task_overdue     →  task_overdue:{taskId}:{YYYY-MM-DD}
task_due_soon    →  task_due_soon:{taskId}
budget_warning   →  budget_warn:{budgetId}:{category}:{crossedPctBucket}
budget_critical  →  budget_crit:{budgetId}:{category}
pending_approval →  pending:{entityType}:{entityId}
sync_failure     →  sync_fail:{idempotencyKey}
sync_conflict    →  sync_conflict:{idempotencyKey}
financial_event  →  fin:{kind}:{entityId}
```

### 2.8 Time-based events without a cron (honest design)

There is no scheduler on a free host, and the host may sleep. So overdue /
due-soon / daily sweeps are **lazy and idempotent**, evaluated on demand rather
than pushed by a timer:

- **Trigger points:** (a) whenever a client opens/returns to the app and the
  notification cursor poll runs, the server also runs a *bounded, indexed* scan
  for newly-overdue / due-soon tasks and today's low-stock/budget crossings,
  emitting deduped notifications; (b) any finance/inventory/task write in that
  scope (state events, §2.4). We keep the scan **cheap and windowed** — overdue
  tasks ride the existing `{ dueDate: 1 }` + `{ assigneeIds: 1 }` indexes over a
  recent-due window, not a full collection scan.
- **Rate limiting:** the sweep is guarded by a short in-process TTL (e.g. a
  per-user 60s memo) so the 6s poll does not re-scan every 6s.
- **What happens while the server sleeps:** nothing fires — correct and by
  design. The instant the host wakes and the first client poll lands, the sweep
  runs and the dedupe key prevents any backlog from double-notifying. A task that
  became overdue 3 hours ago is notified once, on wake, not 3 times. This matches
  REALTIME.md's reconcile-on-wake model exactly.
- **The honest limit:** a user who never opens the app while the server slept will
  not *receive* the notification until they open it (this is a web app, not push —
  see §10). If we later add Web Push, wake-up fan-out is exactly the gap push
  fills; documented in §10.

### 2.9 Notification APIs (all authed, all permission-checked)

- `GET  /api/notifications?unread=&limit=&cursor=` → list + `unreadCount`
- `POST /api/notifications/:id/read` → mark read (own only)
- `POST /api/notifications/read-all` → mark all read (own only)
- `GET  /api/notifications/preferences` / `PATCH` → per-type on/off
- IDOR guard: every read/write filters `{ _id, userId: <caller> }` — a user can
  never read or mutate another's notifications (explicit test, §12).

---

## 3. Offline financial entry (Step 3 overview)

The full mechanics are §4–§8. Summary of the shape:

- **PWA shell** (manifest + hand-written service worker) — §5.
- **Dexie local queue** in IndexedDB — §4.
- **Sync engine** (one tab leads, sequential, backoff, crash-safe) — §6.
- **Server sync route** `POST /api/offline/sync` re-checking everything and
  delegating to the *existing* `createLedgerEntry` / budget-create logic — §6.4.
- **Sync screen** (pending/synced/failed/conflict + last synced + retry/edit/
  discard) and offline UI states — §7.
- **Device data security + wipe-on-logout** — §8.

The forms the user already knows (`src/modules/finance/EntryFormModal.tsx`,
`src/modules/budget/BudgetFormModal.tsx`) gain an offline path: submit → if
`navigator.onLine` false (or the write is configured offline-first), enqueue to
Dexie with a local UUID + idempotencyKey + `pending`, show the optimistic row
with a clear **"Pending"** badge (never "Saved"), and let the sync engine drain
it.

---

## 4. Local queue design (IndexedDB via Dexie)

**Library:** Dexie (`dexie`, MIT, free, untyped-index wrapper over IndexedDB) —
the brief names it. Plus `crypto.randomUUID()` for the local id. No network
library, no server cost.

One database `decoricks-offline`, one store `queue` (per SPEC §6.3, extended with
`syncing` + `userId`):

```typescript
interface QueueEntry {
  id: string                  // local UUID (Dexie primary key)
  userId: string              // owner — prevents cross-user leakage on shared device
  operation: 'create_finance' | 'create_budget'
  payload: object             // the validated create body (paisa ints, slugs, ids)
  idempotencyKey: string      // SPEC §6.4 format, reused by the server create
  status: 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict'
  attempts: number            // default 0
  lastAttemptAt?: number      // epoch ms
  nextRetryAt?: number        // backoff schedule (§6.3)
  errorMessage?: string       // human reason for failed/conflict
  conflictData?: object       // server state returned on conflict
  createdAt: number
  updatedAt: number
}
```

A `meta` store holds `{ lastSyncedAt, deviceId }`.

- **Not saved until confirmed.** `status` only becomes `synced` after the server
  returns a definite created/replayed result (§6.4). The UI reads `status`, so a
  pending row is never shown as saved.
- **Synced rows are cleared only after confirmation** (SPEC §6.5: "Remove from
  queue after confirmation"). We keep a synced row briefly so the Sync screen can
  show "just synced", then delete it. Failed/conflict rows **stay visible** until
  the user resolves them.
- **IdempotencyKey** is minted once at enqueue time and **never regenerated**, so
  a crash-and-replay re-sends the same key and the server dedupes (§6.5, D3).

---

## 5. Service worker approach (free, versioned, safe updates)

**Hand-written** `public/sw.js` + `public/manifest.webmanifest`, registered in a
client provider. No `next-pwa` / Workbox build plugin — the persistent-Node-host
model (REALTIME.md) makes a plain SW simpler and avoids a build dependency.
Fully free.

**Manifest:** name, short_name, icons (brand only, reuse existing `public/
favicon.*` set + generated PNG sizes), `display: standalone`, theme/background
colors = brand colors (no gradients), `start_url: '/'`, `scope: '/'`.

**Caching model — three zones, by route class:**

1. **Precached app shell** (versioned cache `decoricks-shell-v{n}`): the login
   page HTML, the offline fallback page, core static chunks, fonts, brand assets.
   Installed on `install`, activated (old versions deleted) on `activate`.
2. **Runtime caches (stale-while-revalidate)** for navigational HTML of
   already-visited authenticated screens and hashed immutable assets under
   `_next/static/*` (safe to cache forever — content-hashed filenames).
3. **Never-cached / network-only:** **every `/api/*` response** — financial reads,
   writes, the sync route, notifications, events stream. This satisfies "do not
   cache financial API responses." The service worker explicitly bypasses cache
   for `/api/` and `POST/PUT/PATCH/DELETE` and lets those requests hit the network
   (or fail fast offline, which the queue path handles).

**Update safety (never strand users on a broken old version):**

- Cache name carries a build version `n`. New `install` writes
  `decoricks-shell-v{n+1}`; `activate` deletes every older `decoricks-shell-*`
  and calls `clients.claim()`.
- We do **not** auto-`skipWaiting()` on install (that can swap assets mid-session
  and break a running page). Instead the SW, on finding an update, posts
  `UPDATE_READY` to clients; the UI shows a small "New version available —
  Refresh" prompt (GSAP fade, respects reduced-motion); refreshing (or the user
  clicking the prompt, which posts `SKIP_WAITING`) activates the new version. This
  gives a *controlled* update, no half-swapped cache, no stale-swipe.
- `navigator.serviceWorker.register()` + an `update()` check on app open and
  every N hours (client timer, not SW) to detect new deploys on the sleeping host.

**Offline navigation:** if a navigation request fails and is not in cache, serve a
tiny **offline fallback page** ("You're offline — X entries pending", with a link
to `/sync`). Never a white screen; no flicker between states (§5 UI hooks feed the
same connection store already driving the header chip — `src/lib/sync/connection.ts`).

**Cache versioning & purge:** every deploy bumps `n`; `activate` is the purge.
This is the belt-and-suspenders "redeploy without cache" convention already in the
project memories.

---

## 6. Sync algorithm

Triggers (all call the same idempotent `drainQueue()`): **on reconnect** (`online`
event), **on app open**, **on tab focus / visibility**, **Background Sync** where
supported (best-effort, never relied upon), and a manual "Sync now".

### 6.1 Multi-tab safety — one leader

Several tabs must not sync the same entry twice. Use a **`BroadcastChannel
('decoricks-sync')`** leader election: the first live tab claims the sync lock;
others see `LOCKED` and skip draining but still render queue state (Dexie change
events via `dexie-live-query` or a simple `tables.on('creating')` refresh). On
leader unload, another tab takes over. The lock is advisory; the **real**
guarantee against duplication is the server's idempotency key (D3), so even a
double-send from a race is harmless — it returns the original. Leader election is
about avoiding wasted work and UI flicker, not about correctness of the ledger.

### 6.2 Sequential drain

```
lock → for each entry (status pending|failed|conflict? no) in createdAt order:
         where status == 'pending' or ('failed' and now >= nextRetryAt):
           set status='syncing', attempts++ , lastAttemptAt=now  (persist)
           res = POST /api/offline/sync { id, idempotencyKey, operation, payload }
           handle(res)  // see 6.5
           persist entry (new status)
       unlock; broadcast 'drained'
```

One in flight at a time keeps ordering (SPEC §6.8 "operations within the same
entity processed in creation order") and makes crash recovery unambiguous.

### 6.3 Retry + exponential backoff (SPEC §6.7 schedule)

Attempt N schedules `nextRetryAt = now + delay(attempts)` where
`delay = baseDelay × 2^(attempts-1)`, `baseDelay = 5s`, capped, and after the
**5th failed attempt** the entry flips to `failed` (visible, with reason) and a
`sync_failure` notification fires to the owner (§2.4). Network/5xx failures retry;
**validation/permission/lock conflicts do NOT blind-retry** (§7) — they need user
action, so they short-circuit to `conflict`/`failed` immediately rather than
burning the backoff budget.

### 6.4 Server sync route — re-check everything, trust nothing

`POST /api/offline/sync` (authed, CSRF via the existing `apiFetch` header
mechanism — `src/lib/api-client.ts:64`). Body is one operation. The route:

1. **Re-authenticate** (session cookie) → `401 AUTH_REQUIRED` if gone.
2. **Re-check current permission** server-side: `authorize('finance', type ===
   'partner_withdrawal' ? 'approve' : 'create')` or `authorize('budget','create')`
   → `403 PERMISSION_REVOKED` (this is "permission revoked while offline").
3. **Validate the payload** with the **same zod schemas the online forms use**
   (`src/lib/schemas/finance.ts` `ledgerEntrySchema`, budget schema) → `400
   VALIDATION_ERROR` with field issues ("validation changed").
4. **Delegate to the existing write engines** — NOT a reimplementation:
   finance → `createLedgerEntry(db, parsed, actor)` (`src/lib/finance-ledger.ts:375`)
   which *already* enforces idempotency (returns existing doc, `created:false`),
   accounts must exist+active, category must exist+active+type-match, transfer
   legs differ, and the withdrawal lock (409 `WITHDRAWALS_LOCKED`). Budget create →
   the existing budgets POST logic.
5. **Audit** (the create path already writes audit; the sync route tags it with
   the originating `idempotencyKey` and an `offline: true` marker).
6. Return the definite outcome, and **fire the relevant notifications** (§2.4:
   withdrawal_request, large_expense, budget crossings) — reusing the online
   event emitters so an offline create triggers the same alerts as an online one.

Because it delegates to the same code as the online form, **"offline what I
see online" is structurally guaranteed** — same METRICS §H.2 single-source rule.

**Locked periods / distributions:** the ledger has no period-lock today; the
withdrawal lock is enforced (409). Distributions are approved online-only (out of
offline scope), so a queued op can never collide with a locked distribution. If we
add accounting-period locks later, the sync route is where that check goes (§7).

### 6.5 Mapping outcomes → client state

| server result                    | client state + action                                   |
| -------------------------------- | ------------------------------------------------------- |
| 201 `{created:true}`             | `synced` → clear after grace; refresh via realtime       |
| 200 `{created:false}` (replay)   | `synced` (deduped by key — replay is safe, exactly once) |
| 401 session expired              | **keep queue**; set queue "needs login"; prompt re-login (never wipe) |
| 403 permission revoked           | `conflict` (reason: no access) — stays visible           |
| 400 validation changed           | `failed` with field messages — edit & resubmit           |
| 409 WITHDRAWALS_LOCKED           | `conflict` (reason: locked until date) — stays visible   |
| 409 ACCOUNT/CATEGORY archived    | `conflict` (reason: account/category inactive)           |
| 5xx / network                    | `failed`/backoff retry (transient)                       |

---

## 7. Conflicts and failures — every case, handled explicitly

SPEC §6.6 says financial conflicts require manual resolution — never silent
overwrite, never silent drop. Every non-2xx leaves the entry **visible on the
Sync screen** with a human reason and three actions: **Retry**, **Edit &
resubmit** (re-opens the form with the payload, mints a fresh idempotencyKey
because it is a *new* intended write), **Discard** (confirm modal; if the entry
had ever reached the server — e.g. a conflict — the discard is **audit-logged
server-side** via `POST /api/offline/discard`, else local-only removal).

Enumerated cases (all tested, §12):

- **Permission revoked while offline** → 403 → `conflict` "You no longer have
  access to record this." (No silent drop.)
- **Session expired** → 401 → queue **kept**, banner "Please log in to sync";
  after login the same keys replay safely (D3). Nothing lost.
- **Period / withdrawal locked** → 409 → `conflict` with the lock date; retry
  allowed after unlock.
- **Account or category archived server-side** → 409/400 → `conflict` "Account X
  is inactive — pick another," deep-links the form.
- **Validation rule changed** → 400 → `failed` with the exact field error; edit &
  resubmit.
- **Duplicate key** (already synced) → server returns original (200
  `created:false`) → treated as `synced`, **never duplicated**.
- **Crash mid-send** (row stuck `syncing`) → on reload the drain re-attempts it
  with the same key → idempotent replay → exactly once.
- **Two tabs** → leader drains, others render; even a double-send dedupes by key.

A `sync_conflict` notification fires to the entry owner and (per brief) to the
**Founder**.

---

## 8. Device data: what's stored, protection, clearing

**Stored locally:** only queued creates (ids, paisa integers, category/account
slugs, notes as typed), `meta.lastSyncedAt`, and offline UI prefs.
**Never stored:** access/session tokens, CSRF token, passwords, full ledgers,
cached API responses, other users' data. (Tokens live in `httpOnly` cookies the
page cannot read anyway — `clearSessionCookies` in
`src/app/api/auth/logout/route.ts`.)

**Protection:**

- IndexedDB is **origin-isolated** — no other site can read it; it is not sent to
  any server except as the explicit `/api/offline/sync` payload.
- Entries are tagged with `userId`; the queue is filtered by the current user so
  a shared device does not mix two people's pending rows.
- At-rest: relies on the platform's storage protection (Android app-private
  storage; iOS Data Protection for an installed PWA). For a 4-person internal tool
  the device is treated as trusted; the mitigations are wipe-on-logout and short
  retention. If you want defense-in-depth I can add lightweight field-level
  encryption with a WebCrypto key held in a non-extractable CryptoKey — **noted as
  optional, adds complexity; recommend deferring.**

**Clearing:**

- **Per entry:** after server confirmation (§4/§6.5).
- **On logout:** `signOut()` (in `AuthProvider.tsx:108`) first reads the pending
  count; **if unsynced entries exist, warn** with three choices — "Sync now &
  sign out", "Discard pending & sign out", "Sign out keeping queue" (queue
  persists but is user-scoped). Then `indexedDB.deleteDatabase('decoricks-offline')`
  for the wipe paths, and unregister/update the SW as appropriate.
- **Manual:** "Clear local data" on the Sync screen.
- **Never on transient network error** — a blip must not drop drafts (brief:
  "lost drafts" is a forbidden glitch).

---

## 9. Honest platform limits

**iOS Safari**

- **No Background Sync API** (any iOS version). Sync happens only while a tab is
  alive/open.
- **No Web Push in a browser tab.** Push works **only for an installed PWA** (Add
  to Home Screen) and only **iOS 16.4+**. Before 16.4: no push at all. Even
  installed, notifications only for the home-screen instance, not Safari tabs.
- `navigator.onLine` is unreliable (reports online under captive portals / Wi-Fi
  with no internet). We do not trust it alone — the sync attempt itself is the
  truth signal.
- Service workers + IndexedDB can be **evicted** under storage pressure; the
  queue must therefore be **small** and get drained promptly (it is — creates
  only). iOS also purges SW cache more aggressively than the open web expects.

**Android / desktop Chrome / Edge**

- Full support: Background Sync (deferred send even when app closed, best-effort),
  Web Push (works even when browser closed, via OS), Notification API, Broadcast
  Channel, IndexedDB.
- We use Background Sync when present but **never depend on it** (its timing is
  browser-decided and it silently no-ops on iOS).

**Browser notification permission rules**

- `Notification.requestPermission()` **must** be in response to a **user gesture**
  (we ask only when the user clicks "Enable desktop alerts" in the notification
  settings panel — never on load, per brief).
- States `denied` / `unsupported` handled gracefully: the bell and in-app center
  always work; desktop alerts simply show an explanatory note and stay off.
- **No duplicates across tabs:** only the **leader tab** (§6.1) constructs a
  `new Notification(...)`, keyed by notification `_id` so a re-delivery does not
  spawn a second OS notification.

---

## 10. Web Push (VAPID) vs in-app + browser notifications — recommendation

Two viable, both-free options.

**Option A — In-app center + browser Notification API while open (recommended for
Phase 9 Step 2).**
- What you get: bell, unread counts, full history, per-type settings, and OS
  toasts for the **active** user on desktop/mobile Chrome/Edge/Safari-while-open.
- Cost/complexity: low. Reuses the Phase 7 SSE/poll layer exactly. No subscription
  store, no VAPID keys, no always-on fan-out worker.
- Limit: **nothing reaches a user whose app is closed** (esp. iOS). A partner who
  never opens the app won't see the low-stock alert until they do.

**Option B — Add Web Push (VAPID), free, self-hosted.**
- Library `web-push` (MIT). We generate VAPID keys (free), store per-user
  subscriptions in a `pushSubscriptions` collection, and POST to the browser
  endpoint on emit. Delivers **even when the app is closed** on desktop + Android
  Chrome/Edge, and on **installed iOS PWA (16.4+)**.
- Costs/risks: needs a **persistent always-on process** to fan out push on the
  lazy time-based sweep (§2.8) — which is exactly the thing a free host that
  **sleeps** cannot guarantee. On a sleeping host, background events don't fire,
  so push would be *late*, undermining trust. Adds subscription lifecycle, expiry
  (410) cleanup, and VAPID key management to secure.
- Fits naturally only once you settle on a non-sleeping free-ish host or a small
  VPS.

**Recommendation:** Ship **Option A in Step 2** (it is reliable and free), design
the notification service so that **Option B is a clean add-on** — the emit path
already centralizes through `emitNotification()`, so adding a `deliverPush(userId,
payload)` side-call there later is a small, isolated change. Offer Web Push as an
opt-in **Phase 9.5 / early Phase 10** once the deployment host is chosen, because
its value is gated on always-on infrastructure.

> **DECISION D7 (push):** (a) Ship Option A now, add push later when host is
> settled — **my recommendation**; or (b) include Web Push (VAPID) inside Phase 9
> Step 2 now, accepting that on a sleeping free host it will be delayed/unreliable.
> Which do you want?

---

## 11. Offline UI (Step 3)

- **Online/offline indicator** already in the header (`src/components/layout/
  Header.tsx:120`, driven by `navigator.onLine`); we additionally surface the
  Phase 7 **connection state** (Live / Reconnecting / Offline) so the chip is
  honest about *why* (offline vs reconnecting). No flicker: single shared store.
- **Offline banner** (subtle, GSAP fade, reduced-motion aware) when offline or
  when the queue has pending items.
- **Forms work offline:** submit enqueues with a **Pending** badge (distinct color
  from Success per brand palette; never a plain "Saved"). Row tap → status detail.
- **Sync screen** (`/sync`, new): counts (pending / synced-today / failed /
  conflict), "Last synced: …", each entry with status badge + reason + actions
  (retry / edit / discard), manual "Sync now", "Clear local data", and the
  notification preferences panel lives one tab over in Settings.
- All four states (loading / empty / error / success) per screen; a failing widget
  never blanks the page (Phase 8 pattern).

---

## 12. Testing plan (maps to the brief's TESTS)

**Unit (Vitest, `src/lib/__tests__`):**
- Queue state machine transitions (pending→syncing→synced/failed/conflict),
  incl. crash-in-`syncing` replay path.
- Retry/backoff schedule (`delay = 5000 × 2^(n-1)`, fail after 5, non-retryable
  classes short-circuit).
- Idempotent replay: same key twice → one synced, no dup.
- Notification dedupe against the unique `{userId,dedupeKey}` index (uses
  `mongodb-memory-server`, already a devDep).
- Threshold event logic: budget % crossing warning vs critical buckets;
  low-stock transition using `buildStockSummary` fixtures; large-expense.

**API tests:**
- `/api/offline/sync`: 401/403/400/409 per case; duplicate key returns original
  without creating; permission revoked; locked; archived account/category; a
  partner-withdrawal offline create still honors the withdrawal lock.
- `/api/notifications*`: 401/403; pagination; mark-read/mark-all; **IDOR** — user
  A cannot read/mutate user B's notifications; a revoked-permission user never
  receives (or sees) a notification about an inaccessible record.

**Playwright (Chromium + Mobile Chrome + Tablet, per `playwright.config.ts`):**
- `context.setOffline(true)` → create finance + budget entries → assert Pending
  badges → `setOffline(false)` → assert each syncs **exactly once** (DB shows one
  row per key, ledger totals correct) → Sync screen shows synced.
- Kill network **mid-sync** (route interception returning 5xx after the request
  leaves) → recover → replayed once, no duplicates.
- **Two tabs**: only leader drains; no double create; both render same state.
- Failed + conflict entries appear on the Sync screen with reasons + actions.
- Notification bell + unread count updates live (two contexts/devices, reusing the
  Phase 7 two-context harness) and does not duplicate across tabs.
- Desktop-notification path is exercised at the permission-state level (unsupported
  handled) since headless can't show real OS notifications.
- Responsive at 360 / 768 / 1024 / 1280; no horizontal scroll; 44px targets.
- Console clean: no hydration warnings, no errors.
- **Real phone, airplane mode** — done by **you**, per the brief; I provide the
  exact steps and a verification checklist.

**Gates:** `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`,
`npm run test:e2e` (run with `--reporter=line` per the known HTML-reporter hang).

---

## 13. Remaining open decisions (consolidated)

1. **D1** — Offline scope = finance + budget creates only; offline order creation
   deferred. ✅/✏️
2. **D2** — Drop durable server `offlineQueue`; rely on ledger idempotency +
   audit + notifications. Optional transient sync-attempt log: yes/no.
3. **D3** — Sequential (not batched) sync.
4. **D5/D6** — Low-stock reuses `reorderLevel`; add `largeExpenseThresholdPkr`
   Founder setting (default: unset = disabled).
5. **D7** — Web Push now (Option B) vs later (Option A, recommended).
6. **Storage encryption** — defer (recommended) or add WebCrypto field encryption
   now?

---

## 14. Build ordering (after your approval)

- **Checkpoint 2 (Step 2):** notifications — collection + prefs, `emitNotification`
  service with dedupe, event emitters wired into existing write routes + lazy
  time-sweep, `notifications` sync module, `GET/POST /api/notifications*`, in-app
  bell + center + preferences UI, browser Notification (gesture-gated, leader-tab).
  Tests → show output → **wait**.
- **Checkpoint 3 (Step 3):** PWA (manifest + SW + versioned caches + offline
  fallback) → Dexie queue + sync engine + leader/BroadcastChannel →
  `/api/offline/sync` + `/api/offline/discard` → Sync screen + offline UI states
  + wipe-on-logout. Tests → show output → **wait**.
- **Checkpoint 4:** final gates (typecheck/lint/test/build/full e2e) + real-phone
  verification steps + final report (built / tested / not-done / limits / run-on-
  Windows steps). **No Phase 10.**

---

## 15. Windows (your PC) run notes — final report will expand

Node LTS + `npm ci`; copy `.env.local.example` → `.env.local` (Mongo Atlas
connection string, session/CSRF secrets); `npm run seed` then `npm run dev`. PWA +
service worker require **HTTPS or `localhost`** (both fine on Windows; `localhost`
is a secure context). To test mobile-like offline on Windows: DevTools →
Network → "Offline", or `chrome://serviceworker-internals`. Airplane-mode phone
test is yours. The final report gives exact commands.
