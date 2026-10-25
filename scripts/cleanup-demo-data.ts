/**
 * Stage 2 — delete the frozen DEMO records from `decoricks_prod`.
 *
 * Every safeguard from the Stage 1 plan is enforced here, in this order:
 *   1. DRY-RUN by default. Nothing is deleted without `--apply`.
 *   2. A FRESH, VERIFIED encrypted backup of the target database, made in the
 *      last hour, is required before `--apply` on any non-test database. The
 *      backup's `.enc` SHA-256 is recomputed and compared to its `.meta.json`
 *      manifest; the passphrase comes only from DECORICKS_BACKUP_KEY_FILE and is
 *      never created, overwritten or printed here.
 *   3. `--confirm=<database>` must restate the resolved target name exactly.
 *   4. `assertScriptDatabaseConsent` requires DECORICKS_ALLOW_PROD_DB=1 to write
 *      to a non-test-shaped database (decoricks_prod).
 *   5. Explicit `_id` lists only (never `deleteMany({})`), re-verified against
 *      the live database; any drift ABORTS before a single write.
 *   6. One `withTransaction` if the cluster supports transactions; otherwise
 *      ordered, resumable deletes driven by a per-database checkpoint file. The
 *      mode actually used is printed and written into the audit record.
 *   7. One append-only `auditLog` entry `demo_data_cleanup` with counts, the
 *      backup SHA-256 and the operator.
 *   8. Full-history `reconcile()` afterwards PLUS a direct zero-activity check;
 *      the script exits non-zero unless the database is back to "zero activity,
 *      opening balances intact".
 *
 * It NEVER touches the bare `test` database and never prints a secret.
 *
 * Usage:
 *   MONGODB_DB=decoricks_prod npx tsx scripts/cleanup-demo-data.ts                     # dry run
 *   DECORICKS_BACKUP_KEY_FILE=~/.decoricks/backup.key \
 *   MONGODB_DB=decoricks_prod DECORICKS_ALLOW_PROD_DB=1 \
 *     npx tsx scripts/cleanup-demo-data.ts --apply --confirm=decoricks_prod
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { MongoClient, ObjectId } from 'mongodb'
import { getEnv } from '../src/lib/env'
import {
  resolveDatabase,
  assertScriptDatabaseConsent,
  looksLikeTestDatabase,
} from '../src/lib/db-name'
import { reconcile } from '../src/lib/metrics/reconciliation'
import {
  DEMO_MANIFEST,
  EXPECTED_TOTAL,
  CONFIG_BASELINE_PROD,
  verifyNoDrift,
  deleteDemoDocs,
  buildCleanupAuditDoc,
  assertZeroActivity,
} from '../src/lib/cleanup/demo-cleanup'

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
loadEnvLocal()

const APPLY = process.argv.includes('--apply')
const CONFIRM_PREFIX = '--confirm='
const CONFIRM = process.argv.find((a) => a.startsWith(CONFIRM_PREFIX))?.slice(CONFIRM_PREFIX.length)

const redactedHosts = (uri: string): string => {
  const s = uri.replace(/^mongodb(\+srv)?:\/\//i, '')
  return s
    .slice(s.lastIndexOf('@') + 1)
    .split('/')[0]
    .split('?')[0]
}

/** Transactions are unsupported on standalone mongod; detect the family of errors. */
const isTransactionUnsupported = (err: unknown): boolean => {
  const e = err as { codeName?: string; code?: number; message?: string }
  const msg = String(e?.message ?? '')
  return (
    e?.codeName === 'IllegalOperation' ||
    e?.codeName === 'OperationNotSupported' ||
    e?.code === 20 ||
    /replica set|transactions are not supported|Transaction numbers|standalone/i.test(msg)
  )
}

