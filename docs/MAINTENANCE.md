# Decoricks Management App — Maintenance Guide

For the **Founder** (or whoever operates the deployment). This is the routine
care of a live app on **Render Free + MongoDB Atlas M0**. Do these things here
rather than improvising — the app reads its configuration from environment
variables and a small set of scripts, and most mistakes come from editing the
wrong one.

> **Golden rules**
>
> - **Never put a real secret in Git or in this repo.** Secrets live in Render's
>   environment settings and Atlas, and in `.env.local` on your own machine.
> - **Never print secret values** into chat, logs, screenshots or tickets —
>   names only. If a value was ever exposed, rotate it.
> - **Backups are the only copy.** Atlas cloud backups are inactive on M0
>   (see `docs/KNOWN_LIMITATIONS.md`). Take the nightly encrypted backup seriously.

---

## 1. Add (or deactivate) a user

1. Sign in as Founder → **Settings → Users & Roles → Add user**.
2. Fill **Name**, **Email**, pick a **Role**, and set a **temporary password**.
3. Press **Create user**. The person signs in with that temporary password and
   the app **forces a password change on first sign-in**.
4. To remove access later, **deactivate** the user (they can no longer sign in)
   rather than deleting — this preserves the audit trail and their ledger entries.
5. If their access should change, edit **Role** here, or fine-tune the role's
   grants in **Settings → Permissions** (that changes it for the whole role).

> The initial seed only provisions the **Founder** account and the four **role**
> documents. Hasnat / Ali / Afnan logins are created here, not by `npm run seed`.

---

## 2. Rotate secrets

Rotate a secret when someone leaves, when a value may have leaked, or on a
regular schedule. **You change the value in two places that must match: the
secret's home, and wherever the app reads it.**

### 2a. `SESSION_SECRET`

This signs CSRF tokens and session data. Minimum 16 chars; generate 32 bytes.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

1. Copy the printed value (do **not** paste it anywhere public).
2. Render → your service → **Environment** → update `SESSION_SECRET` → **save**
   and redeploy.
3. **Effect:** every existing session is invalidated — all partners must log in
   again. That is expected and safe. Rotate at a quiet moment.
4. Update the value in your local `.env.local` too, if you develop locally.

### 2b. Atlas `decoricks_app` password (the app's DB user)

The application connects as the **least-privilege** `decoricks_app` user. Its
password is embedded in `MONGODB_URI`.

1. Atlas → **Security → Database Users** → `decoricks_app` → **Edit** →
   **Password** → **Autogenerate** (or paste a long random one) → save.
2. Atlas → **Connect → Connect your application** → copy the **new** URI (it now
   contains the new password), **or** rebuild it yourself keeping the empty
   `/` path before `?`.
3. Render → Environment → replace `MONGODB_URI` → save → redeploy.
4. Confirm the app boots: as a signed-in Founder open
   **`/api/health/database`** (Founder-only) and it should report the database
   reachable. A wrong URI shows up as a 503 / DB-read failures.

### 2c. Atlas **admin** user password

The admin user is for **you** (mongosh, migrations, restores) — the app never
uses it. Rotate it in the same Atlas screen. It does **not** require a redeploy,
but update any local scripts / `.env.local` you use with mongosh.

> Keep `MONGODB_URI` (app user) and the admin credential **separate**. Never
> point the app at the admin user.

---

## 3. Update dependencies safely

Do this on your machine, verify, then commit and deploy — never edit
`package.json` directly on the host.

```bash
# 1. See what is outdated / vulnerable
npm outdated
npm audit

# 2. Apply a *contained* update (patch/minor first, not majors)
npm install <pkg>@<version>       # or: npm audit fix  (non-breaking only)

# 3. Prove the app is still green before committing ANYTHING
npm run verify        # = typecheck + lint + vitest + next build

# 4. Commit BOTH package.json and package-lock.json together
git add package.json package-lock.json
git commit -m "chore(deps): bump <pkg> to <version>"
```

Rules:

- **Commit the lockfile** with the change; Render installs from
  `package-lock.json`, so an uncommitted lockfile means the build is not
  reproducible.
- **Majors and breaking upgrades** (Tailwind 4, Vitest 4/5, etc.) are deliberately
  deferred — see `docs/KNOWN_LIMITATIONS.md`. Do them in their own branch with a
  full `npm run verify` and, ideally, the Playwright suite.
- Node is pinned to **22** (`.nvmrc`, `engines`, Render `NODE_VERSION`). Match
  your local Node to it when you can; if you cannot, say so — a build you only
  ran on a different major is **NOT VERIFIED** against the deploy target.
