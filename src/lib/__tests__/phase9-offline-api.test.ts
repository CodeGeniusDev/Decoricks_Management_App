/**
 * Phase 9 — Step 3 offline sync API tests.
 *
 * These lock the §6.4 contract of POST /api/offline/sync — "re-check
 * everything, trust nothing" — plus the two small companion routes, WITHOUT
 * a live database. The write engines (`createLedgerEntry`, `createBudget`)
 * have their own coverage; here the route is the unit under test, so they
 * are mocked and the assertions are about what the route hands THEM:
 *
 *   • 401 when the session is gone (an offline queue must not outlive login).
 *   • CURRENT permission is re-checked per operation — a partner_withdrawal
 *     needs `finance.approve`, a plain entry `finance.create`, a budget
 *     `budget.create`. A revocation while offline comes back as 403 AND
 *     fires `sync_conflict` server-side (§7: the alert cannot depend on the
 *     client surviving to report it).
 *   • The SAME zod schemas as the online forms reject a mutated payload
 *     with 400 before any engine is touched — and a 400 is NOT a conflict.
 *   • The envelope's idempotency key overrides any copy inside the payload
 *     (D3: exactly one arbiter), and the duplicate-key replay path answers
 *     200 {created:false} without re-firing entry notifications.
 *   • 409 (withdrawal lock) is a conflict: alerted AND passed through.
 *   • discard and sync-failure are auth-gated, audited / deduped exactly as
 *     documented, and nothing else is written.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import {
  authorize,
  requireAuth,
  AuthenticationError,
  AuthorizationError,
} from '@/lib/authorization'
import { HttpError } from '@/lib/http'

import { POST as syncPost } from '@/app/api/offline/sync/route'
import { POST as discardPost } from '@/app/api/offline/discard/route'
import { POST as syncFailurePost } from '@/app/api/offline/sync-failure/route'

const fakeDb = { collection: vi.fn() }

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => fakeDb),
  getMongoClient: vi.fn(async () => ({})),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

/* The write engines and notification plumbing — mocked so the assertions are
 * purely about the ROUTE's behaviour (permission mapping, delegation, audit,
 * conflict alerting, status codes). */
vi.mock('@/lib/finance-ledger', () => ({
  createLedgerEntry: vi.fn(),
  loadAccounts: vi.fn(async () => []),
  loadCategories: vi.fn(async () => []),
  buildSerializeContext: vi.fn(() => ({})),
  serializeEntry: vi.fn((doc: unknown) => doc),
}))
vi.mock('@/lib/budget-create', () => ({ createBudget: vi.fn() }))
vi.mock('@/lib/audit', () => ({ recordAuditEntry: vi.fn(async () => undefined) }))
vi.mock('@/lib/notifications/wiring', () => ({
  notifyFinanceEntryCreated: vi.fn(async () => undefined),
}))
vi.mock('@/lib/notifications/events', () => ({
  notifySyncConflict: vi.fn(async () => 1),
  notifySyncFailure: vi.fn(async () => 1),
}))

import { createLedgerEntry } from '@/lib/finance-ledger'
import { createBudget } from '@/lib/budget-create'
import { recordAuditEntry } from '@/lib/audit'
import { notifyFinanceEntryCreated } from '@/lib/notifications/wiring'
import { notifySyncConflict, notifySyncFailure } from '@/lib/notifications/events'

/* --------------------------------- fixtures -------------------------------- */

const ME = new ObjectId('507f1f77bcf86cd799439011')
const ACCOUNT = new ObjectId('6000000000000000000000aa')

type Json = Record<string, unknown> & {
  success: boolean
  data?: Record<string, unknown>
  error?: { code?: string; message?: string }
}
const readJson = async (res: Response): Promise<Json> => (await res.json()) as Json

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
})

const incomePayload = (key: string): Record<string, unknown> => ({
  type: 'income',
  amount: 1_500_000,
  date: '2026-10-10',
  accountId: ACCOUNT.toHexString(),
  category: 'client_payment',
  note: 'offline entry',
  idempotencyKey: key,
})

