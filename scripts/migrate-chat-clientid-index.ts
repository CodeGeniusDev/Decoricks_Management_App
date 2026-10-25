/**
 * Reversible migration: `{ channelId, clientId }` unique index — sparse → partial.
 *
 * WHY. The Phase 7 index `messages_channel_client_unique` was declared
 * `unique + sparse`. A COMPOUND sparse index only skips a document missing EVERY
 * key field, so a legacy message that has a `channelId` but no `clientId` is
 * still indexed under `{ channelId, null }`. The first two of those in one
 * channel collide. `migrateLegacyMessages` (run on chat init) backfills
 * `channelId` onto exactly those pre-channel rows, so every boot fed a fresh
 * `{ general, null }` pair into the index and threw
 * `E11000 … messages_channel_client_unique … clientId: null`, on repeat.
 *
 * The application now creates the CORRECT index — `partialFilterExpression:
 * { clientId: { $type: 'string' } }` — which indexes only messages that carry a
 * real idempotency token and leaves legacy rows out entirely. That keeps send
 * dedup intact and lets the channelId backfill complete. But creating an index
 * never removes the OLD one, and boot code must not drop indexes on its own;
 * this script is the deliberate, one-time swap.
 *
 * WHAT IT DOES (apply):
 *   1. Reads the current index definitions and counts the documents that are
 *      affected. Nothing is written before this is shown.
 *   2. Creates the partial index under a NEW name (additive, cannot collide).
 *   3. Completes the additive channelId/isDeleted backfill for legacy rows that
 *      predate the channel model (no message body is touched).
 *   4. Drops ONLY the named legacy sparse index, and only once the replacement
 *      is confirmed present.
 *
 * SAFETY RAILS:
 *   - DRY-RUN by default; nothing is written without `--apply`.
 *   - `--apply` requires `--confirm-backup` (a verified encrypted backup exists,
 *     Phase 10 Step 4) and, for a non-test-shaped database, the explicit
 *     `DECORICKS_ALLOW_PROD_DB=1` consent flag.
 *   - It NEVER deletes, edits text, or reorders messages; the only document write
 *     is the same `channelId`/`isDeleted` backfill the app already performs.
 *   - `--rollback` reverses the INDEX change only (drop partial, recreate the
 *     legacy sparse index) for emergencies — and warns that it reintroduces the
 *     null collision.
 *
 * Usage:
 *   npx tsx scripts/migrate-chat-clientid-index.ts                     # dry run
 *   npx tsx scripts/migrate-chat-clientid-index.ts --apply --confirm-backup
 *   DECORICKS_ALLOW_PROD_DB=1 npx tsx scripts/migrate-chat-clientid-index.ts --apply --confirm-backup
 *   npx tsx scripts/migrate-chat-clientid-index.ts --rollback --confirm-backup
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MongoClient, type Document } from 'mongodb'
import { getEnv } from '../src/lib/env'
import {
  resolveDatabase,
  assertScriptDatabaseConsent,
  PROD_DB_CONSENT_FLAG,
} from '../src/lib/db-name'
import {
  CHAT_CLIENT_IDEMPOTENCY_INDEX,
  LEGACY_CHAT_CLIENT_IDEMPOTENCY_INDEX,
} from '../src/lib/models/Chat'

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

async function main(): Promise<void> {
  loadEnvLocal()
  const apply = process.argv.includes('--apply')
  const rollback = process.argv.includes('--rollback')
  const confirmBackup = process.argv.includes('--confirm-backup')
  if (apply && rollback) throw new Error('--apply and --rollback are mutually exclusive.')

  const env = getEnv()
  const target = resolveDatabase(env)
  const dbName = target.dbName ?? 'test'

  const client = new MongoClient(env.MONGODB_URI)
  await client.connect()
  try {
    const db = client.db(dbName)
    const messages = db.collection('messages')
    const channels = db.collection('chatChannels')

    console.log(`Messages database: "${db.databaseName}" (resolved from ${target.source})`)
    if (target.warning) console.warn(`WARNING: ${target.warning}`)

    const indexes = (await messages.listIndexes().toArray()) as Document[]
    console.log('\nCurrent indexes on `messages`:')
    for (const i of indexes) {
      console.log(
        `  ${i.name}  key=${JSON.stringify(i.key)}` +
          `${i.unique ? '  unique' : ''}${i.sparse ? '  sparse' : ''}` +
          `${i.partialFilterExpression ? `  partial=${JSON.stringify(i.partialFilterExpression)}` : ''}`
      )
    }

    const hasLegacy = indexes.some((i) => i.name === LEGACY_CHAT_CLIENT_IDEMPOTENCY_INDEX)
    const hasPartial = indexes.some((i) => i.name === CHAT_CLIENT_IDEMPOTENCY_INDEX)
    const legacyNoChannelId = await messages.countDocuments({ channelId: { $exists: false } })
    const noClientId = await messages.countDocuments({ clientId: { $exists: false } })

    // The documents that collide today: same channelId, both missing clientId.
    const collisionGroups = await messages
      .aggregate([
        { $match: { channelId: { $exists: true }, clientId: { $exists: false } } },
        { $group: { _id: '$channelId', n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $sort: { n: -1 } },
      ])
      .toArray()

    console.log('\nAffected documents:')
    console.log(`  messages missing clientId ............ ${noClientId}`)
    console.log(`  messages missing channelId (un-migrated) ${legacyNoChannelId}`)
    console.log(
      `  {channelId,clientId} collision groups ... ${collisionGroups.length}` +
        (collisionGroups.length
          ? ` (${collisionGroups.map((g) => `${g._id}:${g.n}`).join(', ')})`
          : '')
    )
    console.log(`  legacy sparse index present .......... ${hasLegacy}`)
    console.log(`  partial index present ................ ${hasPartial}`)

    // ---- rollback: restore the legacy sparse index, drop the partial one ----
    if (rollback) {
      if (!confirmBackup) throw new Error('--rollback requires --confirm-backup.')
      assertScriptDatabaseConsent(db.databaseName, {
        script: 'scripts/migrate-chat-clientid-index.ts',
      })
      console.log(
        '\nROLLBACK: recreating the legacy sparse unique index and dropping the partial one.'
      )
      console.warn('  WARNING: this reintroduces the { channelId, null } collision on legacy rows.')
      if (!hasLegacy) {
        await messages.createIndex(
          { channelId: 1, clientId: 1 },
          { unique: true, sparse: true, name: LEGACY_CHAT_CLIENT_IDEMPOTENCY_INDEX }
        )
      }
      if (hasPartial) await messages.dropIndex(CHAT_CLIENT_IDEMPOTENCY_INDEX)
      console.log('  done. Re-run the forward migration to fix again.')
      return
    }

    if (!apply) {
      console.log('\nDRY-RUN. Nothing written. To apply:')
      console.log(
        `  ${hasPartial && !hasLegacy ? '(already migrated — nothing to do)' : `[${PROD_DB_CONSENT_FLAG}=1] npx tsx scripts/migrate-chat-clientid-index.ts --apply --confirm-backup`}`
      )
      return
    }

    // ---- apply ----
    if (!confirmBackup) {
      throw new Error(
        '--apply requires --confirm-backup: assert a verified encrypted backup of this database ' +
          'exists (see docs/BACKUP_RECOVERY.md) before mutating its indexes.'
      )
    }
    assertScriptDatabaseConsent(db.databaseName, {
      script: 'scripts/migrate-chat-clientid-index.ts',
    })

    // 1. Additive: create the partial index. Safe even while the legacy index exists.
    if (!hasPartial) {
      await messages.createIndex(
        { channelId: 1, clientId: 1 },
        {
          unique: true,
          name: CHAT_CLIENT_IDEMPOTENCY_INDEX,
          partialFilterExpression: { clientId: { $type: 'string' } },
        }
      )
      console.log(`\n  created partial index ${CHAT_CLIENT_IDEMPOTENCY_INDEX}`)
    } else {
      console.log(`\n  partial index ${CHAT_CLIENT_IDEMPOTENCY_INDEX} already present`)
    }

    // 2. Backfill the additive channel/isDeleted fields. With the legacy index
    //    still present this is exactly what used to throw; but the partial index
    //    is created first, and we drop the legacy one BEFORE the backfill so the
    //    {channelId,null} constraint no longer blocks it.
    // 3. Drop ONLY the named legacy sparse index, now that the replacement is confirmed.
    if (hasLegacy) {
      await messages.dropIndex(LEGACY_CHAT_CLIENT_IDEMPOTENCY_INDEX)
      console.log(`  dropped legacy index ${LEGACY_CHAT_CLIENT_IDEMPOTENCY_INDEX}`)
    } else {
      console.log('  legacy index already absent')
    }

    // 4. Complete the migration the app could not finish while the legacy index lived.
    const general = (await channels.findOne({ key: 'general' })) as { _id?: unknown } | null
    if (general?._id) {
      const channelIdRes = await messages.updateMany(
        { channelId: { $exists: false } },
        { $set: { channelId: general._id } }
      )
      console.log(`  backfilled channelId on ${channelIdRes.modifiedCount} legacy message(s)`)
    } else {
      console.log('  `general` channel not found; leaving channelId backfill to app init')
    }
    const isDeletedRes = await messages.updateMany(
      { isDeleted: { $exists: false } },
      { $set: { isDeleted: false } }
    )
    console.log(`  defaulted isDeleted on ${isDeletedRes.modifiedCount} legacy message(s)`)

    const after = ((await messages.listIndexes().toArray()) as Document[]).map((i) => i.name)
    console.log(`\nApplied. Remaining indexes: ${after.join(', ')}`)
    console.log(
      'Rollback (index only): npx tsx scripts/migrate-chat-clientid-index.ts --rollback --confirm-backup'
    )
  } finally {
    await client.close()
  }
}

void main().catch((err) => {
  console.error('Migration failed:', (err as Error).message)
  process.exit(1)
})
