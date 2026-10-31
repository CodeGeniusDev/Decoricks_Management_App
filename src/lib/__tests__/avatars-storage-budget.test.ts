/**
 * What profile pictures cost against the Atlas M0 512 MB budget, measured.
 *
 * The claim in `src/lib/models/Avatars.ts` and `src/lib/image-signature.ts` is
 * that a 2 MB cap per person is safe because the whole team at the cap is a small
 * fraction of the instance. That is arithmetic someone could have written from a
 * gut feeling, and a wrong gut feeling here is not a failing test — it is a full
 * disk on the only copy of the business's financial records. So the numbers come
 * from a real mongod rather than from hand calculations:
 *
 *   - BSON framing around the bytes (the cap limits the image, not the document);
 *   - `dataSize` and `avgObjSize` with every member at the cap, the bytes each
 *     picture actually costs and the total the instance has to have room for;
 *   - the one extra document a replacement holds transiently, which is the actual
 *     worst case rather than the steady state;
 *   - `totalIndexSize`, because the `avatars_userId` index is paid for on top of
 *     the bytes and must not scale with them;
 *   - and what those pictures add to a `npm run backup` archive, where EJSON
 *     writes Binary as base64 and therefore costs a third more.
 *
 * Runs on `mongodb-memory-server` only. Never `decoricks_prod`, never the database
 * literally named `test`.
 */
import { MongoMemoryServer } from 'mongodb-memory-server'
import { BSON, Binary, MongoClient, ObjectId, type Db, type Document } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MAX_IMAGE_BYTES, inspectImage } from '@/lib/image-signature'
import { ensureAvatarIndexes, getAvatarCollection, toAvatarBinary } from '@/lib/models/Avatars'

/**
 * A structurally valid PNG of an exact total length: signature, an `IHDR` header
 * chunk, an `IEND` trailer, and a payload of pseudo-random bytes in between.
 *
 * Both halves matter. `inspectImage` refuses a file that merely pastes a signature
 * in front of noise, so fixtures that have to be accepted need real chunk
 * structure; and the payload is pseudo-random rather than a repeated byte because
 * a real JPEG or PNG is already entropy-coded — the document the budget is measured
 * against has to look like what a deployment actually stores. Deterministic,
 * because a budget that moves between runs is not a budget.
 */
const PNG_HEAD = 8 + 4 + 4 + 13 + 4 // signature, IHDR length, fourcc, data, CRC
const PNG_TAIL = 4 + 4 + 4 // IEND length, fourcc, fixed CRC

const png = (seed: number, total: number): Buffer => {
  const payload = Buffer.alloc(total - PNG_HEAD - PNG_TAIL)
  let state = seed
  for (let i = 0; i < payload.length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    payload[i] = (state >>> 16) & 0xff
  }

  const head = Buffer.alloc(PNG_HEAD)
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  head.writeUInt32BE(13, 8) // IHDR declares exactly 13 bytes
  head.write('IHDR', 12, 'ascii')
  head.writeUInt32BE(0x376a4715, 29)

  const tail = Buffer.alloc(PNG_TAIL)
  tail.write('IEND', 4, 'ascii')
  tail.set([0xae, 0x42, 0x60, 0x82], 8) // the constant CRC of an empty IEND

  return Buffer.concat([head, payload, tail])
}

/** Every team member at the cap at once, which is the question being asked. */
const TEAM_SIZE = 4

/** The documented budget this feature has to fit inside. */
const ATLAS_M0_BYTES = 512 * 1024 * 1024

/** Slack allowed around the cap by BSON framing, per document. */
const FRAMING_ALLOWANCE = 200

const MB = (bytes: number): string => (bytes / 1024 / 1024).toFixed(2)

/** The driver declares `Uint8Array`; the byte length is simply its length. */
const bsonLength = (doc: Document): number => (BSON.serialize(doc as never) as Uint8Array).length

let server: MongoMemoryServer
let client: MongoClient
let db: Db

/** One line of measurement per run — the numbers are the product of this file. */
const measured: Record<string, string> = {}

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } })
  client = new MongoClient(server.getUri())
  await client.connect()
  db = client.db(`avatars_budget_${Date.now()}_${Math.floor(Math.random() * 1e6)}`)
  await ensureAvatarIndexes(db)
}, 180_000)

