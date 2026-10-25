# Database Migration: `test` → `decoricks_prod` (Phase 10 · Step 4)

**Status: PREP + MIGRATIONS EXECUTED on `decoricks_prod` (2026-10-25). NOT DEPLOYED —
the running app and `.env.local` still point at `test`.** The copy-and-verify of
Stage 1 and the index / session / chat / permission work of Stage 2 (see
**Execution log** at the bottom) were run against the new `decoricks_prod` database
only. The final cutover — pointing the host environment at `decoricks_prod` — has
**not** happened; it is still a single `MONGODB_DB` edit away, and `test` remains
the served, untouched rollback.

Today the application's live data lives in an Atlas database literally named
`test`, only because the Atlas connection string has an empty path and the driver
falls back to `test` (see `src/lib/db-name.ts`). This document is the plan to move
that data into a properly named database — `decoricks_prod` — **by copy-and-switch,
never in place.** The old `test` database is left completely untouched and is the
rollback.

Do not run any further `--apply` / write step, and do not flip the host
`MONGODB_DB`, without the operator's explicit go-ahead. Everything below was read
against `test` (never written) or written only to `decoricks_prod`.

---

## Why copy-and-switch instead of a rename

MongoDB has no atomic, safe "rename database" across a live cluster. The reliable,
verifiable operation is: dump → restore into a new database → prove the figures
match → repoint the app → keep the old one as the rollback. That is exactly what
`scripts/backup.ts` + `scripts/restore.ts` already do (Phase 10 Step 4), so this
migration reuses the tested path instead of inventing one.

## The five invariants this plan protects

1. **Read-only until proven.** Only `backup` (reads) and `restore … --into` (writes
   a brand-new empty database) run before the switch. `test` is never written.
2. **Proof before cutover.** The restore re-runs the app's own reconciliation
   against BOTH databases and refuses to call it done unless all checks match.
3. **Instant rollback.** `test` stays intact and untouched for 30 days; `MONGODB_DB`
   points back at it in one edit if anything is wrong.
4. **The app is stopped during cutover.** No writes can land in `test` after the
   backup and before the switch, or the copy is silently stale.
5. **Explicit consent.** Writing `decoricks_prod` is a non-test-shaped target, so
   every write step needs `DECORICKS_ALLOW_PROD_DB=1`. That is the allow-list entry —
   it is never set by default and never set by the app itself.

---

## Prerequisites

- A working encryption key at `~/.decoricks/backup.key` (see `docs/BACKUP_RECOVERY.md`).
- Enough Atlas free-tier storage for BOTH databases simultaneously (`test` + the copy).
- A maintenance window where the app can be stopped for ~15 minutes.
- The `.env.local` currently resolves to `test` (`MONGODB_DB=test`).

---

## Who must be told before the window (all four partners)

This is a scheduled, app-down change that ends everyone's session. Notify **all four
partners** in writing before the window opens, and confirm receipt:

- [ ] The **Founder** operator (runs the cutover; the one person with the encryption
      key and `DECORICKS_ALLOW_PROD_DB` consent).
- [ ] **Hasnat** (`partner_hasnat`)
- [ ] **Ali** (`partner_ali`)
- [ ] **Afnan** (`partner_afnan`)

Tell them, plainly:

1. The app will be **down for ~15 minutes** during the window.
2. After it comes back, **everybody is logged out** (see "End active sessions" below)
   and must log in again. This is expected, not a fault.
3. **Nothing about their data changes** — same records, same screens. Only the
   underlying database name changes (`test` → `decoricks_prod`); no user sees any
   difference in the app itself.
4. If anything looks wrong after the relaunch, they should **stop and call the
   Founder** before editing, so the rollback stays clean.

---

## Runbook (strict order)

Set these once, in the shell, for the whole procedure:

```bash
cd "/path/to/Decoricks_Managment_App"
export DECORICKS_BACKUP_KEY_FILE=~/.decoricks/backup.key
NEW_DB=decoricks_prod
```

### 1 — Fresh, verified encrypted backup of `test`

```bash
npm run backup            # reads test only; writes a .enc + .meta.json
```

Verify the archive before anything else: recompute the **sha256** of the `.enc`
file and confirm it equals the `sha256` recorded in the paired `.meta.json`, and
that `.meta.json` shows the expected collection counts (including the audit-log
row count you are about to assert in step 5). **This archive is the second
rollback**, independent of the live `test` database. Do not continue if the
sha256 does not match the manifest.