const envelope = (overrides: Record<string, unknown> = {}) => ({
  id: 'queue-row-uuid-000001',
  idempotencyKey: 'envelope-key-00001',
  operation: 'create_finance',
  payload: incomePayload('payload-copy-key-001'),
  ...overrides,
})

const budgetEnvelope = (key: string) =>
  envelope({
    idempotencyKey: key,
    operation: 'create_budget',
    payload: {
      name: 'Diwali run',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-07',
      categories: [{ category: 'fabric', budgeted: 500_000 }],
      idempotencyKey: key,
    },
  })

beforeEach(() => {
  vi.clearAllMocks()
  // The engines' default "happy path": a genuinely new row.
  vi.mocked(createLedgerEntry).mockResolvedValue({
    doc: { _id: new ObjectId(), ...incomePayload('x') },
    created: true,
  } as never)
  vi.mocked(createBudget).mockResolvedValue({
    budget: { _id: new ObjectId(), name: 'Diwali run' },
    created: true,
  } as never)
})

/* ------------------------------ POST /api/offline/sync ----------------------------- */

describe('POST /api/offline/sync — envelope and permission re-checks', () => {
  it('rejects a malformed envelope with 400 before touching auth or engines', async () => {
    const cases = [
      envelope({ operation: 'delete_everything' }), // unknown operation
      envelope({ idempotencyKey: 'short' }), // key below the 8-char floor
      envelope({ id: 'x' }), // queue id too short
      { garbage: true }, // not a sync request at all
    ]
    for (const body of cases) {
      const res = await syncPost(new Request('http://t/api/offline/sync', json(body)) as never)
      expect(res.status).toBe(400)
    }
    expect(authorize).not.toHaveBeenCalled()
    expect(createLedgerEntry).not.toHaveBeenCalled()
  })

  it('maps the operation to the CURRENT permission, not the one at enqueue time', async () => {
    await syncPost(new Request('http://t/api/offline/sync', json(envelope())) as never)
    expect(authorize).toHaveBeenCalledWith('finance', 'create')

    vi.mocked(authorize).mockClear()
    const withdrawal = envelope({
      payload: {
        ...incomePayload('key-1'),
        type: 'partner_withdrawal',
        partnerId: ME.toHexString(),
      },
    })
    await syncPost(new Request('http://t/api/offline/sync', json(withdrawal)) as never)
    expect(authorize).toHaveBeenCalledWith('finance', 'approve')

    vi.mocked(authorize).mockClear()
    await syncPost(
      new Request('http://t/api/offline/sync', json(budgetEnvelope('budget-key-2'))) as never
    )
    expect(authorize).toHaveBeenCalledWith('budget', 'create')
  })

  it('401 when the session is gone — the queue must drain only for a live login', async () => {
    vi.mocked(authorize).mockRejectedValueOnce(new AuthenticationError('Session expired'))
    const res = await syncPost(new Request('http://t/api/offline/sync', json(envelope())) as never)
    expect(res.status).toBe(401)
    expect(createLedgerEntry).not.toHaveBeenCalled()
  })

  it('403 on revoked permission AND fires sync_conflict server-side (§7)', async () => {
    vi.mocked(authorize).mockRejectedValueOnce(new AuthorizationError('finance', 'create'))
    const res = await syncPost(new Request('http://t/api/offline/sync', json(envelope())) as never)
    expect(res.status).toBe(403)
    expect(notifySyncConflict).toHaveBeenCalledWith(fakeDb, {
      userId: ME.toString(),
      idempotencyKey: 'envelope-key-00001',
      reason: 'You do not have permission to perform this action',
    })
    expect(createLedgerEntry).not.toHaveBeenCalled()
  })

  it('a failing conflict-alert never masks the real 403 response', async () => {
    vi.mocked(authorize).mockRejectedValueOnce(new AuthorizationError('finance', 'create'))
    vi.mocked(notifySyncConflict).mockRejectedValueOnce(new Error('push plumbing down'))
    const res = await syncPost(new Request('http://t/api/offline/sync', json(envelope())) as never)
    expect(res.status).toBe(403)
  })

  it('re-validates with the online zod schema: a mutated payload is 400, NOT a conflict', async () => {
    const broken = envelope({ payload: { ...incomePayload('key-3'), amount: -5 } })
    const res = await syncPost(new Request('http://t/api/offline/sync', json(broken)) as never)
    expect(res.status).toBe(400)
    const body = await readJson(res)
    expect(body.error?.code).toBe('VALIDATION_ERROR')
    expect(createLedgerEntry).not.toHaveBeenCalled()
    expect(notifySyncConflict).not.toHaveBeenCalled() // 400 is the user's edit to fix
  })

  it('the envelope key overrides the payload copy — one arbiter (D3)', async () => {
    const res = await syncPost(new Request('http://t/api/offline/sync', json(envelope())) as never)
    expect(res.status).toBe(201)
    const [db, data] = vi.mocked(createLedgerEntry).mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ]
    expect(db).toBe(fakeDb)
    expect(data.idempotencyKey).toBe('envelope-key-00001') // not 'payload-copy-key-001'
  })
})

