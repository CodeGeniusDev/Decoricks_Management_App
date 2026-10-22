/**
 * Read-only index and volume audit (Phase 5 §5).
 *
 * Indexes in this app are created lazily by the model `ensure*` helpers, which
 * run on the request that first touches a collection. That is safe but it means
 * "the code declares an index" is not the same statement as "the database has
 * it": a collection that has never been written by the current build can still
 * be unindexed, and a unique index that does not exist is a duplicate-record
 * hazard rather than a performance one.
 *
 * This script answers the second question against the database the application
 * actually resolves to, and prints the row counts so the emptiness of any
 * assertion about production figures is visible instead of assumed.
 *
 * It never writes. Usage: npx tsx scripts/index-audit.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MongoClient, type Db, type Document } from 'mongodb'

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

/** Collections whose duplicates would be financial or audit integrity defects. */
const IDEMPOTENT_COLLECTIONS = [
  'transactions',
  'financeEntries',
  'stockMovements',
  'purchases',
  'products',
  'orders',
  'returns',
  'budgets',
  'profitDistributions',
]

/** The unique business keys that must exist for history to stay trustworthy. */
const UNIQUE_KEYS: Record<string, string[]> = {
  users: ['email'],
  roles: ['name'],
  products: ['sku'],
  orders: ['orderNumber'],
  returns: ['returnNumber'],
  tasks: ['taskNumber'],
  budgets: ['budgetNumber'],
  suppliers: ['name'],
  sessions: ['tokenHash'],
}

type IndexInfo = {
  name: string
  unique: boolean
  keys: string
  /**
   * The options the server is actually enforcing. A unique index that was once
   * created without `sparse` (or, worse, is not unique at all) still satisfies a
   * "does an index on these keys exist" check, so the key pattern alone cannot
   * be the basis for a duplicate-protection claim.
   */
  sparse: boolean
}

/**
 * Index metadata for one collection. `indexes()` on a namespace the server has
 * never created is not an error, but the code below still skips absent ones so
 * the report does not read a missing collection as a missing index.
 */
const indexesOf = async (db: Db, coll: string): Promise<IndexInfo[]> => {
  const indexes = await db.collection(coll).indexes()
  return indexes
    .filter((idx) => idx.name !== '_id_')
    .map((idx) => ({
      name: `${coll}.${idx.name}`,
      unique: idx.unique === true,
      keys: Object.keys((idx.key ?? {}) as Document).join('+'),
      sparse: idx.sparse === true,
    }))
}

async function main(): Promise<void> {
  const { getEnv } = await import('../src/lib/env')
  const { resolveDatabase, uriDefaultDatabase } = await import('../src/lib/db-name')

  const env = getEnv()
  const target = resolveDatabase({ ...env, MONGODB_TEST_DB: undefined })
  const client = new MongoClient(env.MONGODB_URI)
  await client.connect()
  const dbName = client.db(target.dbName).databaseName
  console.log(`Database: "${dbName}" (resolved from ${target.source})`)
  if (target.warning) console.log(`WARNING: ${target.warning}`)
  console.log(
    `URI path implies: ${uriDefaultDatabase(env.MONGODB_URI) ?? '<none — driver default>'}\n`
  )

  const db = client.db(dbName)
  const collections = (await db.listCollections().toArray()).map((c) => c.name).sort()
  const existing = new Set(collections)
  console.log(`Collections: ${existing.size}`)

  console.log('\n-- volumes (the basis for any "figures match records" claim) --')
  for (const coll of collections) {
    console.log(`  ${coll.padEnd(22)} ${await db.collection(coll).countDocuments()}`)
  }

  // Every index the server actually holds, so the checks below compare against
  // the deployment rather than against the code that was supposed to create it.
  const all: IndexInfo[] = []
  for (const coll of collections) all.push(...(await indexesOf(db, coll)))
  const unique = new Map<string, IndexInfo>()
  for (const idx of all) if (idx.unique) unique.set(`${idx.name.split('.')[0]}.${idx.keys}`, idx)

  console.log('\n-- unique business keys --')
  let missing = 0
  for (const [coll, keys] of Object.entries(UNIQUE_KEYS)) {
    if (!existing.has(coll)) {
      console.log(`  n/a     ${coll} (collection does not exist yet — no records to protect)`)
      continue
    }
    for (const key of keys) {
      const found = unique.get(`${coll}.${key}`)
      if (found) console.log(`  OK      ${coll}.${key} (${found.name})`)
      else {
        missing += 1
        console.log(`  MISSING unique index on ${coll}.${key}`)
      }
    }
  }

  console.log('\n-- idempotency guards (duplicate-write protection) --')
  for (const coll of IDEMPOTENT_COLLECTIONS) {
    if (!existing.has(coll)) continue
    const found = unique.get(`${coll}.idempotencyKey`)
    if (found) console.log(`  OK      ${coll}.idempotencyKey (${found.name})`)
    else {
      missing += 1
      console.log(`  MISSING unique sparse index on ${coll}.idempotencyKey`)
    }
  }

  /*
   * The specs themselves, not just their existence. `models/indexes.ts` treats
   * codes 85/86 as "already registered" and carries on, which is right for a
   * same-key index under a different name — and silently wrong if the stored
   * index is not unique. This is the list that makes that difference visible.
   */
  console.log('\n-- unique index specs as the server holds them --')
  for (const idx of all.filter((idx) => idx.unique).sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${idx.name.padEnd(46)} keys=${idx.keys.padEnd(20)} sparse=${idx.sparse}`)
  }

  console.log('\n-- duplicate rows already stored? (unique index would have blocked them) --')
  for (const [coll, keys] of Object.entries(UNIQUE_KEYS)) {
    if (!existing.has(coll)) continue
    for (const key of keys) {
      const dupes = await db
        .collection(coll)
        .aggregate([{ $group: { _id: `$${key}`, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
        .toArray()
      if (dupes.length)
        console.log(`  DUPLICATES ${coll}.${key}: ${JSON.stringify(dupes.slice(0, 5))}`)
    }
  }

  console.log(`\nMissing unique indexes: ${missing}`)
  await client.close()
  process.exit(0)
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
