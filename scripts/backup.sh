#!/usr/bin/env bash
#
# Scheduled encrypted backup wrapper (Phase 10 Step 4).
#
# Runs the repo's backup script and logs the result. Designed to be launched by
# launchd or cron on the Mac — it changes into the project directory, loads
# nothing from the repo for the KEY (the passphrase file lives OUTSIDE the repo),
# and writes the archive to BACKUP_DIR.
#
# Configure by editing the three lines under "EDIT ME", then point a launchd job
# or a crontab entry at this file. See docs/BACKUP_RECOVERY.md.
set -euo pipefail

# ---- EDIT ME ---------------------------------------------------------------
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DECORICKS_BACKUP_KEY_FILE="${DECORICKS_BACKUP_KEY_FILE:-$HOME/.decoricks/backup.key}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/Dropbox/Decoricks Backups}"
# Which database the nightly backup reads. After the copy-and-switch this is the
# live production database (decoricks_prod), decoupled from whatever a developer's
# .env.local happens to point at — a scheduled job must never silently follow a
# laptop's local database. Override here or in the launchd plist to retarget.
BACKUP_DB="${BACKUP_DB:-decoricks_prod}"
# ---------------------------------------------------------------------------

export DECORICKS_BACKUP_KEY_FILE BACKUP_DIR
# Pin the backup target explicitly. scripts/backup.ts fills MONGODB_DB from
# .env.local ONLY when it is still unset, so this export always wins: the archive
# is taken from $BACKUP_DB regardless of the developer's local .env.local.
export MONGODB_DB="$BACKUP_DB"
cd "$PROJECT_DIR"

mkdir -p "$BACKUP_DIR"

# ---- Backup key safeguard ---------------------------------------------------
# The key file is created ONCE, by hand, and then NEVER regenerated: every
# .enc archive ever taken is only decryptable with this exact key, so
# overwriting or recreating it makes ALL older backups unreadable forever.
# This script only READS it. It refuses (before doing anything else) if the
# key file is missing, empty, or readable by group/world.
if [ ! -f "$DECORICKS_BACKUP_KEY_FILE" ]; then
  echo "$(date -u +%FT%TZ) ERROR: key file not found at $DECORICKS_BACKUP_KEY_FILE" >&2
  echo "       The key file is created once, by hand, and then never regenerated." >&2
  exit 1
fi
if [ ! -s "$DECORICKS_BACKUP_KEY_FILE" ]; then
  echo "$(date -u +%FT%TZ) ERROR: key file is empty: $DECORICKS_BACKUP_KEY_FILE" >&2
  echo "       Refusing to back up with an empty key; restore the original key from where it is archived." >&2
  exit 1
fi
KEY_PERMS=$(stat -f '%Lp' "$DECORICKS_BACKUP_KEY_FILE" 2>/dev/null || stat -c '%a' "$DECORICKS_BACKUP_KEY_FILE")
if [ $((8#$KEY_PERMS & 8#044)) -ne 0 ]; then
  echo "$(date -u +%FT%TZ) ERROR: key file is group/world-readable (mode $KEY_PERMS): $DECORICKS_BACKUP_KEY_FILE" >&2
  echo "       Protect it with: chmod 600 $DECORICKS_BACKUP_KEY_FILE" >&2
  exit 1
fi
# -----------------------------------------------------------------------------

echo "$(date -u +%FT%TZ) backup starting (db: $BACKUP_DB, project: $PROJECT_DIR -> $BACKUP_DIR)"
npx tsx scripts/backup.ts
echo "$(date -u +%FT%TZ) backup finished"

# Keep only the newest 30 archives; remove older ones by modification time.
ls -1t "$BACKUP_DIR"/decoricks-backup-*.enc 2>/dev/null | tail -n +31 | while read -r old; do
  rm -f "$old" "${old%.enc}.meta.json"
done
