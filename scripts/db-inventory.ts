/**
 * Phase 5 §5 — read-only database inventory.
 *
 * `src/lib/mongodb.ts` resolves the database name as `MONGODB_TEST_DB` (test
 * runners only) and otherwise `undefined`, which hands the decision to the
 * `MONGODB_URI` path component. Both `.env.local` and `.env.example` ship a URI
 * with an *empty* path, so the driver falls back to its implicit default.
 *
 * Before changing that resolution this script answers one question with facts:
 * which databases on the cluster hold genuine records, and how many. It opens no
 * write handle beyond `listDatabases`/`countDocuments`.
 *
 * Usage: npx tsx scripts/db-inventory.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MongoClient } from 'mongodb'

// `.env.local` is loaded by hand rather than via dotenv so nothing is printed.
const envFile = resolve(process.cwd(), '.env.local')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const URI = process.env.MONGODB_URI ?? ''
if (!URI) {
  console.error('MONGODB_URI is not set')
  process.exit(1)
}

// Collections whose row counts distinguish a live database from an empty one.
const MARKERS = [
  'users',
  'sessions',
  'roles',
  'transactions',
  'tasks',
  'products',
  'orders',
  'suppliers',
  'messages',
  'audit_log',
]

/** Names this app owns; anything else on the cluster belongs to another project. */
const RELEVANT = /^(decoricks|test|admin|local|config)$/i

const main = async () => {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 15_000 })
  try {
    await client.connect()

    // What the driver thinks the default database is for this URI. This is the
    // value `client.db()` and `connected.db(undefined)` both end up using.
    const implicit = client.db().databaseName
    console.log(`URI default database (what the app uses today): ${JSON.stringify(implicit)}`)

    const dbs = await client.db().admin().listDatabases()
    console.log('\nDatabases on this cluster:')
    for (const db of dbs.databases ?? []) {
      const flag = RELEVANT.test(db.name) ? '' : '  (not used by this app)'
      console.log(`  - ${db.name}${flag}`)
    }

    console.log('\nRecord counts per candidate database:')
    for (const db of dbs.databases ?? []) {
      if (!RELEVANT.test(db.name)) continue
      const handle = client.db(db.name)
      const names = new Set((await handle.listCollections().toArray()).map((c) => c.name))
      const counts: string[] = []
      for (const m of MARKERS) {
        if (!names.has(m)) continue
        counts.push(`${m}=${await handle.collection(m).countDocuments()}`)
      }
      console.log(
        `  ${db.name.padEnd(18)} collections=${names.size}  ${counts.join(' ') || '(none of the app collections exist)'}`
      )
    }

    // Does the app's own bootstrap index set exist in the implicit database?
    const handle = client.db(implicit)
    const names = new Set((await handle.listCollections().toArray()).map((c) => c.name))
    console.log(
      `\nApp collections present in ${JSON.stringify(implicit)}: ${[...MARKERS].filter((m) => names.has(m)).join(', ') || 'NONE'}`
    )
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error('Inventory failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
