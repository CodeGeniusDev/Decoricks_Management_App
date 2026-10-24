/**
 * Database dump / restore (Phase 10 Step 4).
 *
 * The Mongo shell tools (mongodump/mongorestore) are not installed on the
 * operator's Mac and backups must be reproducible from the repo alone, so the
 * dump is done with the same `mongodb` driver the app uses and serialised with
 * ExtendedJSON — which preserves `_id` ObjectIds, `Date`s and nested BSON types
 * exactly, so a restored collection is byte-for-byte equal in its figures.
 *
 * These helpers are transport-agnostic: the CLI scripts encrypt the returned
 * buffer to a file, and the Founder "Export now" route streams it to a download.
 */
import { EJSON } from 'bson'
import type { Db, Document } from 'mongodb'

export interface CollectionStat {
  name: string
  count: number
}

export interface BackupPayload {
  format: 'decoricks-backup/1'
  sourceDatabase: string
  generatedAt: string
  collections: CollectionStat[]
  /** EJSON-serialised documents per collection (already plain JSON-safe). */
  data: Record<string, Document[]>
}

/** Read every document from every collection into an EJSON-safe payload. */
export const dumpDatabase = async (db: Db): Promise<BackupPayload> => {
  const existing = (await db.listCollections().toArray()).map((c) => c.name).sort()
  const collections: CollectionStat[] = []
  const data: Record<string, Document[]> = {}

  for (const name of existing) {
    const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray()
    // Round-trip each document through EJSON now, so the payload is pure JSON
    // (safe to stringify, store and transport) with types already encoded.
    data[name] = docs.map((doc) => EJSON.serialize(doc) as unknown as Document)
    collections.push({ name, count: docs.length })
  }

  return {
    format: 'decoricks-backup/1',
    sourceDatabase: db.databaseName,
    generatedAt: new Date().toISOString(),
    collections,
    data,
  }
}

export interface RestoreResult {
  database: string
  perCollection: CollectionStat[]
  totalDocs: number
}

/**
 * Write a payload into `db`. Insertion preserves the original `_id`, so a second
 * restore into the same database would collide rather than duplicate — restore
 * targets are expected to be empty. `dryRun` counts what would be written and
 * touches nothing.
 */
export const restoreDatabase = async (
  db: Db,
  payload: BackupPayload,
  opts: { dryRun?: boolean } = {}
): Promise<RestoreResult> => {
  const perCollection: CollectionStat[] = []
  let totalDocs = 0

  for (const stat of payload.collections) {
    perCollection.push(stat)
    totalDocs += stat.count
    if (opts.dryRun) continue
    const docs = (payload.data[stat.name] ?? []).map(
      (doc) => EJSON.deserialize(doc as unknown as Document) as Document
    )
    if (docs.length === 0) continue
    await db.collection(stat.name).insertMany(docs, { ordered: false })
  }

  return { database: db.databaseName, perCollection, totalDocs }
}

/** Serialise a payload to the bytes that get encrypted / streamed. */
export const encodePayload = (payload: BackupPayload): Buffer =>
  Buffer.from(JSON.stringify(payload), 'utf8')

/** Inverse of {@link encodePayload}. */
export const decodePayload = (bytes: Buffer): BackupPayload => {
  const parsed = JSON.parse(bytes.toString('utf8')) as BackupPayload
  if (parsed.format !== 'decoricks-backup/1') {
    throw new Error(`unrecognised backup format "${parsed.format}"`)
  }
  return parsed
}