describe('POST /api/offline/sync — created vs duplicate replay', () => {
  it('a new row answers 201, audits offline_sync_applied and replays notifications', async () => {
    const res = await syncPost(new Request('http://t/api/offline/sync', json(envelope())) as never)
    expect(res.status).toBe(201)
    const body = await readJson(res)
    expect(body.data?.created).toBe(true)

    const audit = vi.mocked(recordAuditEntry).mock.calls[0][1] as unknown as Record<string, unknown>
    expect(audit.action).toBe('offline_sync_applied')
    expect(audit.entityType).toBe('finance')
    expect(audit.newValue).toEqual({
      idempotencyKey: 'envelope-key-00001',
      offline: true,
      replayed: false,
    })
    expect(notifyFinanceEntryCreated).toHaveBeenCalledTimes(1)
  })

  it('the same key answers 200 {created:false} — no row, no re-notification (§7)', async () => {
    vi.mocked(createLedgerEntry).mockResolvedValueOnce({
      doc: { _id: new ObjectId(), ...incomePayload('x') },
      created: false,
    } as never)
    const res = await syncPost(new Request('http://t/api/offline/sync', json(envelope())) as never)
    expect(res.status).toBe(200)
    expect((await readJson(res)).data?.created).toBe(false)

    const audit = vi.mocked(recordAuditEntry).mock.calls[0][1] as unknown as Record<string, unknown>
    expect(audit.newValue).toMatchObject({ replayed: true })
    expect(notifyFinanceEntryCreated).not.toHaveBeenCalled()
  })

  it('a 409 business conflict (withdrawal lock) alerts the owner AND passes through', async () => {
    vi.mocked(createLedgerEntry).mockRejectedValueOnce(
      new HttpError('Withdrawals are locked', 409, 'WITHDRAWALS_LOCKED')
    )
    const res = await syncPost(new Request('http://t/api/offline/sync', json(envelope())) as never)
    expect(res.status).toBe(409)
    expect(notifySyncConflict).toHaveBeenCalledWith(fakeDb, {
      userId: ME.toString(),
      idempotencyKey: 'envelope-key-00001',
      reason: 'Withdrawals are locked',
    })
  })

  it('budget path: 201, audit tagged budget, engine receives the envelope key', async () => {
    const res = await syncPost(
      new Request('http://t/api/offline/sync', json(budgetEnvelope('budget-key-0001'))) as never
    )
    expect(res.status).toBe(201)
    const [, data] = vi.mocked(createBudget).mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ]
    expect(data.idempotencyKey).toBe('budget-key-0001')
    const audit = vi.mocked(recordAuditEntry).mock.calls[0][1] as unknown as Record<string, unknown>
    expect(audit.entityType).toBe('budget')
    expect(audit.action).toBe('offline_sync_applied')
  })
})

/* ----------------------------- POST /api/offline/discard ----------------------------- */

