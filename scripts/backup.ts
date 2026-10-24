/**
 * Encrypted database backup (Phase 10 Step 4).
 *
 * Dumps the resolved application database to ExtendedJSON, encrypts it with
 * AES-256-GCM under a passphrase that is NEVER stored in the repository, and
 * writes a single `.enc` file plus an unencrypted `.meta.json` sidecar (counts +
 * a SHA-256 of the archive, so an operator can verify integrity without the key).
 *
 * This script only READS the source database.
 *
 * Usage:
 *   DECORICKS_BACKUP_KEY_FILE=~/.decoricks/backup.key npx tsx scripts/backup.ts
 *   DECORICKS_BACKUP_KEY='…'          npx tsx scripts/backup.ts   # discouraged
 *   BACKUP_DIR=/Volumes/USB/decoricks npx tsx scripts/backup.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { getEnv } from '../src/lib/env'
import { resolveDatabase } from '../src/lib/db-name'
import { dumpDatabase, encodePayload } from '../src/lib/backup/serialize'
import { encryptBackup } from '../src/lib/backup/crypto'

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

/** Read the passphrase from a file OUTSIDE the repo, or the inline env var. */
const readPassphrase = (): string => {
  const file = process.env.DECORICKS_BACKUP_KEY_FILE
  if (file) {
    if (!existsSync(file))
      throw new Error(`DECORICKS_BACKUP_KEY_FILE points at a missing file: ${file}`)
    return readFileSync(file, 'utf8').trim()
  }
  const inline = process.env.DECORICKS_BACKUP_KEY
  if (inline) return inline.trim()
  throw new Error(
    'No backup passphrase. Set DECORICKS_BACKUP_KEY_FILE (preferred, a file outside the repo) ' +
      'or DECORICKS_BACKUP_KEY. The key is never read from the repository.'
  )
}

async function main(): Promise<void> {
  loadEnvLocal()
  const env = getEnv()
  const target = resolveDatabase(env)
  const passphrase = readPassphrase()

  const client = new MongoClient(env.MONGODB_URI)
  await client.connect()
  try {
    const db = client.db(target.dbName)
    console.log(`Backing up database "${db.databaseName}" (from ${target.source}) — read-only`)
    const payload = await dumpDatabase(db)
    const plain = encodePayload(payload)
    const container = encryptBackup(plain, passphrase)

    const outDir = path.resolve(process.cwd(), process.env.BACKUP_DIR ?? 'backups')
    mkdirSync(outDir, { recursive: true })
    const stamp = payload.generatedAt.replace(/[:.]/g, '-')
    const encPath = path.join(outDir, `decoricks-backup-${stamp}.enc`)
    const metaPath = path.join(outDir, `decoricks-backup-${stamp}.meta.json`)
    writeFileSync(encPath, container, { mode: 0o600 })

    const sha256 = createHash('sha256').update(container).digest('hex')
    const meta = {
      sourceDatabase: payload.sourceDatabase,
      generatedAt: payload.generatedAt,
      archive: path.basename(encPath),
      archiveBytes: container.length,
      plaintextBytes: plain.length,
      sha256,
      collections: payload.collections,
      totalDocs: payload.collections.reduce((s, c) => s + c.count, 0),
    }
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8')

    console.log(`  wrote ${encPath} (${container.length} bytes, encrypted)`)
    console.log(`  meta  ${metaPath}`)
    console.log(`  sha256 ${sha256}`)
    console.log(`  ${meta.collections.length} collections, ${meta.totalDocs} documents`)
  } finally {
    await client.close()
  }
}

void main().catch((err) => {
  console.error('Backup failed:', (err as Error).message)
  process.exit(1)
})
