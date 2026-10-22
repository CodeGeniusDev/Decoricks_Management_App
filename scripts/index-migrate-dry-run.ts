/**
 * Index migration helper (DECISION 3).
 *
 * Requirements:
 * - Never run against the real DB blindly — dry-run first, report existing
 *   `idempotencyKey:null` rows and index state.
 * - Require a backup before the real run.
 *
 * This script is READ-ONLY by default. Pass `--apply` only after confirming
 * a backup exists and reviewing the dry-run output. The apply path only
 * normalises `idempotencyKey: null` to omitted for idempotency-protected
 * collections and reports what would change; it will refuse to run unless
 * `--i-have-a-backup` is also passed.
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
    const value = match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)"?$/, '$1')
    if (process.env[match[1]] === undefined) process.env[match[1]] = value
  }
}
loadEnvLocal()

const IDEMPOTENT_COLLECTIONS = [
  'transactions',
  'stockMovements',
  'purchases',
  'products',
  'orders',
  'returns',
  'budgets',
  'profitDistributions',
  'tasks',
  'taskComments',
  'boards',
]

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const haveBackup = args.includes('--i-have-a-backup')

async function report(db: Db) {
  console.log('=== INDEX STATE (idempotencyKey) ===')
  for (const coll of IDEMPOTENT_COLLECTIONS) {
    const c = db.collection(coll)
    const exists = (await db.listCollections({ name: coll }).toArray()).length > 0
    if (!exists) {
      console.log(`${coll}: collection does not exist`)
      continue
    }
    const indexes = await c.indexes()
    const idempIdx = indexes.filter((i: any) => i.key && 'idempotencyKey' in i.key)
    console.log(`${coll}: indexes with idempotencyKey -> ${idempIdx.map((i:any)=>`${i.name}(unique=${i.unique},sparse=${i.sparse},partial=${!!i.partialFilterExpression})`).join(' | ') || 'NONE'}`)
    const nullCount = await c.countDocuments({ idempotencyKey: null })
    const undefCount = await c.countDocuments({ idempotencyKey: { $exists: false } })
    const stringCount = await c.countDocuments({ idempotencyKey: { $type: 'string' } })
    console.log(`  idempotencyKey: null=${nullCount}, missing=${undefCount}, string=${stringCount}`)
  }
}

async function main() {
  const { getEnv } = await import('../src/lib/env')
  const env = getEnv()
  const client = new MongoClient(env.MONGODB_URI)
  await client.connect()
  const db = client.db()
  console.log(`Connected to ${db.databaseName}`)
  await report(db)
  if (!apply) {
    console.log('\nDRY-RUN ONLY. To apply: --apply --i-have-a-backup (and ensure you have a backup first).')
    await client.close()
    process.exit(0)
  }
  if (!haveBackup) {
    console.error('Refusing to apply without --i-have-a-backup. Create a backup first.')
    await client.close()
    process.exit(1)
  }
  console.log('\nAPPLYING: removing idempotencyKey:null and normalising to omitted...')
  for (const coll of IDEMPOTENT_COLLECTIONS) {
    const c = db.collection(coll)
    const exists = (await db.listCollections({ name: coll }).toArray()).length > 0
    if (!exists) continue
    const res = await c.updateMany({ idempotencyKey: null }, { $unset: { idempotencyKey: '' } })
    console.log(`  ${coll}: unset null -> ${res.modifiedCount} modified`)
  }
  await report(db)
  await client.close()
}

void main().catch((e) => { console.error(e); process.exit(1) })
