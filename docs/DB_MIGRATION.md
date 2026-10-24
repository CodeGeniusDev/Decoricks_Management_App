# Database Migration: `test` → `decoricks_prod` (Phase 10 · Step 4)

**Status: PLAN ONLY — NOT EXECUTED. Awaiting the operator's explicit go-ahead.**

Today the application's live data lives in an Atlas database literally named
`test`, only because the Atlas connection string has an empty path and the driver
falls back to `test` (see `src/lib/db-name.ts`). This document is the plan to move
that data into a properly named database — `decoricks_prod` — **by copy-and-switch,
never in place.** The old `test` database is left completely untouched and is the
rollback.

Nothing here has been run. Do not run any `--apply` / write step without the
go-ahead. Every step below is read-only or writes only a brand-new empty database
until the cutover, and the cutover is a single environment variable.

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

| Collection   | Expected on both sides                       |
| ------------ | -------------------------------------------- |
| `users`      | equal counts                                 |
| `roles`      | equal counts (founder + partner roles)       |
| `sessions`   | equal counts                                 |
| `messages`   | equal counts (21 chat messages at last audit) |
| `transactions` | equal counts                               |
| `auditLogs`  | equal counts (**537 at last check**)         |

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
