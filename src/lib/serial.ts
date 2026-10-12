import { type ClientSession, type Db } from 'mongodb'
import { getKarachiDate } from './date'

/**
 * Human-readable serial numbers (order / purchase / return numbers).
 *
 * The Phase 1-4 pattern was "read the highest number in the month, add one,
 * check the candidate is free". That is not safe: two creates at the same
 * moment read the same highest number, both consider their candidate free and
 * the loser dies on the unique index as a 500 — a duplicate-key crash, not a
 * guard. This module allocates from an atomic per-prefix counter in a small
 * `counters` collection. `findOneAndUpdate` with `$inc` hands every caller a
 * distinct value, and the unique index on the document field stays exactly
 * where it was as the backstop.
 *
 * The counter is seeded from the highest serial already stored the first time
 * it is used for a month, so documents created by hand (or by the older
 * generator) are never re-issued. A burned number after a rolled-back
 * transaction leaves a gap in the sequence; gaps are preferable to a crash or
 * a duplicate, and the sequence is not an accounting field.
 */

export interface SerialSpec {
  /** Collection holding the records, e.g. `orders`. */
  collection: string
  /** Field holding the serial, e.g. `orderNumber`. */
  field: string
  /** Month prefix, e.g. `SO-202610`. */
  prefix: string
  /** Digits in the sequence part. */
  digits?: number
  /** Run inside the caller's transaction so allocation and insert commit together. */
  session?: ClientSession
}

/** `SO-YYYYMM` for the given base label, using the same clock as the records. */
export const monthPrefix = (base: string, date = getKarachiDate()): string =>
  `${base}-${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`

const parseSeq = (value: unknown, prefix: string): number => {
  const text = typeof value === 'string' ? value : ''
  if (!text.startsWith(`${prefix}-`)) return 0
  const parsed = Number.parseInt(text.slice(prefix.length + 1), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * Allocate the next serial for `prefix`, atomically.
 *
 * Returns `SO-202610-0007` style strings. Never returns a value another live
 * caller can also receive.
 */
export async function allocateSerial(db: Db, spec: SerialSpec): Promise<string> {
  const { collection, field, prefix, digits = 4, session } = spec
  const opts = session ? { session } : {}
  const records = db.collection(collection)
  const counters = db.collection('counters')
  const key = `${field}:${prefix}`

  // Only read the existing documents when the counter has to be created.
  let base = 0
  if (!(await counters.findOne({ _id: key } as never, opts))) {
    const highest = await records
      .find({ [field]: { $regex: `^${prefix}-` } } as never, opts)
      .sort({ [field]: -1 })
      .limit(1)
      .toArray()
    base = parseSeq(highest[0]?.[field], prefix)
  }

  const counter = await counters.findOneAndUpdate(
    { _id: key } as never,
    { $inc: { seq: 1 }, $setOnInsert: { base } } as never,
    { ...opts, upsert: true, returnDocument: 'after' } as never
  )

  // `base` is read back from the stored document: if another caller created it
  // first with a different seed, its seed is the one that keeps the sequence
  // clear of already-issued numbers.
  const storedBase = Number((counter as { base?: number })?.base ?? base)
  const seq = Number((counter as { seq?: number })?.seq ?? 1)

  return `${prefix}-${String(storedBase + seq).padStart(digits, '0')}`
}
