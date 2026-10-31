/**
 * Profile pictures against the two pipelines that read the WHOLE database.
 *
 * `avatars` is the first collection in this app whose documents are not plain
 * JSON-ish records: the picture is BSON Binary. Two things could have gone wrong
 * when it was added, and both are silent — a backup that restores the metadata
 * but loses the bytes, or a cleanup/reconciliation whose collection list predates
 * the new one. So both are tested against a REAL in-memory MongoDB
 * (`mongodb-memory-server`), never `decoricks_prod` and never the `test` database.
 *
 * The chain here is the same one `scripts/backup.ts` and `scripts/restore.ts`
 * run, minus the CLI argument parsing: dump → EJSON → encrypt → (file bytes) →
 * decrypt → decode → restore → verify. If a step in that chain dropped the
 * Binary, this is where it shows.
 */
import { MongoMemoryServer } from 'mongodb-memory-server'
import { Binary, MongoClient, ObjectId, type Db, type Document } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { decodePayload, dumpDatabase, encodePayload, restoreDatabase } from '@/lib/backup/serialize'
import { decryptBackup, encryptBackup } from '@/lib/backup/crypto'
import { avatarBytes, avatarUrlFor, toAvatarBinary } from '@/lib/models/Avatars'
import {
  DEMO_MANIFEST,
  EXPECTED_TOTAL,
  assertZeroActivity,
  deleteDemoDocs,
  verifyNoDrift,
} from '@/lib/cleanup/demo-cleanup'
import { reconcile } from '@/lib/metrics/reconciliation'

/** Test-only passphrase for a container that never leaves this process. */
const PASSPHRASE = 'unit-test-passphrase-not-a-real-key-0123456789'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Deterministic bytes with a real PNG signature in front: the point is a
 * byte-for-byte comparison, so randomness would have to be seeded anyway, and a
 * picture this app accepts always starts with those eight bytes.
 */
const picture = (seed: number, length: number): Buffer => {
  const body = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) body[i] = (seed * 131 + i * 17 + (i % 251)) % 256
  return Buffer.concat([PNG, body])
}

const PICTURES = [picture(1, 4096), picture(2, 6000)]

let server: MongoMemoryServer
let client: MongoClient

/** Seed the source database: users, their pictures, and the frozen demo set. */
const seedSource = async (db: Db): Promise<{ userIds: ObjectId[]; avatarIds: ObjectId[] }> => {
  for (const entry of DEMO_MANIFEST) {
    if (entry.ids.length === 0) continue
    await db
      .collection(entry.collection)
      .insertMany(entry.ids.map((id) => ({ _id: new ObjectId(id) })) as never[])
  }
  await db.collection('accounts').insertMany(
    [
      { name: 'Business Cash', kind: 'cash' },
      { name: 'Bank', kind: 'bank' },
      { name: 'Wallet', kind: 'cash' },
    ].map((a) => ({ ...a, openingBalance: 0, isActive: true })) as never[]
  )

  const userIds = [new ObjectId(), new ObjectId()]
  const avatarIds = [new ObjectId(), new ObjectId()]
  const uploadedAt = new Date('2026-10-05T09:00:00.000Z')

  await db.collection('avatars').insertMany(
    userIds.map((userId, index) => ({
      _id: avatarIds[index],
      userId,
      contentType: index === 0 ? 'image/png' : 'image/jpeg',
      sizeBytes: PICTURES[index].length,
      uploadedAt,
      data: toAvatarBinary(new Uint8Array(PICTURES[index])),
    })) as never[]
  )

  await db.collection('users').insertMany(
    userIds.map((userId, index) => ({
      _id: userId,
      email: `member${index}@decoricks.test`,
      name: `Member ${index}`,
      role: index === 0 ? 'founder' : 'partner',
      isActive: true,
      passwordHash: '$2b$12$not-a-real-hash',
      avatarFileId: avatarIds[index],
      avatarContentType: index === 0 ? 'image/png' : 'image/jpeg',
      avatarSizeBytes: PICTURES[index].length,
      avatarUpdatedAt: uploadedAt,
    })) as never[]
  )

  return { userIds, avatarIds }
}

let source: Db
let avatarIds: ObjectId[] = []

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } })
  client = new MongoClient(server.getUri())
  await client.connect()

  source = client.db(`avatars_source_${Date.now()}_${Math.floor(Math.random() * 1e6)}`)
  const seeded = await seedSource(source)
  avatarIds = seeded.avatarIds
}, 180_000)

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

/**
 * A restore target the way `scripts/restore.ts` requires one: brand new and
 * empty, because restoring preserves the original `_id`s and a second restore
 * into the same database collides rather than duplicates.
 */
const freshTarget = (): Db =>
  client.db(`avatars_restored_${Date.now()}_${Math.floor(Math.random() * 1e6)}`)

/** The whole backup pipeline, exactly as the CLI runs it. */
const archive = async (): Promise<Buffer> => {
  const container = encryptBackup(encodePayload(await dumpDatabase(source)), PASSPHRASE)
  return decryptBackup(container, PASSPHRASE)
}

