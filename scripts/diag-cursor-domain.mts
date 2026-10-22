/**
 * Read-only probe: what high-water mark does each sync module's cursor carry,
 * and does it sit ahead of the clock this process is running on? A row whose
 * `updatedAt` was stamped in a different clock domain (a host whose TZ did not
 * match Asia/Karachi) permanently outranks every real change, so the client
 * adopts a baseline no live signal can exceed — and the sync silently stops.
 *
 * Usage: npx tsx scripts/diag-cursor-domain.mts [databaseName]
 */
import { MongoClient } from 'mongodb'
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const pick = (k: string) =>
  env
    .match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '')

const uri = pick('MONGODB_URI')
const dbName = process.argv[2] ?? 'decoricks_test'
if (!uri) throw new Error('MONGODB_URI missing')

const WATCHED: Record<string, string> = {
  products: 'inventory',
  stock: 'inventory',
  stockMovements: 'inventory',
  orders: 'sales',
  returns: 'sales',
  transactions: 'finance',
  tasks: 'tasks',
  messages: 'chat',
  chatChannels: 'chat',
}

async function main(): Promise<void> {
  const client = new MongoClient(uri!)
  await client.connect()
  try {
    const database = client.db(dbName)
    const now = Date.now()
    console.log(`# ${database.databaseName} — process clock now=${now}`)
    for (const [coll, module] of Object.entries(WATCHED)) {
      // No document fields are printed — this probe runs against production too,
      // and only the clock domain is interesting, never the record itself.
      const rows = await database
        .collection(coll)
        .find({}, { projection: { updatedAt: 1, createdAt: 1 } })
        .sort({ updatedAt: -1 })
        .limit(2)
        .toArray()
      for (const row of rows) {
        const at = (row.updatedAt ?? row.createdAt) as Date
        const ms = at.getTime()
        const ahead = ms - now
        console.log(
          `${module}/${coll} ` +
            `updatedAt=${ms} ${ahead > 0 ? `AHEAD +${(ahead / 3600000).toFixed(2)}h` : `-${(-ahead / 3600000).toFixed(2)}h`}`
        )
      }
      const count = await database.collection(coll).countDocuments()
      console.log(`  ${coll}: ${count} rows`)
    }
  } finally {
    await client.close()
  }
}

void main()