describe('POST /api/offline/discard — audit marker only, never the ledger', () => {
  const valid = {
    idempotencyKey: 'discard-key-001',
    operation: 'create_finance',
    reason: 'discarded-by-user',
    entryCreatedAt: '2026-10-10T12:00:00.000Z',
    deviceId: 'device-abc',
  }

  it('401 without a session', async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(new AuthenticationError('Session expired'))
    const res = await discardPost(new Request('http://t/api/offline/discard', json(valid)) as never)
    expect(res.status).toBe(401)
    expect(recordAuditEntry).not.toHaveBeenCalled()
  })

  it('rejects unknown reasons and malformed keys before any write', async () => {
    for (const body of [
      { ...valid, reason: 'oops-never-happened' },
      { ...valid, idempotencyKey: 'tiny' },
      { ...valid, operation: 'delete_order' },
    ]) {
      const res = await discardPost(
        new Request('http://t/api/offline/discard', json(body)) as never
      )
      expect(res.status).toBe(400)
    }
    expect(recordAuditEntry).not.toHaveBeenCalled()
  })

  it('records the discard audit with the owning module and reason', async () => {
    const res = await discardPost(new Request('http://t/api/offline/discard', json(valid)) as never)
    expect(res.status).toBe(200)
    expect((await readJson(res)).data).toMatchObject({ discarded: true })
    const audit = vi.mocked(recordAuditEntry).mock.calls[0][1] as unknown as Record<string, unknown>
    expect(audit.userId).toEqual(ME)
    expect(audit.action).toBe('offline_entry_discarded')
    expect(audit.entityType).toBe('finance')
    expect(audit.entityId).toBeNull() // the row never reached the ledger
    expect(audit.newValue).toMatchObject({
      idempotencyKey: 'discard-key-001',
      reason: 'discarded-by-user',
      offline: true,
    })
  })

  it('maps create_budget to the budget entity type', async () => {
    await discardPost(
      new Request(
        'http://t/api/offline/discard',
        json({ ...valid, operation: 'create_budget', reason: 'replaced-by-edit' })
      ) as never
    )
    const audit = vi.mocked(recordAuditEntry).mock.calls[0][1] as unknown as Record<string, unknown>
    expect(audit.entityType).toBe('budget')
    expect(audit.newValue).toMatchObject({ reason: 'replaced-by-edit' })
  })
})

/* -------------------------- POST /api/offline/sync-failure -------------------------- */

describe('POST /api/offline/sync-failure — one persistent alert per exhausted entry', () => {
  it('401 without a session, 400 with a malformed body', async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(new AuthenticationError('Session expired'))
    const unauth = await syncFailurePost(
      new Request(
        'http://t/api/offline/sync-failure',
        json({ idempotencyKey: 'failure-key-1', reason: 'x' })
      ) as never
    )
    expect(unauth.status).toBe(401)

    const bad = await syncFailurePost(
      new Request(
        'http://t/api/offline/sync-failure',
        json({ idempotencyKey: 'tiny', reason: '' })
      ) as never
    )
    expect(bad.status).toBe(400)
    expect(notifySyncFailure).not.toHaveBeenCalled()
  })

  it('emits for the caller and reports a fresh queueing', async () => {
    const res = await syncFailurePost(
      new Request(
        'http://t/api/offline/sync-failure',
        json({ idempotencyKey: 'failure-key-1', reason: 'Could not reach the server' })
      ) as never
    )
    expect(res.status).toBe(200)
    expect((await readJson(res)).data).toMatchObject({ queued: true, deduped: false })
    expect(notifySyncFailure).toHaveBeenCalledWith(fakeDb, {
      userId: ME.toString(),
      idempotencyKey: 'failure-key-1',
      reason: 'Could not reach the server',
    })
  })

  it('a deduped repeat answers honestly: queued=false, deduped=true', async () => {
    vi.mocked(notifySyncFailure).mockResolvedValueOnce(0)
    const res = await syncFailurePost(
      new Request(
        'http://t/api/offline/sync-failure',
        json({ idempotencyKey: 'failure-key-1', reason: 'again' })
      ) as never
    )
    expect((await readJson(res)).data).toMatchObject({ queued: false, deduped: true })
  })
})