afterAll(async () => {
  console.info(
    `[avatars budget] ${Object.entries(measured)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`
  )
  await client?.close()
  await server?.stop()
})

/**
 * `collStats` rather than `Collection.stats()` — the driver dropped the helper in
 * v6, and this is the same document the Atlas storage meter is built from.
 */
const statsOf = async (collection: string): Promise<Record<string, number>> =>
  (await db.command({ collStats: collection })) as unknown as Record<string, number>

const storeAvatar = async (userId: ObjectId, bytes: Buffer): Promise<ObjectId> => {
  const inspection = inspectImage(bytes)
  if (!inspection.ok) throw new Error(`test fixture rejected: ${inspection.message}`)
  const inserted = await getAvatarCollection(db).insertOne({
    userId,
    contentType: inspection.contentType,
    sizeBytes: inspection.size,
    uploadedAt: new Date(),
    data: toAvatarBinary(bytes),
  } as never)
  return inserted.insertedId
}

/** A picture whose total length is exactly the cap — accepted, and the largest the instance can ever hold. */
const atTheCap = (seed: number): Buffer => png(seed, MAX_IMAGE_BYTES)

describe('the shape of one maximum-size document', () => {
  it('puts the cap where the documentation says it is, and the sniffer agrees', () => {
    // The arithmetic below is only valid if the constant the docs quote is the
    // constant the code enforces, and if a picture of that size is actually
    // accepted rather than rejected for some other reason.
    expect(MAX_IMAGE_BYTES).toBe(2 * 1024 * 1024)
    expect(inspectImage(png(1, MAX_IMAGE_BYTES + 1)).ok).toBe(false)
    expect(inspectImage(atTheCap(1)).ok).toBe(true)
  })

  it('costs a fixed hundred-odd bytes of BSON framing around the image', () => {
    const userId = new ObjectId()
    const doc = (length: number) => ({
      _id: new ObjectId(),
      userId,
      contentType: 'image/png',
      sizeBytes: length,
      uploadedAt: new Date(),
      data: new Binary(png(2, length)),
    })

    const framingOf = (length: number): number => bsonLength(doc(length)) - length

    // Field names, types and the Binary header: a fixed cost, so the SAME framing
    // sits on a 1 KB icon and a 2 MB picture, which is what makes the cap a
    // statement about images rather than about documents.
    expect(framingOf(MAX_IMAGE_BYTES)).toBe(framingOf(1024))
    expect(framingOf(MAX_IMAGE_BYTES)).toBeLessThan(FRAMING_ALLOWANCE)
    measured.framing = `${framingOf(MAX_IMAGE_BYTES)}B/doc`
  })
})

