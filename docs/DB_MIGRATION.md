# Database Migration: `test` → `decoricks_prod` (Phase 10 · Step 4)

**Status: PLAN ONLY — NOT EXECUTED. Awaiting the operator's explicit go-ahead.**

Today the application's live data lives in an Atlas database literally named
`test`, only because the Atlas connection string has an empty path and the driver
falls back to `test` (see `src/lib/db-name.ts`). This document is the plan to move
that data into a properly named database — `decoricks_prod` — **by copy-and-switch,
never in place.** The old `test` database is left completely untouched and is the
rollback.

Nothing here has been run. Do not run any `--apply` / write step without the
go-ahead.

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

## Runbook

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

Confirm the printed sha256 and that `.meta.json` shows the expected
collection counts. **This archive is the second rollback**, independent of the
live `test` database.

### 2 — Stop the application

Stop every process that can write to `test`:

```bash
# if running locally
pkill -f "next start" || true
# if hosted: take the app offline / stop the service so no writes land
```

Do not proceed until nothing is writing. A write during the copy makes the new
database stale.

### 3 — Dry-run the restore (writes nothing)

```bash
npm run restore -- --from backups/decoricks-backup-<timestamp>.enc
```

Expected: it decrypts the archive and prints `source database "test"`, the
collection and document counts, then `DRY-RUN. Nothing written.`

### 4 — Restore into the NEW empty database + reconcile

```bash
DECORICKS_ALLOW_PROD_DB=1 npm run restore -- \
  --from backups/decoricks-backup-<timestamp>.enc \
  --into "$NEW_DB" --apply
```

What this does, and the two gates it must clear:

- **Consent gate:** `decoricks_prod` is not test-shaped, so it refuses without
  `DECORICKS_ALLOW_PROD_DB=1` (the explicit allow-list entry).
- **Empty-target gate:** it refuses any target that already holds documents. A
  fresh `decoricks_prod` is empty, so this passes. If you re-run after a failed
  attempt, drop the half-written `decoricks_prod` first.
- After writing, it prints `DOC-COUNT CHECK: ok` and
  `RECONCILIATION CHECK: ok — all N checks pass identically on both databases`,
  comparing `test` and `decoricks_prod` paisa-for-paisa.

**Do not continue unless both say `ok`.** A `DIFF` means the copy is not faithful;
abort and keep serving from `test`.

### 5 — Point the app at the new database

Edit `.env.local` (and the hosting environment's variable of the same name):

```
MONGODB_DB=decoricks_prod
```

Leave `MONGODB_URI` unchanged. The empty-path fallback to `test` is only reached
when `MONGODB_DB` is unset; setting it explicitly is what actually performs the
switch.

### 6 — Smoke test against `decoricks_prod`

Start the app and verify, as Founder:

- Login succeeds; the dashboard loads.
- Finance figures match what was seen on `test` (same reconciliation numbers).
- Suppliers, budgets, sales, chat, settings screens render with real data.
- A write works (e.g. create a throwaway task comment or a test transaction, then
  undo it) — confirming the app is writing to `decoricks_prod`, not `test`.
- Boot log shows `[mongodb] using database "decoricks_prod"`.

Also confirm via a one-line read that `test` is unchanged (its counts are exactly
what the backup `.meta.json` recorded).

### 7 — Keep `test` as the rollback for 30 days

Do **not** drop `test`. Rename it for clarity if you like, but do not delete it:

```bash
# OPTIONAL, after 30 trouble-free days, and only once the next backup cycle has run:
#   drop database "test"   (mongosh)
```

Until then it is a byte-for-byte copy of the moment before cutover.

---

## Rollback (any time during the 30-day window)

The app is switched by a single variable, so rollback is a single edit:

1. Stop the app.
2. Set `MONGODB_DB=test` in `.env.local` / the hosting environment.
3. Restart. You are back on the untouched original in under a minute.
4. `decoricks_prod` can be dropped and the runbook re-attempted.

If `test` were ever lost (it should not be), restore it from the encrypted
archive from Step 1 instead:

```bash
DECORICKS_ALLOW_PROD_DB=1 npm run restore -- \
  --from backups/decoricks-backup-<timestamp>.enc --into test --apply
# (test will be non-empty in a partial-migration scenario; drop it first.)
```

---

## What this plan deliberately does NOT do

- It does not rename in place, and it does not touch `test`'s data at any point
  before the 30-day cleanup.
- It does not change any application code — the switch is one environment variable.
- It does not build the in-app "Export now" button (post-launch; see
  `docs/KNOWN_LIMITATIONS.md`).

## Sign-off checklist (operator)

- [ ] Go-ahead given to execute this runbook.
- [ ] Maintenance window scheduled; app can be stopped.
- [ ] Encryption key confirmed to work (a prior restore check passed).
- [ ] Atlas storage headroom confirmed for the duplicate database.
- [ ] Step 4 reconciliation reported `ok` before cutover.