/** Find the newest verified backup for `dbName` made within `maxAgeMs`. */
const findFreshVerifiedBackup = (
  dir: string,
  dbName: string,
  maxAgeMs: number
): { encPath: string; sha256: string; ageMinutes: number } | null => {
  if (!existsSync(dir)) return null
  const metas = readdirSync(dir)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => {
      const p = path.join(dir, f)
      try {
        return {
          p,
          meta: JSON.parse(readFileSync(p, 'utf8')) as {
            sourceDatabase: string
            archive: string
            sha256: string
            generatedAt: string
          },
        }
      } catch {
        return null
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .filter((x) => x.meta.sourceDatabase === dbName)
    .sort((a, b) => Date.parse(b.meta.generatedAt) - Date.parse(a.meta.generatedAt))

  for (const { meta } of metas) {
    const encPath = path.join(dir, meta.archive)
    if (!existsSync(encPath)) continue
    const age = Date.now() - Date.parse(meta.generatedAt)
    if (age > maxAgeMs) continue
    const actual = createHash('sha256').update(readFileSync(encPath)).digest('hex')
    if (actual !== meta.sha256) {
      console.error(
        `Backup integrity check FAILED for ${meta.archive}: manifest sha256 ${meta.sha256}, recomputed ${actual}`
      )
      continue
    }
    return { encPath, sha256: actual, ageMinutes: Math.round(age / 60000) }
  }
  return null
}

const checkpointPath = (dbName: string): string =>
  path.join(process.cwd(), `.cleanup-demo-${dbName}.checkpoint.json`)

interface Checkpoint {
  doneCollections: string[]
}
const loadCheckpoint = (dbName: string): Checkpoint => {
  const p = checkpointPath(dbName)
  if (!existsSync(p)) return { doneCollections: [] }
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Checkpoint
  } catch {
    return { doneCollections: [] }
  }
}

/** Ordered deletes with a resumable checkpoint (fallback when transactions are unavailable). */
const deleteWithCheckpoint = async (
  client: MongoClient,
  dbName: string,
  mode: 'ordered-checkpoint'
) => {
  const db = client.db(dbName)
  const cp = loadCheckpoint(dbName)
  const counts: Record<string, number> = {}
  let total = 0
  for (const entry of DEMO_MANIFEST) {
    if (cp.doneCollections.includes(entry.collection)) {
      console.log(`  (resumed) ${entry.collection}: already deleted, skipping`)
      counts[entry.collection] = entry.ids.length
      continue
    }
    const res = await db
      .collection(entry.collection)
      .deleteMany({ _id: { $in: entry.ids.map((id) => new ObjectId(id)) } } as never)
    counts[entry.collection] = res.deletedCount ?? 0
    total += res.deletedCount ?? 0
    cp.doneCollections.push(entry.collection)
    writeFileSync(checkpointPath(dbName), JSON.stringify(cp, null, 2))
    console.log(`  ${entry.collection}: deleted ${res.deletedCount}`)
  }
  return { counts, total }
}

async function main(): Promise<void> {
  const env = getEnv()
  const target = resolveDatabase(env)
  const client = new MongoClient(env.MONGODB_URI, { readPreference: 'primary', retryWrites: false })
  await client.connect()

  try {
    const db = client.db(target.dbName)
    const dbName = db.databaseName
    const uri = env.MONGODB_URI

    console.log('Stage 2 — DEMO-data cleanup')
    console.log(`  host(s)   : ${redactedHosts(uri)} (credentials redacted)`)
    console.log(`  database  : ${dbName} (resolved from ${target.source})`)
    console.log(`  mode      : ${APPLY ? 'APPLY (will delete)' : 'DRY-RUN (nothing deleted)'}`)
    console.log(
      `  frozen set: ${EXPECTED_TOTAL} documents across ${DEMO_MANIFEST.length} collections\n`
    )

    // 3. confirm gate + 4. consent gate (only enforced for a real write).
    if (APPLY) {
      if (CONFIRM !== dbName) {
        console.error(
          `Refusing to delete: --confirm=${CONFIRM ?? '(missing)'} does not match the target "${dbName}".\nRe-run with --confirm=${dbName}`
        )
        process.exitCode = 1
        return
      }
      try {
        assertScriptDatabaseConsent(dbName, { script: 'scripts/cleanup-demo-data.ts' })
      } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
        return
      }
    }

    // 2. fresh verified backup required before writing to any non-test database.
    let backupSha256 = ''
    if (APPLY && !looksLikeTestDatabase(dbName)) {
      const dir = path.resolve(process.cwd(), process.env.BACKUP_DIR ?? 'backups')
      const fresh = findFreshVerifiedBackup(dir, dbName, 60 * 60 * 1000)
      if (!fresh) {
        console.error(
          `Refusing to delete: no fresh verified encrypted backup of "${dbName}" (made in the last hour) in ${dir}.\n` +
            `Run first:  DECORICKS_BACKUP_KEY_FILE=… MONGODB_DB=${dbName} npx tsx scripts/backup.ts`
        )
        process.exitCode = 1
        return
      }
      backupSha256 = fresh.sha256
      console.log(
        `Backup OK: ${path.basename(fresh.encPath)} (${readFileSync(fresh.encPath).length} bytes, ${fresh.ageMinutes} min old)`
      )
      console.log(`  sha256 ${backupSha256}\n`)
    }

    // 5. drift check — abort on ANY mismatch, dry-run and apply alike.
    const drift = await verifyNoDrift(db)
    console.log('Drift check (live counts vs frozen set):')
    for (const c of drift.perCollection)
      console.log(
        `  ${c.collection.padEnd(18)} expected=${c.expected} live=${c.live} present=${c.present}${c.extra ? ` EXTRA=${c.extra}` : ''}${c.missing.length ? ` MISSING=${c.missing.length}` : ''}`
      )
    if (!drift.ok) {
      console.error('\nABORT — database has drifted from the reviewed Stage-1 set:')
      drift.reasons.forEach((r) => console.error(`  - ${r}`))
      process.exitCode = 1
      return
    }
    console.log(`  ok — exactly ${drift.totalPresent} documents match the frozen set\n`)

    // Config baseline (informational; enforced on prod).
    const configLines: string[] = []
    for (const [name, expected] of Object.entries(CONFIG_BASELINE_PROD)) {
      const actual = await db.collection(name).countDocuments()
      configLines.push(
        `  ${name.padEnd(18)} ${actual === expected ? 'ok' : 'CHECK'} = ${actual} (baseline ${expected})`
      )
    }
    console.log('Configuration (must stay untouched):')
    configLines.forEach((l) => console.log(l))

    if (!APPLY) {
      console.log(
        `\nDRY-RUN complete. To apply: --apply --confirm=${dbName} (with DECORICKS_ALLOW_PROD_DB=1 and a fresh backup).`
      )
      return
    }

    // 6. delete — one transaction if supported, else ordered + checkpoint.
    const operator = process.env.DECORICKS_CLEANUP_OPERATOR || os.userInfo().username || 'unknown'
    let counts: Record<string, number> = {}
    let total = 0
    let usedMode: 'transaction' | 'ordered-checkpoint' = 'transaction'

    const session = client.startSession()
    let transactionSucceeded = false
    try {
      await session.withTransaction(async () => {
        const result = await deleteDemoDocs(db, { session })
        counts = Object.fromEntries(result.perCollection.map((c) => [c.collection, c.deleted]))
        total = result.totalDeleted
        // 7. audit entry inside the same transaction.
        await db.collection('auditLog').insertOne(
          buildCleanupAuditDoc({
            database: dbName,
            counts,
            totalDeleted: total,
            backupSha256,
            operator,
            mode: 'transaction',
          }) as never,
          { session }
        )
      })
      transactionSucceeded = true
      usedMode = 'transaction'
      console.log('\nDeletion ran in a SINGLE TRANSACTION.')
    } catch (err) {
      if (!isTransactionUnsupported(err)) throw err
      console.log(
        `\nCluster does not support transactions (${(err as Error).message}); falling back to ORDERED RESUMABLE deletes with a checkpoint file.`
      )
      usedMode = 'ordered-checkpoint'
      const fallback = await deleteWithCheckpoint(client, dbName, 'ordered-checkpoint')
      counts = fallback.counts
      total = fallback.total
      await db.collection('auditLog').insertOne(
        buildCleanupAuditDoc({
          database: dbName,
          counts,
          totalDeleted: total,
          backupSha256,
          operator,
          mode: 'ordered-checkpoint',
        }) as never
      )
      rmSync(checkpointPath(dbName), { force: true })
    } finally {
      await session.endSession()
    }

    console.log(`Deleted ${total} documents (mode=${usedMode}):`)
    Object.entries(counts).forEach(([c, n]) => console.log(`  ${c.padEnd(18)} ${n}`))
    if (usedMode === 'transaction' && total !== EXPECTED_TOTAL) {
      console.error(`Post-delete total ${total} != expected ${EXPECTED_TOTAL}`)
      process.exitCode = 1
      return
    }

    // 8. post-checks.
    console.log('\nPost-check: zero activity (direct read)')
    const zero = await assertZeroActivity(db)
    zero.details.forEach((d) => console.log(`  ${d}`))

    console.log('\nPost-check: full-history reconcile()')
    const now = new Date()
    const report = await reconcile(db, { start: new Date(0), end: now }, now)
    report.checks.forEach((c) =>
      console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.name}: a=${c.a} b=${c.b} diff=${c.difference}`)
    )

    const configIntactAfter = await Promise.all(
      Object.entries(CONFIG_BASELINE_PROD).map(async ([name, expected]) => ({
        name,
        actual: await db.collection(name).countDocuments(),
        expected,
      }))
    )
    const configOk = configIntactAfter.every((c) => c.actual === c.expected)
    console.log(`\nConfig intact after cleanup: ${configOk ? 'yes' : 'NO — REVIEW IMMEDIATELY'}`)

    const success =
      zero.ok &&
      report.allPass &&
      configOk &&
      (usedMode === 'ordered-checkpoint' || transactionSucceeded)
    console.log(
      `\nRESULT: ${success ? 'CLEAN — zero activity, opening balances intact, all reconcile checks pass.' : 'PROBLEM — review the FAIL/CHECK lines above.'}`
    )
    process.exitCode = success ? 0 : 1
  } finally {
    await client.close()
  }
}

void main().catch((err) => {
  console.error('Cleanup failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