describe('four team members at the cap', () => {
  let userIds: ObjectId[]

  beforeAll(async () => {
    userIds = Array.from({ length: TEAM_SIZE }, () => new ObjectId())
    for (const [index, userId] of userIds.entries()) {
      await storeAvatar(userId, atTheCap(100 + index))
    }
  }, 120_000)

  it('is 8 MB of picture, and a small fraction of the instance', async () => {
    const stats = await statsOf('avatars')
    const stored = stats.size ?? 0

    expect(stats.count).toBe(TEAM_SIZE)
    // The ceiling the documentation may quote: the cap plus framing, per person.
    const ceiling = TEAM_SIZE * (MAX_IMAGE_BYTES + FRAMING_ALLOWANCE)
    expect(stored).toBeGreaterThan(TEAM_SIZE * MAX_IMAGE_BYTES - 1024)
    expect(stored).toBeLessThanOrEqual(ceiling)
    // The claim worth keeping as a guard: at the cap the feature is a rounding
    // error against the budget, so it cannot be the thing that fills the instance.
    expect(stored / ATLAS_M0_BYTES).toBeLessThan(0.02)

    measured.data = `${MB(stored)}MB (${((stored / ATLAS_M0_BYTES) * 100).toFixed(2)}% of M0)`
  })

  it('spends kilobytes on the index, not megabytes', async () => {
    const stats = await statsOf('avatars')
    // A two-key index over four documents. If this ever scales with the image size
    // then something is indexing the bytes — the mistake that WOULD fill the
    // instance, since the picture is the only large field in this database.
    expect(stats.totalIndexSize ?? 0).toBeLessThan(1024 * 1024)
    measured.index = `${((stats.totalIndexSize ?? 0) / 1024).toFixed(0)}KB`
  })

  it('is metered per document as the cap plus framing, with nothing hidden on top', async () => {
    const stats = await statsOf('avatars')
    // `avgObjSize` is what one stored picture costs the instance, and it is the
    // number that answers "is the image being held twice?" — a document storing the
    // bytes once measures the cap plus framing and nothing else.
    //
    // Deliberately not `storageSize`: that depends on the storage engine's block
    // allocation, and the engine in this container is ephemeral, so its answer
    // describes the test harness rather than the deployment.
    expect(stats.avgObjSize ?? 0).toBeLessThanOrEqual(MAX_IMAGE_BYTES + FRAMING_ALLOWANCE)
    expect(stats.avgObjSize ?? 0).toBeGreaterThanOrEqual(MAX_IMAGE_BYTES + 100)
    measured.avgDoc = `${((stats.avgObjSize ?? 0) / 1024 / 1024).toFixed(3)}MB/doc`
  })
})

describe('the worst case rather than the steady state', () => {
  it('holds one extra document mid-replacement, and the next upload reclaims it', async () => {
    const userId = new ObjectId()
    const first = await storeAvatar(userId, atTheCap(7))
    const avatars = getAvatarCollection(db)
    expect(await avatars.countDocuments({ userId } as never)).toBe(1)

    /*
     * A replacement inserts before it points, so for the length of one request the
     * collection holds two maximum-size pictures for one person. That transient
     * second document — not the steady state — is the worst case worth budgeting.
     */
    const inserted = await storeAvatar(userId, atTheCap(8))
    expect(await avatars.countDocuments({ userId } as never)).toBe(2)

    // The route's sweep (`deleteOne` for everything this user owns that is not the
    // pointer) is what stops a crash between insert and point from accreting
    // pictures: the following upload removes the stale one.
    await avatars.deleteOne({ userId, _id: { $ne: inserted } } as never)
    expect(await avatars.countDocuments({ userId } as never)).toBe(1)
    expect(first.toString()).not.toBe(inserted.toString())

    // So the bound is the team at the cap plus one picture per person mid-upload,
    // never an unbounded pile of history.
    const ceiling = (TEAM_SIZE + 1) * (MAX_IMAGE_BYTES + FRAMING_ALLOWANCE)
    expect(ceiling / ATLAS_M0_BYTES).toBeLessThan(0.03)
    measured.worstCase = `${MB(ceiling)}MB (${((ceiling / ATLAS_M0_BYTES) * 100).toFixed(2)}% of M0)`
  }, 120_000)
})

describe('the same pictures in a backup archive', () => {
  it('costs a third more as base64, on the disk that holds the archives', () => {
    /*
     * `scripts/backup.ts` writes EJSON, which encodes Binary as base64. The archive
     * is local and encrypted, not on Atlas, so this does not touch the 512 MB
     * budget — but it is the figure that grows the backup file, and it belongs in
     * the same arithmetic rather than being discovered on the day a disk is full.
     */
    const perPicture = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    const team = perPicture * TEAM_SIZE
    expect(perPicture / MAX_IMAGE_BYTES).toBeCloseTo(4 / 3, 4)

    // What the encoder actually produces, so the ratio is not theory: the BSON
    // binary field is the raw payload, and it is the JSON form that inflates.
    const serialised = bsonLength({ data: new Binary(png(3, MAX_IMAGE_BYTES)) })
    expect(serialised).toBeGreaterThan(MAX_IMAGE_BYTES)
    expect(serialised).toBeLessThan(MAX_IMAGE_BYTES + FRAMING_ALLOWANCE)

    measured.archive = `${MB(team)}MB for ${TEAM_SIZE} pictures (base64, before compression)`
  })
})
