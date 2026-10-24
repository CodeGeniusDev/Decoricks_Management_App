/**
 * Backfill MISSING permission keys on existing role documents (Phase 10).
 *
 * Why this exists: `scripts/seed.ts` writes roles with `$setOnInsert`, so once a
 * role document exists its permission matrix is never touched again by a re-seed
 * — by design, so a Founder's edits in the permissions screen survive redeploys.
 * The downside is drift: roles created BEFORE a new permission key was added to
 * the SPEC template (Phase 6 added `tasks.editOthers / deleteOthers / comment /
 * manage`) keep the old shape. The live `founder` role is exactly that case — its
 * stored `tasks` object lacks `comment`, so `authorize('tasks','comment')` denies
 * the Founder even though the SPEC template grants it.
 *
 * This script closes ONLY that gap. It is deliberately conservative:
 *   - It adds a key ONLY when it is entirely absent from the stored document.
 *   - It NEVER changes the value of a key that already exists, and NEVER removes
 *     a key the template does not mention. An operator's deliberate revocation is
 *     sacred; a missing key is not a revocation, it is an omission.
 *   - Roles not present in the SPEC template are left completely alone.
 *
 * Safety rails (mirrors the seed/migrate guard philosophy):
 *   - DRY-RUN by default; nothing is written without `--apply`.
 *   - `--apply` additionally requires `--confirm-backup`, an explicit statement
 *     that a verified encrypted backup of this database exists (Phase 10 Step 4).
 *   - Writing a non-test-shaped database (this deployment's production `test`)
 *     requires `DECORICKS_ALLOW_PROD_DB=1` via `assertScriptDatabaseConsent`.
 *
 * Usage:
 *   npx tsx scripts/backfill-role-permissions.ts                       # dry run
 *   npx tsx scripts/backfill-role-permissions.ts --apply --confirm-backup
 *   DECORICKS_ALLOW_PROD_DB=1 npx tsx scripts/backfill-role-permissions.ts --apply --confirm-backup
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MongoClient } from 'mongodb'
import { getEnv } from '../src/lib/env'
import {
  resolveDatabase,
  assertScriptDatabaseConsent,
  PROD_DB_CONSENT_FLAG,
} from '../src/lib/db-name'
import { SPEC_ROLES } from '../src/lib/roles'

type Matrix = Record<string, Record<string, boolean>>

/** A single missing grant: which module.action, and the value the template says to add. */
interface MissingGrant {
  module: string
  action: string
  value: boolean
}

const loadEnvLocal = (): void => {
  const file = path.join(process.cwd(), '.env.local')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    const value = match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    if (process.env[match[1]] === undefined) process.env[match[1]] = value
  }
}

/**
 * Every (module.action) the template grants that the stored document does not
 * contain AT ALL. Keys present in `stored` are skipped regardless of value, so an
 * existing `false` (a deliberate revocation) is never counted as "missing" and
 * never rewritten.
 */
const missingGrantsForRole = (template: Matrix, stored: Matrix | undefined): MissingGrant[] => {
  const out: MissingGrant[] = []
  for (const [module, actions] of Object.entries(template)) {
    const storedModule = stored?.[module]
    for (const [action, value] of Object.entries(actions)) {
      if (storedModule && Object.prototype.hasOwnProperty.call(storedModule, action)) continue
      out.push({ module, action, value })
    }
  }
  return out
}

async function main(): Promise<void> {
  loadEnvLocal()
  const apply = process.argv.includes('--apply')
  const confirmBackup = process.argv.includes('--confirm-backup')

  const env = getEnv()
  const target = resolveDatabase(env)
  const dbName = target.dbName ?? 'test' // driver default in this deployment

  const client = new MongoClient(env.MONGODB_URI)
  await client.connect()
  try {
    const db = client.db(dbName)
    console.log(`Roles database: "${db.databaseName}" (resolved from ${target.source})`)
    if (target.warning) console.warn(`WARNING: ${target.warning}`)

    // Consent is required before ANY write to a non-test-shaped database. A pure
    // dry run reads and prints, so it is not gated.
    if (apply) {
      if (!confirmBackup) {
        throw new Error(
          '--apply requires --confirm-backup: assert you have a verified encrypted backup of ' +
            'this database (see docs/BACKUP_RECOVERY.md) before mutating role documents.'
        )
      }
      assertScriptDatabaseConsent(db.databaseName, {
        script: 'scripts/backfill-role-permissions.ts',
      })
    }

    const storedRoles = await db
      .collection<{ name: string; permissions?: Matrix }>('roles')
      .find({})
      .toArray()
    const byName = new Map(storedRoles.map((r) => [r.name, r]))

    // Collect every missing grant across all template roles that exist in the DB.
    const plan: Array<{ role: string; grants: MissingGrant[] }> = []
    const absentRoles: string[] = []
    for (const spec of SPEC_ROLES) {
      const stored = byName.get(spec.name)
      if (!stored) {
        absentRoles.push(spec.name)
        continue
      }
      const grants = missingGrantsForRole(spec.permissions as Matrix, stored.permissions)
      if (grants.length > 0) plan.push({ role: spec.name, grants })
    }

    if (absentRoles.length) {
      console.log(
        `\nRoles in the template but NOT in this database (left untouched): ${absentRoles.join(', ')}`
      )
      console.log('  (create them with `npm run seed`; this script only edits existing documents)')
    }

    if (plan.length === 0) {
      console.log(
        '\nNothing to do: every existing role already carries all template permission keys.'
      )
      return
    }

    console.log(`\n${plan.length} role document(s) need missing keys added:`)
    for (const { role, grants } of plan) {
      console.log(`\n  ${role} (${grants.length} missing):`)
      for (const g of grants) console.log(`    + permissions.${g.module}.${g.action} = ${g.value}`)
    }

    if (!apply) {
      console.log('\nDRY-RUN. Nothing written. To apply:')
      console.log(
        `  [${PROD_DB_CONSENT_FLAG}=1] npx tsx scripts/backfill-role-permissions.ts --apply --confirm-backup`
      )
      return
    }

    // Apply: one $set per role, only for absent keys. $set of a dotted path
    // creates the leaf without disturbing sibling keys.
    const now = new Date()
    for (const { role, grants } of plan) {
      const set: Record<string, boolean | Date> = { updatedAt: now }
      for (const g of grants) set[`permissions.${g.module}.${g.action}`] = g.value
      const res = await db.collection('roles').updateOne({ name: role }, { $set: set })
      console.log(
        `  wrote ${role}: ${grants.length} keys added (matched ${res.matchedCount}, modified ${res.modifiedCount})`
      )
    }
    console.log('\nBackfill applied. Roles cache invalidates on the next write through the app.')
  } finally {
    await client.close()
  }
}

void main().catch((err) => {
  console.error('Backfill failed:', (err as Error).message)
  process.exit(1)
})
