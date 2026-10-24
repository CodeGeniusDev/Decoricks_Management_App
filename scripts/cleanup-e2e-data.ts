import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Collection, Db, MongoClient, ObjectId } from 'mongodb'
import { getEnv } from '../src/lib/env'
import { resolveDatabase, assertScriptDatabaseConsent } from '../src/lib/db-name'

/**
 * Removes Playwright (E2E) leftover records from the application database.
 *
 * Before the Playwright suite was isolated to `decoricks_test`, every e2e run
 * wrote real documents into the app database through the UI. Those runs are
 * identifiable by the unique markers the specs always apply:
 *
 *   - ledger entries: note starts with "e2e"/"E2E" (or is a reversal of such
 *     an entry — linked via `reversesId`, or note "Reversal: e2e-reason-…")
 *   - budgets: name starts with "E2E "
 *   - profit distributions: month is one of the spec's placeholder months
 *     (2032-01/02/03) or an adjustment reason starts with "E2E"
 *   - legacy Phase 1 collections + tasks/orders/products/suppliers/chat:
 *     name/note/description/content fields starting with "e2e" (removed only if
 *     found)
 *
 * The Phase 5 cross-device specs mark their rows differently (`SYNC-…`, `SSE…`,
 * `warm-…`, `e2e-idem-…`). Those shapes are only reported, never deleted: a SKU
 * beginning `SSE` is not something to infer ownership from, and since the suite
 * was isolated to `decoricks_test` they cannot reach the application database by
 * design. The scan exists so "they are not here" is a measurement rather than an
 * assumption.
 *
 * Anything not matching these patterns is left untouched — genuine business
 * records, users, roles, finance configuration and the audit log are NEVER
 * deleted (the audit trail is append-only by design; the deletions themselves
 * are recorded there as `e2e_cleanup`).
 *
 * Usage:
 *   npx tsx scripts/cleanup-e2e-data.ts                        # dry run (default, safe)
 *   npx tsx scripts/cleanup-e2e-data.ts --apply --confirm=NAME # actually delete
 *
 * `--apply` is not enough on its own. The script deletes from the application
 * database, whose name is not configured explicitly in this deployment (it comes
 * from the driver's fallback), so the operator has to type the name the script
 * resolved. That turns "I ran the cleanup against the wrong cluster" from a
 * silent loss into a refusal.
 */

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

/** Database name the operator must restate for `--apply` to be honoured. */
const CONFIRM_PREFIX = '--confirm='
const CONFIRM = process.argv
  .find((arg) => arg.startsWith(CONFIRM_PREFIX))
  ?.slice(CONFIRM_PREFIX.length)

/** Months the phase-4 distribution spec calculates against (never real). */
const E2E_DISTRIBUTION_MONTHS = ['2032-01', '2032-02', '2032-03']

const E2E_NOTE = /^e2e/i
const E2E_REVERSAL_NOTE = /^reversal:\s*e2e/i

/** Phase 5 cross-device / idempotency markers. Advisory only; never deleted. */
const PHASE5_MARKER = /^(SYNC-|SSE|warm-|e2e-idem-)/i

const preview = (docs: Array<Record<string, unknown>>, limit = 5): string =>
  docs
    .slice(0, limit)
    .map((d) => {
      const label =
        (d.note as string) ?? (d.name as string) ?? (d.month as string) ?? (d.title as string) ?? ''
      return `    ${d._id}  ${JSON.stringify(label).slice(0, 80)}`
    })
    .join('\n')

const deleteAndReport = async (
  col: Collection<Document>,
  filter: Record<string, unknown>,
  label: string,
  present = true
): Promise<number> => {
  /*
   * A `find` on a namespace the server has never created answers "no documents".
   * In a dry run of a DELETION tool that reads as a clean bill of health for a
   * place the script never looked at — which is precisely the bug the Phase 5
   * audit found here, where this file swept a collection called `chatMessages`
   * while chat has always lived in `messages`.
   */
  if (!present) {
    console.log(`  ${label}: COLLECTION ABSENT — nothing was checked, do not read this as clean`)
    return 0
  }
  const docs = (await col.find(filter).limit(200).toArray()) as Array<Record<string, unknown>>
  if (docs.length === 0) {
    console.log(`  ${label}: none`)
    return 0
  }
  console.log(`  ${label}: ${docs.length}${docs.length >= 200 ? '+' : ''} record(s)`)
  console.log(preview(docs))
  if (APPLY) {
    const res = await col.deleteMany(filter)
    console.log(`    → deleted ${res.deletedCount}`)
    return res.deletedCount ?? 0
  }
  return docs.length
}

type Document = { [key: string]: unknown }