### 2 — Stop the app, the dev server, and any Playwright server

Stop every process that can write to `test`:

```bash
pkill -f "next start" || true         # the production server
pkill -f "next dev"  || true          # any open dev server
pkill -f "playwright" || true         # any Playwright/webServer left running
# if hosted: take the app offline / stop the service so no writes land
```

Do not proceed until nothing is writing. A write during the copy makes the new
database stale. Playwright is included because `npm run test:e2e` can boot a
`next start` on its own.

### 3 — Restore into the NEW empty database `decoricks_prod` (explicit allow-list + consent)

First a read-only preview, then the write. `decoricks_prod` is a non-test-shaped
target, so the write needs both the `--into` allow-list entry and the consent flag:

```bash
# 3a. Preview — decrypts and prints counts, writes nothing
npm run restore -- --from backups/decoricks-backup-<timestamp>.enc

# 3b. Apply — writes ONLY the brand-new empty decoricks_prod
DECORICKS_ALLOW_PROD_DB=1 npm run restore -- \
  --from backups/decoricks-backup-<timestamp>.enc \
  --into "$NEW_DB" --apply
```

Two gates protect this step: the **consent gate** (refuses without
`DECORICKS_ALLOW_PROD_DB=1`) and the **empty-target gate** (refuses any target that
already holds documents — a fresh `decoricks_prod` is empty, so it passes; if a
previous attempt half-wrote it, drop the partial `decoricks_prod` and re-run).

### 4 — Reconcile on BOTH databases and confirm all checks match

The `--apply` restore re-runs the app's own reconciliation against **both** `test`
and `decoricks_prod` and prints:

```
DOC-COUNT CHECK: ok
RECONCILIATION CHECK: ok — all N checks pass identically on both databases
```

**Do not continue unless both say `ok`.** A `DIFF` means the copy is not faithful;
abort, keep serving from `test`, and investigate.

### 5 — Confirm the row counts match between `test` and `decoricks_prod`

Independently of the reconciliation, assert these six collections are equal on both
databases (read-only). The audit log had **537 rows** at last check — re-confirm the
live number before trusting it:

```bash
# run against each database by toggling MONGODB_DB, or via a read-only script
# collections: users, roles, sessions, messages, transactions, auditLogs
```

| Collection     | Expected on both sides                        |
| -------------- | --------------------------------------------- |
| `users`        | equal counts                                  |
| `roles`        | equal counts (founder + partner roles)        |
| `sessions`     | equal counts                                  |
| `messages`     | equal counts (21 chat messages at last audit) |
| `transactions` | equal counts                                  |
| `auditLogs`    | equal counts (**537 at last check**)          |

Any mismatch stops the cutover.

### 6 — Switch `MONGODB_DB` to `decoricks_prod`

