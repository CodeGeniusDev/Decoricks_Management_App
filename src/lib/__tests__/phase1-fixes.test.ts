/**
 * Phase 1 — critical data-correctness regressions.
 *
 * These lock the two bugs that silently corrupted data on the production path
 * and that no other suite touches:
 *
 *   1. `PUT /api/roles/[id]` rejected *every* save of a role that owned a
 *      `tasks` matrix, because the payload schema validated only the five
 *      generic actions while a stored role legitimately carries the Phase 6
 *      board actions (`editOthers` …). The Founder's UI ticked the box, the API
 *      answered 400, and nothing reached MongoDB — "granted but not received".
 *      We prove the real handler now persists a grant AND a revocation, and
 *      still refuses an unknown action key (the fix is not a widening).
 *
 *   2. On a database that was never seeded, `GET /api/finance/categories` was
 *      empty (only `scripts/seed.ts`, absent from a Netlify deploy, created the
 *      defaults), so the transaction form's dropdown rendered blank. The runtime
 *      backfill must seed the SPEC defaults idempotently and never overwrite a
 *      category the Founder already edited.
 *
 * Runs against the in-memory Mongo stand-in (`helpers/mem-mongo`), the same one
 * the Phase 6 route tests use, so the write semantics are the real ones.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { createMemDb, type MemDb } from './helpers/mem-mongo'

let mem: MemDb

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => mem.handle),
  getMongoClient: vi.fn(async () => mem.client),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

// Imported after the mock so the handler resolves `getDatabase` to the mem db.
import { PUT as putRole } from '@/app/api/roles/[id]/route'
import { getRoleCollection } from '@/lib/models/User'
import {
  SPEC_EXPENSE_CATEGORIES,
  SPEC_INCOME_CATEGORIES,
  SPEC_ACCOUNTS,
} from '@/lib/finance-defaults'

const FOUNDER = new ObjectId('507f1f77bcf86cd799439011')

/** Minimal Request stand-in — the handler only ever calls `.json()`. */
const jsonRequest = (body: unknown) =>
  ({ json: async () => body }) as unknown as Request

/* ------------------------------ 1. roles PUT ------------------------------ */

describe('Phase 1 — permission save reaches MongoDB (roles PUT)', () => {
  const ROLE_ID = new ObjectId('507f1f77bcf86cd799439500')

  beforeEach(() => {
    mem = createMemDb()
    getRoleCollection(mem.handle as never).insertOne({
      _id: ROLE_ID,
      name: 'partner_afnan',
      displayName: 'Partner Ali',
      // A real stored role owns the Phase 6 board actions inside `tasks`.
      permissions: {
        tasks: { view: true, editOthers: true, comment: true },
        finance: { view: true, create: false },
      },
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })
  })

  it('accepts a payload containing task board actions instead of returning 400', async () => {
    const res = await putRole(
      jsonRequest({
        permissions: {
          // Full matrix the settings screen round-trips, incl. board actions.
          tasks: {
            view: true,
            create: true,
            edit: true,
            delete: true,
            editOthers: false, // a revocation
            deleteOthers: false,
            comment: true,
            manage: true, // a new grant
          },
        },
      }),
      { params: Promise.resolve({ id: ROLE_ID.toString() }) }
    )

    expect(res.status).toBe(200)
  })

  it('persists both the grant and the revocation to MongoDB', async () => {
    await putRole(
      jsonRequest({
        permissions: {
          tasks: {
            view: true,
            create: true,
            edit: true,
            delete: true,
            editOthers: false,
            deleteOthers: false,
            comment: true,
            manage: true,
          },
        },
      }),
      { params: Promise.resolve({ id: ROLE_ID.toString() }) }
    )

    const stored = await getRoleCollection(mem.handle as never).findOne({ _id: ROLE_ID })
    const tasks = (stored?.permissions as Record<string, Record<string, boolean>>).tasks

    // Newly granted and newly revoked are both reflected in the authoritative doc.
    expect(tasks.manage).toBe(true)
    expect(tasks.editOthers).toBe(false)
    expect(tasks.create).toBe(true)
    // Untouched modules survive the merge — the write is not a blind replace.
    expect((stored?.permissions as Record<string, unknown>).finance).toEqual({
      view: true,
      create: false,
    })
  })

  it('still rejects an unknown action key (the fix does not widen what is storable)', async () => {
    const res = await putRole(
      jsonRequest({ permissions: { tasks: { totallyMadeUp: true } } }),
      { params: Promise.resolve({ id: ROLE_ID.toString() }) }
    )

    expect(res.status).toBe(400)
  })
})

/* -------------------------- 2. finance defaults ---------------------------- */

describe('Phase 1 — finance defaults backfill (idempotent, non-destructive)', () => {
  beforeEach(() => {
    mem = createMemDb()
    // The module memoises its once-per-process promise, so each scenario gets a
    // fresh import with that cache reset — exactly a fresh deploy process.
    vi.resetModules()
  })

  const loadDefaults = async () => {
    const mod = await import('@/lib/finance-defaults')
    return mod.ensureFinanceDefaults
  }

  it('seeds the full SPEC category and account set on an empty database', async () => {
    const ensure = await loadDefaults()
    await ensure(mem.handle as never, FOUNDER)

    const cats = await mem.db.financeCategories.find({}).toArray()
    const accounts = await mem.db.accounts.find({}).toArray()

    expect(cats.length).toBe(SPEC_EXPENSE_CATEGORIES.length + SPEC_INCOME_CATEGORIES.length)
    expect(accounts.length).toBe(SPEC_ACCOUNTS.length)
    expect(cats.filter((c) => c.type === 'income').length).toBe(SPEC_INCOME_CATEGORIES.length)
    // Every seeded row is active and authored by the caller performing the read.
    expect(cats.every((c) => c.isActive === true)).toBe(true)
    expect(cats.every((c) => String(c.createdBy) === String(FOUNDER))).toBe(true)
  })

  it('is idempotent — a second run creates no duplicates', async () => {
    const ensure = await loadDefaults()
    await ensure(mem.handle as never, FOUNDER)
    const afterFirst = await mem.db.financeCategories.find({}).toArray()

    // Force a genuine second pass against the same data by resetting the cache.
    vi.resetModules()
    const ensureAgain = await loadDefaults()
    await ensureAgain(mem.handle as never, FOUNDER)
    const afterSecond = await mem.db.financeCategories.find({}).toArray()

    expect(afterSecond.length).toBe(afterFirst.length)
  })

  it('preserves a category the Founder already edited', async () => {
    // The Founder renamed the label and deactivated a default before the backfill.
    await mem.db.financeCategories.insertOne({
      _id: new ObjectId(),
      name: 'meta_ads',
      label: 'Paid Social',
      type: 'expense',
      isActive: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      createdBy: new ObjectId(),
    })

    const ensure = await loadDefaults()
    await ensure(mem.handle as never, FOUNDER)

    const metaAds = await mem.db.financeCategories.findOne({ name: 'meta_ads' })
    expect(metaAds?.label).toBe('Paid Social') // not overwritten back to "Meta Ads"
    expect(metaAds?.isActive).toBe(false) // deactivation survives
  })
})
