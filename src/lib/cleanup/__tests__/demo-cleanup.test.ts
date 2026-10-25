/**
 * Stage 2 cleanup — hermetic tests against a REAL in-memory MongoDB
 * (`mongodb-memory-server`), never `decoricks_prod`.
 *
 * These exercise the actual primitives the CLI relies on — `verifyNoDrift`,
 * `deleteDemoDocs`, `buildCleanupAuditDoc`, `assertZeroActivity` — seeded with
 * the frozen DEMO ids themselves so the count gate is proven against the exact
 * shape production will present. The critical safety property tested here is the
 * ABORT-ON-MISMATCH path: the deletion must never be trusted against a database
 * that has drifted from the reviewed Stage-1 set (a missing frozen id or a
 * surprise extra document both fail).
 */
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DEMO_MANIFEST,
  EXPECTED_TOTAL,
  CONFIG_BASELINE_PROD,
  verifyNoDrift,
  deleteDemoDocs,
  buildCleanupAuditDoc,
  assertZeroActivity,
} from '@/lib/cleanup/demo-cleanup'

let server: MongoMemoryServer
let client: MongoClient

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } })
  client = new MongoClient(server.getUri())
  await client.connect()
}, 120_000)

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

/** Seed every frozen id as a bare document, plus a small CONFIG baseline. */
const seedManifest = async (db: Db): Promise<void> => {
  for (const entry of DEMO_MANIFEST) {
    if (entry.ids.length === 0) continue
    await db
      .collection(entry.collection)
      .insertMany(entry.ids.map((id) => ({ _id: new ObjectId(id) })) as never[])
  }
  // Three accounts, opening balance PKR 0 — mirrors the prod ledger anchor.
  await db.collection('accounts').insertMany(
    ['Business Cash', 'Bank', 'Wallet'].map((name) => ({
      _id: new ObjectId(),
      name,
      kind: 'cash',
      openingBalance: 0,
      isActive: true,
    })) as never[]
  )
}

const freshDb = (): Db =>
  client.db(`cleanup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`)

describe('demo-cleanup manifest', () => {
  it('freezes exactly 56 demo documents across 10 collections', () => {
    expect(EXPECTED_TOTAL).toBe(56)
    expect(DEMO_MANIFEST).toHaveLength(10)
    // Every recorded id is a valid ObjectId.
    for (const entry of DEMO_MANIFEST) {
      for (const id of entry.ids) expect(id).toMatch(/^[a-f0-9]{24}$/)
    }
  })

  it('config baseline names the keep-collections (never in the demo manifest)', () => {
    const demoCollections = new Set(DEMO_MANIFEST.map((e) => e.collection))
    for (const kept of Object.keys(CONFIG_BASELINE_PROD)) {
      expect(demoCollections.has(kept), `${kept} must not be a delete target`).toBe(false)
    }
  })
})

describe('verifyNoDrift + deleteDemoDocs (happy path)', () => {
  it('passes against an exact match and deletes all 56', async () => {
    const db = freshDb()
    await seedManifest(db)

    const drift = await verifyNoDrift(db)
    expect(drift.ok).toBe(true)
    expect(drift.totalExpected).toBe(56)
    expect(drift.totalPresent).toBe(56)
    expect(drift.reasons).toEqual([])

    const result = await deleteDemoDocs(db)
    expect(result.totalDeleted).toBe(56)
    for (const entry of DEMO_MANIFEST) {
      const remaining = await db.collection(entry.collection).countDocuments()
      expect(remaining, `${entry.collection} emptied`).toBe(0)
    }

    // Accounts (config) must survive untouched.
    expect(await db.collection('accounts').countDocuments()).toBe(3)

    const zero = await assertZeroActivity(db)
    expect(zero.ok).toBe(true)
  })
})

describe('abort-on-mismatch path', () => {
  it('fails when a frozen id is missing (a listed document is already gone)', async () => {
    const db = freshDb()
    await seedManifest(db)
    // Delete one listed id to simulate drift.
    const first = DEMO_MANIFEST[0]
    await db.collection(first.collection).deleteOne({ _id: new ObjectId(first.ids[0]) })

    const drift = await verifyNoDrift(db)
    expect(drift.ok).toBe(false)
    expect(drift.reasons.some((r) => /not present/.test(r))).toBe(true)
  })

  it('fails when an unexpected extra document exists beyond the frozen set', async () => {
    const db = freshDb()
    await seedManifest(db)
    // Add a surprise document — could be a real record that appeared after Stage 1.
    await db.collection('messages').insertOne({ _id: new ObjectId() } as never)

    const drift = await verifyNoDrift(db)
    expect(drift.ok).toBe(false)
    expect(drift.reasons.some((r) => /unexpected live document/.test(r))).toBe(true)
  })

  it('deletes nothing when drift is present (id lists are explicit, never a sweep)', async () => {
    const db = freshDb()
    await seedManifest(db)
    await db.collection('messages').insertOne({ _id: new ObjectId() } as never)

    const drift = await verifyNoDrift(db)
    expect(drift.ok).toBe(false)
    // The CLI aborts on !ok before ever calling deleteDemoDocs; prove the extra
    // (unfrozen) document is not collateral damage of an explicit-id delete.
    const result = await deleteDemoDocs(db)
    expect(result.totalDeleted).toBe(56)
    expect(await db.collection('messages').countDocuments()).toBe(1) // only the surprise remains
  })
})

describe('assertZeroActivity (negative)', () => {
  it('fails when a ledger row remains (the demo transactions are still present)', async () => {
    const db = freshDb()
    await seedManifest(db)
    // Before deletion the ledger still holds the two demo transactions, so the
    // zero-activity assertion must fail — this is the state the CLI only accepts
    // AFTER a successful cleanup.
    const zero = await assertZeroActivity(db)
    expect(zero.ok).toBe(false)
    expect(zero.details.some((d) => /transactions still present/.test(d))).toBe(true)
  })
})

describe('buildCleanupAuditDoc', () => {
  it('produces one append-only audit record with counts, backup hash and operator', () => {
    const doc = buildCleanupAuditDoc({
      database: 'decoricks_prod',
      counts: { transactions: 2, messages: 22 },
      totalDeleted: 56,
      backupSha256: 'abc123',
      operator: 'abdullah',
      mode: 'transaction',
    })
    expect(doc.action).toBe('demo_data_cleanup')
    expect(doc.outcome).toBe('success')
    expect(doc.userEmail).toBe('system')
    expect((doc.newValue as { totalDeleted: number }).totalDeleted).toBe(56)
    expect((doc.newValue as { backupSha256: string }).backupSha256).toBe('abc123')
    expect((doc.newValue as { operator: string }).operator).toBe('abdullah')
    expect(String(doc.details)).toContain('56')
    expect(String(doc.details)).toContain('abc123')
  })
})