const main = async () => {
  const env = getEnv()
  // Resolve the way the application does — ignoring a test-runner override, since
  // the point of this script is the records earlier e2e runs wrote into the
  // application database. Using the shared resolver instead of a private
  // `client.db()` call is what keeps the script and the app from ever disagreeing
  // about which database a `deleteMany` is aimed at.
  const target = resolveDatabase({ ...env, MONGODB_TEST_DB: undefined })
  const client = new MongoClient(env.MONGODB_URI)
  try {
    await client.connect()
    const db: Db = client.db(target.dbName)
    const dbName = db.databaseName

    console.log(`${APPLY ? 'APPLYING' : 'DRY RUN — nothing will be deleted'}`)
    console.log(`Target database: "${dbName}" (resolved from ${target.source})`)
    if (target.warning) console.log(`WARNING: ${target.warning}`)

    if (APPLY && CONFIRM !== dbName) {
      console.error(
        `\nRefusing to delete: --apply requires --confirm=<database name> matching the target above.\n` +
          `Re-run as: npx tsx scripts/cleanup-e2e-data.ts --apply --confirm=${dbName}`
      )
      process.exitCode = 1
      return
    }

    // Deleting from a non-test-shaped database (this deployment's real data) also
    // needs the operator consent flag, on top of --confirm. Dry runs only read, so
    // they are not gated.
    if (APPLY) {
      try {
        assertScriptDatabaseConsent(dbName, { script: 'scripts/cleanup-e2e-data.ts' })
      } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
        return
      }
    }

    console.log('')

    let total = 0

    /**
     * Which namespaces the server has actually created, so a sweep can tell
     * "nothing matched" apart from "there is nothing here to match against".
     */
    const present = new Set((await db.listCollections().toArray()).map((c) => c.name))

    // 1. Ledger entries -----------------------------------------------------
    const transactions = db.collection('transactions')
    const e2eHeads = await transactions
      .find({ $or: [{ note: E2E_NOTE }, { note: E2E_REVERSAL_NOTE }] } as never)
      .project<{ _id: ObjectId }>({ _id: 1 })
      .toArray()
    const e2eIds = e2eHeads.map((d) => d._id)

    // Reversals of those entries carry note "Reversal of <id>" — catch them by
    // their explicit link, never by the generic prefix (a real entry may have
    // been reversed too).
    const linkedReversals = e2eIds.length
      ? await transactions
          .find({ reversesId: { $in: e2eIds } } as never)
          .project({ _id: 1 })
          .toArray()
      : []
    const allE2eTxIds = [
      ...new Set([
        ...e2eIds,
        ...linkedReversals.map((d) => (d as { _id: ObjectId })._id.toString()),
      ]),
    ].map((id) => (id instanceof ObjectId ? id : new ObjectId(id)))

    total += await deleteAndReport(
      transactions,
      { _id: { $in: allE2eTxIds } } as never,
      'transactions (e2e entries + their linked reversals)',
      present.has('transactions')
    )

    // 2. Budgets -------------------------------------------------------------
    total += await deleteAndReport(
      db.collection('budgets'),
      { name: { $regex: '^E2E ' } } as never,
      'budgets (name "E2E …")',
      present.has('budgets')
    )

    // 3. Profit distributions -------------------------------------------------
    total += await deleteAndReport(
      db.collection('profitDistributions'),
      {
        $or: [
          { month: { $in: E2E_DISTRIBUTION_MONTHS } },
          { 'adjustments.reason': { $regex: '^E2E', $options: 'i' } },
        ],
      } as never,
      'profitDistributions (e2e months / adjustment reasons)',
      present.has('profitDistributions')
    )

    // 4. Legacy + operational collections (inventory; delete only clear hits) --
    const textSweeps: Array<[string, string[]]> = [
      ['income', ['note', 'description']],
      ['expenses', ['note', 'description', 'vendor']],
      ['transfers', ['note', 'description']],
      ['tasks', ['title', 'description']],
      ['orders', ['customerName', 'notes']],
      ['products', ['name', 'description', 'sku']],
      ['suppliers', ['name', 'notes']],
      // Chat. Not `chatMessages`, which has never existed: `models/Chat.ts`
      // opens `messages` and stores the body in `content`.
      ['messages', ['content']],
      ['chatChannels', ['name']],
    ]
    for (const [name, fields] of textSweeps) {
      const col = db.collection(name)
      const or = fields.map((f) => ({ [f]: E2E_NOTE }))
      total += await deleteAndReport(
        col,
        { $or: or } as never,
        `${name} (e2e-prefixed ${fields.join('/')})`,
        present.has(name)
      )
    }

    /*
     * Advisory phase-5 marker scan. Deliberately outside `total`, and outside
     * every filter above: these prefixes were chosen by this project's own
     * specs, and nothing here is allowed to turn a naming coincidence into a
     * DELETE against live data.
     */
    console.log('\n  phase 5 markers (reported only, never deleted):')
    const markerSweeps: Array<[string, string[]]> = [
      ['products', ['sku', 'name']],
      ['tasks', ['title']],
      ['orders', ['customerName']],
      ['transactions', ['note']],
      ['messages', ['content']],
      ['suppliers', ['name']],
    ]
    for (const [name, fields] of markerSweeps) {
      if (!present.has(name)) continue
      const hits = await db
        .collection(name)
        .countDocuments({ $or: fields.map((f) => ({ [f]: PHASE5_MARKER })) } as never)
      if (hits) console.log(`    ${name} (${fields.join('/')}): ${hits} record(s) — needs review`)
    }
    console.log('    (a collection with no line above matched none of its fields)')

    console.log(`\nTotal ${APPLY ? 'deleted' : 'matched'}: ${total}`)
    if (!APPLY && total > 0) {
      console.log(`Re-run with --apply --confirm=${dbName} to delete these records.`)
    }
    if (APPLY && total > 0) {
      // Record the cleanup itself in the append-only audit trail.
      await db.collection('auditLog').insertOne({
        userId: null,
        userEmail: 'system',
        action: 'e2e_cleanup',
        entityType: 'database',
        entityId: null,
        oldValue: undefined,
        newValue: undefined,
        details: `Removed ${total} E2E-marked test record(s) from "${dbName}" via scripts/cleanup-e2e-data.ts`,
        outcome: 'success',
        createdAt: new Date(),
      })
      console.log('Audit entry recorded (action: e2e_cleanup).')
    }
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error('E2E cleanup failed:', error)
  process.exit(1)
})