- After pushing and deploying, open the app and check the money screens
  (Reconciliation) — a dependency change should move **no** figures.

---

## 4. Restore from a backup

Full, tested procedure lives in **`docs/BACKUP_RECOVERY.md`**. The short, safe
version:

1. Restore **into a fresh, empty, throwaway database** — **never over live
   data**. The `--into` name must start with `test_` (or you set
   `DECORICKS_ALLOW_PROD_DB=1`).
2. **Dry-run first** (writes nothing), then `--apply`:
   ```bash
   DECORICKS_BACKUP_KEY_FILE=~/.decoricks/backup.key \
   npm run restore -- --from "$HOME/Decoricks Backups/decoricks-backup-<date>.enc"
   # then, to actually restore into a sandbox and reconcile:
   ... npm run restore -- --from ... --into test_restore_check --apply
   ```
3. The script re-runs the app's own reconciliation on both copies. You want
   **DOC-COUNT CHECK: ok** and **RECONCILIATION CHECK: ok**.
4. For a real disaster: restore to a new DB, confirm counts vs the `.meta.json`,
   then point `MONGODB_DB` at it (or switch over). Only after checks pass.

> **Production restore guard (Stage-2 hardening):** `restore.ts` will only write into
> `decoricks_prod` for a **same-name disaster recovery** — the archive's own
> `sourceDatabase` must be `decoricks_prod`. Restoring a `decoricks_dev` or `test_…`
> backup into production is refused unless you pass the deliberate
> `--allow-foreign-source` flag (and still need `DECORICKS_ALLOW_PROD_DB=1` and an
> empty target). This makes it impossible to overwrite real records with dev/test
> data by accident.

> The **encryption key is not in Git and not in the backup folder.** Lose the
> key and the archive is unreadable forever. Keep `~/.decoricks/backup.key` in a
> password manager and on a disk you also back up.

---

## 5. What to check every month

- [ ] **Backups ran.** The newest `decoricks-backup-*.enc` (+ `.meta.json`) in
      your backup folder is from the last day; the launchd job did not error
      (`/tmp/decoricks-backup.*.log`). The folder is synced **off this laptop**.
- [ ] **A restore still works.** Once a quarter, do §4 into a sandbox and read
      the two `ok` lines. An untested restore is a hope, not a backup.
- [ ] **Reconciliation is clean.** Founder → **Reconciliation** shows **zero
      difference** across the headline figures.
- [ ] **Atlas storage headroom.** M0 cluster is well under **512 MB** (Atlas →
      Storage). A sudden jump = something is storing blobs it should not.
- [ ] **Render hours.** Instance hours are on track to stay **under 750** for the
      month, and the keep-awake monitor is still pinging `/api/health`.
- [ ] **`npm audit`.** Review new advisories; fix non-breaking ones in a PR with
      `npm run verify` green.
- [ ] **User list is current.** Nobody who has left still has an active account;
      rotate the Atlas app-user password if a leaver knew a shared secret.
- [ ] **First-login hygiene.** No accounts are still on a temporary / bootstrap
      password.

---

## 6. Deleting the legacy `test` database (target 2026-11-24) — DO NOT rush

Background: the copy-and-switch migration moved the live records to
**`decoricks_prod`** (Stage-2 log, commit `59d0de5`). The old **`test`** database
is now a **frozen 30-day rollback copy**, kept only in case the switch needs
reversing. The app itself **refuses to boot against a test-shaped name** in
production (commits `d9cf7e3`, `b0f2fab`), so `decoricks_prod` is the real target
now.

The `test` database **may be deleted only when ALL of these are true**:

1. **A final, verified backup exists** — a recent `decoricks-backup-<date>.enc`
   of `decoricks_prod` whose restore you have actually tested (§4), plus a copy
   of the last `test` snapshot archived offline if you want it for the record.
2. **Two weeks of stable use have passed** since the switch with **no** rollback
   needed: partners have entered and reconciled real orders/expenses/tasks on
   `decoricks_prod`, Reconciliation stays clean, and figures match the old
   records (see `docs/LAUNCH_CHECKLIST.md`).
3. **Nothing still points at `test`** — no Render env `MONGODB_DB`, and no local
   `.env.local`, resolves to it for production.
