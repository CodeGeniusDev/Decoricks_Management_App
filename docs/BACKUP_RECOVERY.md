# Backup & Recovery (Phase 10 · Step 4)

This is how you protect the Decoricks database and how you get it back.
Everything here runs on your Mac with the tools already in this project — no
paid service, no `mongodump` binary to install.

---

## The one rule to remember

**Your backups are encrypted. The key is NOT in this folder and NOT in Git.**

If you lose the key, the backup is unreadable — permanently. Keep the key file
somewhere safe and separate from the backups themselves (a password manager, or
`~/.decoricks/backup.key` on a disk you also back up).

---

## 1. Make your encryption key (once)

Open Terminal and run:

```bash
mkdir -p ~/.decoricks
umask 077
node -e "console.log(require('crypto').randomBytes(24).toString('base64'))" > ~/.decoricks/backup.key
cat ~/.decoricks/backup.key   # sanity-check it is not empty
```

That file is your key. Store a copy in your password manager now.

---

## 2. Take a backup

From the project folder:

```bash
DECORICKS_BACKUP_KEY_FILE=~/.decoricks/backup.key \
BACKUP_DIR="$HOME/Decoricks Backups" \
npm run backup
```

You get two files per run, in `BACKUP_DIR`:

- `decoricks-backup-<date>.enc` — the whole database, encrypted (this is the backup).
- `decoricks-backup-<date>.meta.json` — a plain text list of every collection and
  how many rows it had, plus a SHA-256 fingerprint. No secrets in it; it just lets
  you confirm a future restore brought back the same row counts.

This step only **reads** the database. It never changes anything.

---

## 3. Check a backup can actually be restored (do this periodically)

A backup you have never restored is just a hope. Restore it into a **separate,
empty database** — never over the live one — and let the script prove the numbers
match. It is dry-run by default, so nothing happens until you add `--apply`:

```bash
# See what it would do (writes nothing):
DECORICKS_BACKUP_KEY_FILE=~/.decoricks/backup.key \
npm run restore -- --from "$HOME/Decoricks Backups/decoricks-backup-<date>.enc"

# Actually restore into a NEW sandbox database and reconcile it:
DECORICKS_BACKUP_KEY_FILE=~/.decoricks/backup.key \
npm run restore -- --from "$HOME/Decoricks Backups/decoricks-backup-<date>.enc" \
  --into test_restore_check --apply
```

The script then prints a table comparing the original and the restored copy and
**re-runs the app's own reconciliation checks on both**. You want to see:

```
DOC-COUNT CHECK: ok — every collection restored exactly the dumped count
RECONCILIATION CHECK: ok — all N checks pass identically on both databases
```

Safety built into `restore`:

- Dry-run unless you pass `--apply`.
- `--into` must be a throwaway name starting with `test_` (or you must set
  `DECORICKS_ALLOW_PROD_DB=1`). It will not target production by accident.
- It refuses any database that already contains data, so a restore can never
  quietly mix into live records.

To delete the sandbox after checking:

```bash
# from mongosh, or a one-liner with the driver:
#   db.getSiblingDB("test_restore_check").dropDatabase()
```

---

## 4. Restore the whole system after a disaster

If the production database is lost, restore it **into a fresh empty database**
first, confirm the counts and reconciliation match the last `.meta.json`, then
point the app at it (`MONGODB_DB` in `.env.local`) or move the data over. Never
restore straight on top of a database that still has rows in it — use a new name
and switch over only after the checks pass.

---

## 5. Put it on a schedule (so you never have to remember)

`scripts/backup.sh` wraps step 2 and keeps only the newest 30 archives.

### Option A — launchd (recommended on macOS)

```bash
cp scripts/launchd/com.decoricks.backup.plist.example ~/Library/LaunchAgents/com.decoricks.backup.plist
# edit the paths inside it (your project folder, your key file, your backup folder)
launchctl load ~/Library/LaunchAgents/com.decoricks.backup.plist
launchctl start com.decoricks.backup   # test it once right now
```

The template runs every night at 03:15 and catches up when the Mac wakes.

### Option B — cron

```cron
# 03:15 every day
15 3 * * *  cd "/path/to/Decoricks_Managment_App" && DECORICKS_BACKUP_KEY_FILE="$HOME/.decoricks/backup.key" BACKUP_DIR="$HOME/Decoricks Backups" /bin/bash scripts/backup.sh >> /tmp/decoricks-backup.log 2>&1
```

cron on a laptop only fires when the machine is awake at that minute; launchd is
better because it runs missed jobs on wake.

---

## What is deliberately NOT here yet

- **A "Export now" button inside the app.** The Founder-only, audit-logged export
  is specified, but it is a new product feature and is being held for separate
  sign-off. The CLI in step 2 already produces the same encrypted archive.
- **Renaming the live database from `test` to `decoricks_prod`.** This is a real change
  to production data and is intentionally left for an approved, backed-up step —
  it has NOT been done. The full copy-and-switch runbook (and rollback) is
  `docs/DB_MIGRATION.md`; take a verified backup (steps 2 and 3) before it is
  attempted.

---

## Reference

| Command                                                 | Purpose                                | Writes?           |
| ------------------------------------------------------- | -------------------------------------- | ----------------- |
| `npm run backup`                                        | encrypted full-database dump + meta    | reads only        |
| `npm run restore -- --from X`                           | preview a restore                      | reads only        |
| `npm run restore -- --from X --into test_check --apply` | restore into a sandbox + reconcile     | new empty DB only |
| `scripts/backup.sh`                                     | scheduled wrapper, prunes to 30 newest | reads only        |

Environment: `DECORICKS_BACKUP_KEY_FILE` (preferred) or `DECORICKS_BACKUP_KEY`
(ephemeral), `BACKUP_DIR` (where archives land). The source database is resolved
from `.env.local` exactly like the app does.