Edit `.env.local` (and the hosting environment's variable of the same name):

```
MONGODB_DB=decoricks_prod
```

Leave `MONGODB_URI` unchanged. The empty-path fallback to `test` is only reached
when `MONGODB_DB` is unset; setting it explicitly is what performs the switch.

### 7 — End active sessions, then relaunch (what partners will see)

The session secret is per-process and the cutover restarts the app, but sessions are
stored in the database and were copied verbatim, so old session rows would still be
valid on `decoricks_prod`. **Deliberately end every active session** so nobody runs
on a session created against the pre-cutover state:

```bash
# Read-only first: how many active sessions exist
# Then invalidate them in decoricks_prod (this is a WRITE to the NEW db only,
# never to `test`). Example via a one-off tsx script:
#   db.collection('sessions').deleteMany({})
```

What the partners see after this:

- The app reloads and their next request bounces to the **login screen**.
- They log in with the same email/password as before; roles and permissions are
  unchanged (the `roles` documents copied as-is).
- Every screen shows the **same data** as before the cutover — this is the smoke
  test in step 8.

Then start the app and confirm the boot log reads `[mongodb] using database
"decoricks_prod"`.

### 8 — Smoke test against `decoricks_prod` (before touching indexes/permissions)

As Founder, after re-logging in:

- **Login** succeeds; the dashboard loads.
- **Finance:** add a throwaway ledger entry, confirm it saves, then remove it.
- **Sales:** open/create an order; figures match what was seen on `test`.
- **Chat:** channels and messages load; send a message and see it persist.
- **Tasks:** the board renders.

Also confirm via a read that `test` is unchanged (its counts equal the `.meta.json`
from step 1). Only after the smoke test passes do you run the schema work:

### 9 — Only now: chat index migration + permission backfill, on `decoricks_prod` ONLY

Point `MONGODB_DB=decoricks_prod` in the shell for these two scripts, dry-run first,
apply second. They must never run against `test`:

```bash
export MONGODB_DB=decoricks_prod

# 9a. Chat clientId index: sparse -> partial (see the script's own dry-run)
npx tsx scripts/migrate-chat-clientid-index.ts                      # dry-run
DECORICKS_ALLOW_PROD_DB=1 npx tsx scripts/migrate-chat-clientid-index.ts --apply --confirm-backup

# 9b. Role permission backfill (additive, only absent keys)
npx tsx scripts/backfill-role-permissions.ts                        # dry-run
DECORICKS_ALLOW_PROD_DB=1 npx tsx scripts/backfill-role-permissions.ts --apply --confirm-backup
```

Both are dry-run by default and require `--confirm-backup` plus the consent flag to
write. The backfill only adds keys that are entirely absent; it never rewrites an
existing value, so Afnan's deliberate custom `finance`/`budget` grants are preserved.

### 10 — Keep `test` as the rollback for 30 days

Do **not** drop `test`. It is a byte-for-byte copy of the moment before cutover:

```bash
# OPTIONAL, after 30 trouble-free days, and only once the next backup cycle has run:
#   drop database "test"   (mongosh)
```

---

## Rollback (any time during the 30-day window)

The app is switched by a single variable, so rollback is a single edit:

1. Stop the app.
2. Set `MONGODB_DB=test` in `.env.local` / the hosting environment.
3. Restart. You are back on the untouched original in under a minute.
4. Tell all four partners they can log in again (sessions are back on the `test`
   copies).
5. `decoricks_prod` can be dropped and the runbook re-attempted. **Any writes made
   to `decoricks_prod` after step 6 are lost on rollback** — which is exactly why
   step 9's schema migrations are deferred until the smoke test passes.

If `test` were ever lost (it should not be), restore it from the encrypted archive
from step 1 instead:

```bash
DECORICKS_ALLOW_PROD_DB=1 npm run restore -- \
  --from backups/decoricks-backup-<timestamp>.enc --into test --apply
# (test will be non-empty in a partial-migration scenario; drop it first.)
```

---

## What this plan deliberately does NOT do

- It does not rename in place, and it does not touch `test`'s data at any point
  before the 30-day cleanup.
- It does not run the chat migration or the permission backfill until the copied
  database has passed reconciliation, count checks, and the smoke test.
- It does not build the in-app "Export now" button (post-launch; see
  `docs/KNOWN_LIMITATIONS.md`).

---

## Development database (`decoricks_dev`)

`decoricks_dev` is a **fresh seed, never a copy of production.** Real business data
must never be duplicated into a developer's machine.

- Create it by seeding, not restoring:
  ```bash
  MONGODB_DB=decoricks_dev DECORICKS_ALLOW_PROD_DB=1 npm run seed
  ```
  (`seed.ts` refuses to run against a test-shaped DB and needs consent for a
  non-test name like `decoricks_dev`.)
- **Local `.env.local` points at `decoricks_dev` only after the production cutover
  (step 6) is complete and stable**, so day-to-day development never touches `test`
  or `decoricks_prod`:
  ```
  MONGODB_DB=decoricks_dev
  ```
- The automated test runner never uses `decoricks_dev`: E2E is pinned to
  `decoricks_test` by `E2E_TEST_MODE` + `MONGODB_TEST_DB` (see `playwright.config.ts`
  and `src/lib/db-name.ts`), and Vitest uses mocks / an in-memory server.
  `MONGODB_TEST_DB` must never appear in a dev or prod `.env.local`.
- Reset a dev sandbox freely by dropping and re-seeding `decoricks_dev`; there is
  nothing in it worth keeping.

---

## Sign-off checklist (operator)

- [ ] Go-ahead given to execute this runbook.
- [ ] Maintenance window scheduled; app can be stopped (incl. dev + Playwright).
- [ ] All four partners notified in advance and acknowledged.
- [ ] Encryption key confirmed to work (a prior restore check passed).
- [ ] Step 1 sha256 verified against the `.meta.json`.
- [ ] Atlas storage headroom confirmed for the duplicate database.
- [ ] Step 4 reconciliation reported `ok` before cutover.
- [ ] Step 5 six collection counts match (`auditLogs` = 537 at last check).
- [ ] Active sessions ended at step 7; partners told to expect a login prompt.
- [ ] Step 8 smoke test passed before step 9 ran any index/permission write.
- [ ] `test` left untouched; 30-day rollback window started.

---

## Operator environment switch-over (exact steps — NOT yet performed)

Two separate, deliberately different targets. Read carefully: the local machine
and the production host must never point at the same database.

### A. Point a local `.env.local` at `decoricks_dev` (day-to-day development)

`decoricks_dev` is a **fresh seed, never a copy of production.** Do not restore
`test` / `decoricks_prod` into it. Seed it, then edit only `.env.local`:

```bash
cd "/Users/<you>/Online Work/Decoricks/Decoricks_Managment_App"

# 1. Seed decoricks_dev with the Founder from env (consent needed: it is non-test-shaped).
FOUNDER_EMAIL=... FOUNDER_NAME=... FOUNDER_PASSWORD=... \
  MONGODB_DB=decoricks_dev DECORICKS_ALLOW_PROD_DB=1 npm run seed

# 2. In .env.local set exactly this one line (leave MONGODB_URI untouched):
#        MONGODB_DB=decoricks_dev
#    Do NOT add MONGODB_TEST_DB to a dev/prod .env.local — it is for the test runner only.

# 3. npm run dev → the boot log must read: [mongodb] using database "decoricks_dev" (MONGODB_DB)
```

The Founder created by `seed.ts` has `mustChangePassword: true`; the first login
lands on the change-password screen. That is expected.

> **`decoricks_dev` right now is disposable scratch:** it currently holds the
> Stage-2 write-path smoke artifacts (a board/column/task, a chat message, a
> throwaway income entry, products/stock/orders). To hand it to yourself clean,
> drop and re-seed it (there is nothing in it worth keeping):
> ```bash
> # mongosh against the same MONGODB_URI, then:
> use decoricks_dev
> db.dropDatabase()
> # then re-run step 1 above.
> ```

### B. Point the PRODUCTION HOST at `decoricks_prod` (the actual cutover — later)

This is the last, deliberate step, done ONLY on the host environment (never a
blind local edit), and only after the go-ahead. `decoricks_prod` already carries
all its indexes, has had its sessions ended, chat index migrated and role
permissions backfilled, so no migration needs to run at cutover time.

```bash
# In the host's environment manager (Render/Koyeb/systemd/launchd env, NOT .env.local):
MONGODB_DB=decoricks_prod        # leave MONGODB_URI / SESSION_SECRET unchanged
# Do NOT set DECORICKS_ALLOW_PROD_DB in the host runtime — it is a script-only gate.

# Relaunch, then confirm the boot log line: [mongodb] using database "decoricks_prod"
```

Rollback at any time inside the 30-day window is the inverse: set the host
`MONGODB_DB=test`, relaunch, and everyone signs in again against the untouched
original.

---

## Execution log — what actually happened

All actions below read `test` (never wrote it) or wrote `decoricks_prod` /
`decoricks_dev` only. The key at `~/.decoricks/backup.key` was used exclusively
through `DECORICKS_BACKUP_KEY_FILE` and was never printed. `DECORICKS_ALLOW_PROD_DB=1`
was set inline on each write command only. Timestamps are UTC from the tooling.

### Stage 1 (accepted earlier, 2026-10-25) — copy `test` → `decoricks_prod`

- Encrypted backup of `test`: `decoricks-backup-2026-10-25T10-09-00-108Z.enc`
  (sha256 `eeafe10a…ceff692b`, 384,236 bytes; 31 collections / 650 docs; `auditLog`
  557; Atlas storage ~10.27 MB / 512 MB). sha256 verified against its manifest.
- `restore.ts --into decoricks_prod --apply` (empty-target + consent gates passed);
  DOC-COUNT and RECONCILIATION checks reported ok on both sides.
- Note the stale figures in the plan above (`auditLogs` 537, messages 21): the live
  numbers at copy time were **auditLog 557** and **messages 22**.

### Stage 2 (this run, 2026-10-25) — index / sessions / chat / permissions on prod

1. **Drift check** (`test` vs `decoricks_prod` vs the 10:09 manifest): 0 count
   diffs, 0 date diffs, 0 manifest diffs, `auditLog` 557/557 → **NO DRIFT**.
2. **Index check**: confirmed `restore.ts` recreates **no** indexes (it only
   `insertMany`s and skips 0-doc collections), and only `ensureAuthIndexes` runs at
   boot — the rest fire lazily. Built all 13 `ensure*Indexes` on `decoricks_prod`
   via the app's own code (13 ok / 0 failed). Before: only `_id_` present. After:
   every modern index present; the only `test`-vs-`prod` differences are the
   intended modern-vs-legacy ones (chat partial index, task idempotency names,
   push subscriptions) — legacy shapes exist only in `test`.
3. **Switch (verified, not committed to `.env.local`)**: ran the app with inline
   `MONGODB_DB=decoricks_prod`; boot log showed `[mongodb] using database
   "decoricks_prod" (MONGODB_DB)`; `/api/health` 200. Repointed the scheduled
   backup config (`scripts/backup.sh`, the launchd sample, `docs/BACKUP_RECOVERY.md`)
   to `decoricks_prod`; **no launchd job was installed or loaded.**
4. **Read-only smoke on `decoricks_prod`**: Founder login, dashboard, finance list,
   reconciliation panel (10 checks / 0 failing), inventory, chat channels,
   notifications — all 200. No business record was written to `test`; the single
   Founder login added one `sessions` row and one `login_success` audit row.
   **Write-path smoke ran against `decoricks_dev` only** (fresh seed): product 201,
   stock 200, order 201 (`SO-202610-0001`) with an idempotent replay returning
   200 `replay=true`, board/column/task 201 with idempotent replay, chat 201, and a
   throwaway income entry 201 + idempotent replay 200 — **all pass**, proving the
   `*_idempotency_unique` indexes enforce.
5. **End active sessions (`decoricks_prod`)**: dry-run counted **10 active, all the
   Founder's** (9 restored from `test` + 1 from the smoke login); no partner had an
   active session. Applied with `--confirm=decoricks_prod` + consent, refusing a
   mismatched name first. `deletedCount=10`; `sessions` now 0; one append-only audit
   row (`sessions_ended`) recorded.
6. **Pre-migration backup of `decoricks_prod`**:
   `decoricks-backup-2026-10-25T10-47-30-670Z.enc` — sha256 `28079af7…4c77de1e`,
   380,922 bytes, 32 collections / 643 docs; **verified MATCH against manifest**
   (`sessions` 0, `auditLog` 559).
7. **Chat index migration (`decoricks_prod`)**: dry-run showed the desired end state
   already present (partial `messages_channel_client_partial_unique` exists, legacy
   sparse index absent, 0 un-migrated `channelId`); `--apply --confirm-backup` ran as
   a clean idempotent **no-op** (0 channelId backfilled, 0 isDeleted defaulted,
   indexes unchanged, messages still 22).
8. **Backup, then permission backfill (`decoricks_prod`)**: second backup
   `decoricks-backup-2026-10-25T10-49-01-015Z.enc` — sha256 `9c1d86ad…1a46a7f6`,
   **MATCH**. Dry-run printed the exact `permissions.<module>.<action> = <value>`
   adds; `--apply --confirm-backup` added **19 absent keys** (founder 4,
   partner_hasnat 4, partner_ali 4, partner_afnan 7). Diff of full permission maps
   before/after: **0 values changed, 19 added** (pure additions). **Afnan's custom
   `finance`/`budget` grants are byte-identical before and after**, and **no partner
   gained any `users.*` or `finance.*` set to `true`** — the only partner `true` added
   is `tasks.comment`; Afnan's three added `users.*` keys are all `false`.
9. **Final reconciliation + counts (`decoricks_prod`)**: reconciliation **10 checks,
   0 failing**. Per-collection `test` vs `decoricks_prod`: 32 namespaces, exactly **2
   differences**, both expected — `sessions` (test 9 → prod 0, ended in step 5) and
   `auditLog` (test 557 → prod 559, = the step-4 Founder `login_success` + the
   step-5 `sessions_ended` rows). Every business collection matches (messages 22,
   tasks 2, transactions 2, roles 4, users 4…). **Atlas storage** after all writes:
   `decoricks_prod` 2.92 MB; cluster total **16.31 MB / 512 MB (3.2%)** — ample
   headroom for the 30-day dual-`test` rollback window.

**Remaining, gated on the operator:** the host `MONGODB_DB=decoricks_prod` cutover
(section B) and the local `.env.local` → `decoricks_dev` switch (section A). Neither
has been done. `test` is untouched and stays the rollback for 30 days.