4. **Explicit go-ahead from the owner** (this is a destructive, irreversible
   action on the business's data).

The date **2026-11-24** is the _earliest_ this window is expected to open — it is
a gate to check, **not** a calendar instruction. If the two-week stability bar is
not met, **do not delete**; push the date back. When it is finally approved, take
a fresh backup first, drop it from Atlas, and confirm `decoricks_prod` is
unaffected by opening `/api/health/database` as the signed-in Founder afterward.

> Until every gate above is met, leave `test` exactly as it is. This guide does
> **not** delete it now.

---

## 7. Keeping development and production separate

Production (`decoricks_prod`) was purged of all demo data on 2026-10-25 and is the
**clean baseline** — empty business collections, configuration intact (4 users, 4
roles, 3 accounts at opening balance PKR 0, 13 categories, 3 chat channels),
`counters` empty. **Enter real records yourself; never seed or restore fixtures
into it.**

### Every script that can write to the database, and its guard

The shared line of defence is `assertScriptDatabaseConsent` (`src/lib/db-name.ts`):
any database that is **not** test-shaped (`decoricks_test` / `test_…`) refuses to be
written unless the operator sets `DECORICKS_ALLOW_PROD_DB=1` on that one command.
`.env.local` sets `MONGODB_DB=decoricks_dev`, so ordinary runs never even look at
prod.

| Script | Writes? | Guard(s) |
| --- | --- | --- |
| `seed.ts` | founder, roles, SPEC defaults | refuses test-shaped **and** now **absolutely refuses `decoricks_prod` — no override flag**; consent for any other non-test name |
| `seed-e2e.ts` | e2e fixture users/roles | `assertTestTarget` — **test-shaped only**, throws before consent; cannot reach prod |
| `cleanup-e2e-data.ts` | `deleteMany` sweep | dry-run default · `--apply` + `--confirm=<name>` · consent |
| `cleanup-demo-data.ts` | frozen demo `_id`s | dry-run default · fresh verified backup · `--confirm` · consent · **drift abort** · single txn · audit · reconcile |
| `restore.ts` | replaces an **empty** target | dry-run default · consent · empty-target rule · **prod only from same-source backup, else `--allow-foreign-source`** |
| `backfill-role-permissions.ts` | `updateOne` roles | dry-run default · `--apply` + `--confirm-backup` · consent |
| `migrate-tasks-assignees.ts` | board/column/task writes | `DRY_RUN=true` default · consent when applying |
| `migrate-chat-clientid-index.ts` | index + `updateMany` | dry-run default · `--apply` + `--confirm-backup` · consent |
| `index-migrate-dry-run.ts` | `updateMany` | read-only default · `--apply` + `--i-have-a-backup` · consent |

Read-only (cannot corrupt prod): `backup.ts`, `verify-finance.ts`, `db-inventory.ts`,
`db-probe.ts`, `stage1-demo-inventory.ts`, `index-audit.ts`, the `*-probe` scripts.

### Your local connection can still reach production — do something about it

`decoricks_prod` is **not** protected by a separate credential today. The
`MONGODB_URI` in your local `.env.local` connects as the **admin** Atlas user
(`atlasAdmin@admin`, read/write on *every* database). `MONGODB_DB=decoricks_dev` only
sets the *default* — the same credential writes to `decoricks_prod` if you ever export
`MONGODB_DB=decoricks_prod DECORICKS_ALLOW_PROD_DB=1` (which is exactly how the purge
was run). The production **host** (Render) connects as the least-privilege
`decoricks_app` user (§2b), so the *app* is fine; the risk is the admin credential on
your laptop.

Recommended, in order of value:

1. **Create a read-only Atlas user for Compass / local inspection** — e.g.
   `decoricks_ro` with the built-in `readAnyDatabase@admin` role (or a custom
   `{ db: 'decoricks_prod', role: 'read' }` only). Use it for browsing; never for
   scripts. This means an accidental `deleteMany` from a Compass shell is impossible.
2. **Stop keeping the `atlasAdmin` URI in `.env.local` for day-to-day work.** Point
   local development at a user scoped to `decoricks_dev`/`decoricks_test` only; keep
   the admin credential for explicit, deliberate migration windows and paste it inline
   rather than storing it.
3. **Rotate the admin password** (§2c) if it has ever been shared or committed.
4. Never run a whole suite or `npm run seed` with `MONGODB_DB=decoricks_prod` — the
   guards above now make the seed path impossible even so, but keep the habit.

The in-app, auditable way to set the three accounts' **real opening balances** before
the first transaction is documented in `docs/DB_MIGRATION.md` (§ "Opening balances") —
use PATCH/POST `/api/finance/accounts` as the Founder, never edit the documents in
Atlas directly.
