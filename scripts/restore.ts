/**
 * Restore an encrypted backup into a SEPARATE database and prove it matches.
 *
 * The Step 4 contract is not just "the file restores" — it is "the restored
 * figures equal the original's." So after writing, this runs the application's
 * OWN Phase 8 reconciliation (`src/lib/metrics/reconciliation`) against both the
 * original database and the freshly restored copy, and compares every check
 * number-for-number. A single paisa of difference is a FAIL.
 *
 * Safety rails (mirrors the seed guard philosophy):
 *   - DRY-RUN by default; nothing is written without --apply.
 *   - --into must be a test-shaped name (matches TEST_DB_PATTERNS) OR the run
 *     must carry DECORICKS_ALLOW_PROD_DB=1. Restoring into the production
 *     database is allowed only for a same-name disaster recovery — the backup's
 *     source database must equal the target — and any foreign source additionally
 *     requires --allow-foreign-source.
 *   - The target database must be EMPTY (0 documents) — restore never merges
 *     into live data. Use a brand-new database name.
 *
 * Usage:
 *   npx tsx scripts/restore.ts --from backups/decoricks-backup-….enc        # dry run
 *   npx tsx scripts/restore.ts --from … --into test_restore_20261024 --apply # write + verify
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MongoClient } from 'mongodb'
import { getEnv } from '../src/lib/env'
import {
  assertScriptDatabaseConsent,
  looksLikeTestDatabase,
  isProductionDatabaseName,
} from '../src/lib/db-name'
import { decodePayload, restoreDatabase } from '../src/lib/backup/serialize'
import { decryptBackup } from '../src/lib/backup/crypto'
import { readBackupPassphrase } from '../src/lib/backup/keyfile'
import { reconcile } from '../src/lib/metrics/reconciliation'

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
 * The passphrase comes from the shared key-file reader: the key file is READ
 * only — never created, overwritten or regenerated here. A missing, empty or
 * group/world-readable key file is a hard refusal.
 */
const readPassphrase = (): string => readBackupPassphrase()

const argOf = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  loadEnvLocal()
  const from = argOf('--from')
  const into = argOf('--into')
  const apply = process.argv.includes('--apply')
  if (!from) throw new Error('--from <backup.enc> is required')

  const env = getEnv()
  const container = readFileSync(from)
  const payload = decodePayload(decryptBackup(container, readPassphrase()))

  console.log(`Backup source database : "${payload.sourceDatabase}"`)
  console.log(`Generated at           : ${payload.generatedAt}`)
  console.log(`Collections            : ${payload.collections.length}`)
  console.log(`Documents              : ${payload.collections.reduce((s, c) => s + c.count, 0)}`)

  if (!apply) {
    console.log('\nDRY-RUN. Nothing written. To restore and verify:')
    console.log('  npx tsx scripts/restore.ts --from <file> --into <empty-test-db> --apply')
    return
  }
  if (!into) throw new Error('--into <database> is required with --apply')

  // A restore target must be a sandbox unless the operator explicitly consents.
  if (!looksLikeTestDatabase(into)) {
    assertScriptDatabaseConsent(into, { script: 'scripts/restore.ts' })
  }

  // Restoring into the live production database is ONLY ever a same-name
  // disaster recovery: the archive must itself have been taken from that exact
  // production database. Loading a backup whose source is `decoricks_dev` or a
  // `test_…` sandbox into production would replace real records with
  // fixture/dev data, so it is refused outright; a foreign source may proceed
  // only with the deliberate `--allow-foreign-source` flag (and still needs the
  // consent flag and an empty target).
  if (isProductionDatabaseName(into) && payload.sourceDatabase !== into) {
    if (!process.argv.includes('--allow-foreign-source')) {
      throw new Error(
        `Refusing to restore into production database "${into}" from a backup whose source is ` +
          `"${payload.sourceDatabase}". A production restore must come from the same production ` +
          `database (disaster recovery). To override deliberately, add --allow-foreign-source.`
      )
    }
    console.warn(
      `WARNING: --allow-foreign-source — restoring "${payload.sourceDatabase}" backup into production "${into}".`
    )
  }

  const client = new MongoClient(env.MONGODB_URI)
  await client.connect()
  try {
    const target = client.db(into)
    // Refuse to write into anything that already holds data.
    const existing = await target.listCollections().toArray()
    let existingDocs = 0
    for (const c of existing) existingDocs += await target.collection(c.name).countDocuments()
    if (existingDocs > 0) {
      throw new Error(
        `refusing to restore into non-empty database "${into}" (${existingDocs} docs)`
      )
    }

    const result = await restoreDatabase(target, payload)
    console.log(
      `\nRestored into "${result.database}": ${result.totalDocs} documents across ${result.perCollection.length} collections`
    )

    // Count-level equality against the manifest taken at dump time.
    const mismatches: string[] = []
    for (const stat of payload.collections) {
      const actual = await target.collection(stat.name).countDocuments()
      if (actual !== stat.count)
        mismatches.push(`${stat.name}: dumped ${stat.count}, restored ${actual}`)
    }
    if (mismatches.length) {
      console.log('\nDOC-COUNT CHECK: FAIL')
      mismatches.forEach((m) => console.log(`  ${m}`))
      process.exitCode = 1
      return
    }
    console.log('DOC-COUNT CHECK: ok — every collection restored exactly the dumped count')

    // Figure-level equality: run the app's reconciliation on both databases.
    const source = client.db(payload.sourceDatabase)
    const range = { start: new Date(0), end: new Date(Date.now() + 365 * 86_400_000) }
    const now = new Date()
    const [a, b] = await Promise.all([reconcile(source, range, now), reconcile(target, range, now)])

    console.log('\nRECONCILIATION — original vs restored (paisa):')
    let allMatch = true
    for (const check of a.checks) {
      const match = b.checks.find((c) => c.name === check.name)
      const ok = match && match.a === check.a && match.b === check.b && match.pass === check.pass
      if (!ok) allMatch = false
      console.log(
        `  ${ok ? 'MATCH ' : 'DIFF  '} ${check.name}: original a=${check.a} b=${check.b} | restored a=${match?.a} b=${match?.b}`
      )
    }
    if (allMatch && a.allPass && b.allPass) {
      console.log(
        `\nRECONCILIATION CHECK: ok — all ${a.checks.length} checks pass identically on both databases`
      )
    } else {
      console.log('\nRECONCILIATION CHECK: FAIL — figures differ or a check does not pass')
      process.exitCode = 1
    }
  } finally {
    await client.close()
  }
}

void main().catch((err) => {
  console.error('Restore failed:', (err as Error).message)
  process.exit(1)
})