describe('avatars survive the encrypted backup and restore', () => {
  it('is enumerated by the dump with no registration anywhere', async () => {
    // `dumpDatabase` reads `listCollections()`, which is why adding a collection
    // never needed a change here — and why a test that only checked the restored
    // bytes could not tell a dump that skipped `avatars` from one that kept it.
    const payload = await dumpDatabase(source)
    const stat = payload.collections.find((c) => c.name === 'avatars')
    expect(stat).toBeDefined()
    expect(stat?.count).toBe(PICTURES.length)
    expect(payload.data.avatars).toHaveLength(PICTURES.length)
  })

  it('carries the exact bytes as BSON Binary inside the archive', async () => {
    const payload = decodePayload(await archive())
    const stored = payload.data.avatars[0] as Document

    // Not a base64 string in a custom field and not a hex blob: EJSON's own binary
    // type, which is what makes the restore hand back a `Binary` rather than text.
    const encoded = stored.data as unknown as { $binary?: { base64: string; subType: string } }
    expect(encoded.$binary, 'the picture was not serialised as BSON Binary').toBeDefined()
    expect(Buffer.from(encoded.$binary!.base64, 'base64').equals(PICTURES[0])).toBe(true)
    // Generic subtype — the driver default for `new Binary(bytes)`.
    expect(encoded.$binary!.subType).toMatch(/^00?$/)

    // The metadata that the pointer on the user document depends on.
    expect(stored._id).toEqual({ $oid: avatarIds[0].toString() })
    expect(stored.contentType).toBe('image/png')
    expect(stored.sizeBytes).toBe(PICTURES[0].length)
  })

  it('restores every picture byte-for-byte, signature included', async () => {
    const target = freshTarget()
    const payload = decodePayload(await archive())
    const result = await restoreDatabase(target, payload)

    expect(result.perCollection.find((c) => c.name === 'avatars')?.count).toBe(PICTURES.length)

    const docs = await target.collection('avatars').find({}).sort({ _id: 1 }).toArray()
    expect(docs).toHaveLength(PICTURES.length)

    for (const [index, doc] of docs.entries()) {
      // The serving path reads bytes through `avatarBytes`, so this is the
      // assertion that matters for a real request: the same function the route
      // uses, on the restored document, must return the uploaded bytes.
      const bytes = Buffer.from(avatarBytes(doc as never))
      expect(bytes.equals(PICTURES[index]), `picture ${index} differs after restore`).toBe(true)
      expect(bytes.subarray(0, 8).equals(PNG)).toBe(true)
      expect(doc.data).toBeInstanceOf(Binary)
      expect(doc.uploadedAt).toBeInstanceOf(Date)
      expect(String(doc._id)).toBe(String(avatarIds[index]))
    }
  })

  it('keeps a pointer that still resolves to a stored picture', async () => {
    const target = freshTarget()
    const payload = decodePayload(await archive())
    await restoreDatabase(target, payload)

    const users = await target.collection('users').find({}).sort({ _id: 1 }).toArray()
    expect(users).toHaveLength(2)

    for (const user of users) {
      const url = avatarUrlFor(user as never)
      expect(url).toBeDefined()
      // The URL carries the file id, and that id must name a document in the
      // restored collection — otherwise every `<img>` in the app 404s after a
      // restore while every count still matches.
      const id = new ObjectId(url!.split('/').pop()!)
      const doc = await target.collection('avatars').findOne({ _id: id, userId: user._id } as never)
      expect(doc, `${url} does not resolve after restore`).not.toBeNull()
      expect(Buffer.from(avatarBytes(doc as never)).length).toBe(user.avatarSizeBytes)
    }
  })
})

describe('the new collection cannot break the cleanup or the reconciliation', () => {
  it('is invisible to the drift gate and the frozen id list', async () => {
    // The cleanup addresses explicit `_id` lists and never enumerates collections,
    // so an extra collection cannot make it delete more, delete less, or abort.
    expect(DEMO_MANIFEST.map((e) => e.collection)).not.toContain('avatars')

    const report = await verifyNoDrift(source)
    expect(report.ok, report.reasons.join('; ')).toBe(true)
    expect(report.totalExpected).toBe(EXPECTED_TOTAL)

    const avatarsBefore = await source.collection('avatars').countDocuments()
    const result = await deleteDemoDocs(source)
    expect(result.totalDeleted).toBe(EXPECTED_TOTAL)

    // 56 records removed, and not one byte of anybody's profile picture among them.
    expect(await source.collection('avatars').countDocuments()).toBe(avatarsBefore)
    const survivors = await source.collection('avatars').find({}).sort({ _id: 1 }).toArray()
    for (const [index, doc] of survivors.entries()) {
      expect(Buffer.from(avatarBytes(doc as never)).equals(PICTURES[index])).toBe(true)
    }

    const zero = await assertZeroActivity(source)
    expect(zero.ok, zero.details.join('; ')).toBe(true)
  })

  it('reports identical figures across the restore and with or without avatars', async () => {
    const target = freshTarget()
    const payload = decodePayload(await archive())
    await restoreDatabase(target, payload)

    const range = { start: new Date(0), end: new Date(Date.now() + 365 * 86_400_000) }
    const now = new Date()

    const original = await reconcile(source, range, now)
    const withAvatars = await reconcile(target, range, now)
    await target.collection('avatars').drop()
    const withoutAvatars = await reconcile(target, range, now)

    // The first pair is the comparison `scripts/restore.ts` prints as MATCH/DIFF:
    // original database against restored copy, paisa for paisa. The second pair is
    // the one this file exists for — a reconciliation engine that had grown its own
    // collection list would produce a different report once `avatars` disappeared.
    expect(withAvatars.checks).toEqual(original.checks)
    expect(withoutAvatars.checks).toEqual(withAvatars.checks)
    expect(withAvatars.allPass).toBe(original.allPass)
    expect(withAvatars.checks.length, 'reconcile ran no checks').toBeGreaterThan(0)
  })
})
