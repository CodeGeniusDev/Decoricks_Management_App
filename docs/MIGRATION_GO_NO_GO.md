# Migration Go / No-Go — Pre-Flight Checklist

**Status: DRAFT. Nothing here has been executed.** This is the short list the
Founder confirms — out loud, item by item — immediately **before** the
`test` → `decoricks_prod` cutover described in `docs/DB_MIGRATION.md`. It runs
the gate, it is not the runbook. The runbook is `docs/DB_MIGRATION.md`; backups
and restores are `docs/BACKUP_RECOVERY.md`; host config is `docs/DEPLOYMENT.md`.

**Rule: every box must be checked GO. A single unchecked box is NO-GO — stop,
do not start the copy.** Do not run the migration, the chat index migration, or
the permission backfill until this page is fully green and signed below.

---

## GO / NO-GO

- [ ] **1. Fresh backup taken.** A new `mongodump`-equivalent encrypted backup of
      the live `test` database was taken **in this window** (not a stale one from
      an earlier day), via `npm run backup` → `…/decoricks-backup-<date>.enc`.
      Confirm the filename and timestamp are today's. (`BACKUP_RECOVERY.md` §2.)

- [ ] **2. Backup integrity verified (SHA-256).** The backup's SHA-256 fingerprint
      was recorded at creation and re-checked after; the dump's per-collection
      row counts and fingerprint match what the script printed. A restore has
      actually been rehearsed into a throwaway sandbox (`--into test_restore_check
--apply`) and reconciled — "a backup you have never restored is just a
      hope." (`BACKUP_RECOVERY.md` §3.) **No production data was touched by the
      rehearsal.**

- [ ] **3. All four partners notified and acknowledged.** Founder, **Hasnat**
      (`partner_hasnat`), **Ali** (`partner_ali`), **Afnan** (`partner_afnan`)
      told in writing before the window, receipt confirmed. They know: app down
      ~15 min, everyone logged out on relaunch (expected), data unchanged.
      (`DB_MIGRATION.md`, "Who must be told".)

- [ ] **4. All servers stopped — nothing can write to `test`.** Every process with
      write access is down: production server (`pkill -f "next start"`), any dev
      server (`next dev`), any Playwright/webServer (`pkill -f playwright`), and
      the hosted app taken offline if deployed. Confirm with a final read that
      `test` write activity has stopped. (`DB_MIGRATION.md` step 2.)

- [ ] **5. Atlas user for `decoricks_prod` created.** — **PENDING, NOT NEEDED FOR
      STAGE 1.** Stage 1 (copy + reconcile) uses the operator's existing
      connection only; it creates a new `decoricks_prod` database via `restore`,
      not a new Atlas user. No Atlas user is created, changed, or deleted in
      Stage 1. This box is required only at **deploy time**, when the hosted app
      needs a dedicated least-privilege Atlas user for `decoricks_prod`. The
      target `MONGODB_DB=decoricks_prod` + `TZ=Asia/Karachi` and absent
      `MONGODB_TEST_DB` (§0/§1) remain deploy-time requirements.
      The Atlas user / role that the production connection string will use has been created and
      can read+write a database named exactly `decoricks_prod` (not `test`).
      (`DEPLOYMENT.md` §0, §1, §3a.)

- [ ] **6. Rollback plan read and ready.** The Founder has re-read the rollback
      path and can execute it without improvising: - Code rollback = re-promote the previous deploy (host); does not touch data. - Data rollback = restore the fresh backup from box 1–2 into a clean target
      and re-verify counts. `test` is kept untouched for 30 days as the fallback.
      (`DB_MIGRATION.md` cutover + `DEPLOYMENT.md` §7, `BACKUP_RECOVERY.md` §4.)

---

## Additional gates (migration-specific, confirm too)

- [ ] **7. Collection counts will be reconciled after the copy.** The expected
      per-collection counts from `DB_MIGRATION.md` (users, roles, sessions,
      messages = 21, transactions, auditLogs = 537 at last audit) are ready to
      compare; any mismatch stops the cutover.
- [ ] **8. Chat index migration + permission backfill are queued for AFTER the
      switch, dry-run first.** `scripts/migrate-chat-clientid-index.ts` and
      `scripts/backfill-role-permissions.ts` run **only** against `decoricks_prod`
      after the app is switched and smoke-tested, and only after their **dry-run**
      output is reviewed. They are not part of the copy itself. (Checkpoint 5
      dry-runs are the reference output.)
- [ ] **9. `DECORICKS_ALLOW_PROD_DB` consent is available** to the Founder for the
      prod-targeting steps, and understood as the explicit human gate.

---

## Decision

- All boxes 1–9 checked: **GO.** Proceed with `docs/DB_MIGRATION.md` in order.
- Any box unchecked or uncertain: **NO-GO.** Fix it or reschedule; do not start.

Signed (Founder): ______________________ Date/time (Asia/Karachi): ____________

> Drafted read-only. No migration, backup, restore, backfill, seed, deploy, or
> database write was performed to produce or validate this checklist.
