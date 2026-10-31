/**
 * The audit trail is read back on the Settings screen and copied into backups, so
 * a secret written into `details` is not merely logged — it is stored, listed and
 * exported.
 *
 * `sanitize` already redacts secret-shaped KEYS inside `oldValue`/`newValue`, which
 * is the structured half of the problem. `details` is the free-text half: a single
 * string composed by whoever called the route, so nothing in the type system stops
 * a future caller building it out of `request.url`. The writer scrubs it, which is
 * why these tests run against the entry that reaches the collection rather than
 * against `scrubCredentials` directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ObjectId } from 'mongodb'

const inserted: Record<string, unknown>[] = []

vi.mock('@/lib/models/User', () => ({
  getAuditLogCollection: () => ({
    insertOne: async (entry: Record<string, unknown>) => {
      inserted.push(entry)
    },
    insertMany: async (entries: Record<string, unknown>[]) => {
      inserted.push(...entries)
    },
  }),
}))

const SECRET = 'Sup3r-Secret-Pa55w0rd'

let recordAuditEntry: (typeof import('@/lib/audit'))['recordAuditEntry']
let recordManyAuditEntries: (typeof import('@/lib/audit'))['recordManyAuditEntries']

beforeEach(async () => {
  inserted.length = 0
  const audit = await import('@/lib/audit')
  recordAuditEntry = audit.recordAuditEntry
  recordManyAuditEntries = audit.recordManyAuditEntries
})

const base = {
  action: 'update',
  entityType: 'user',
  entityId: '507f1f77bcf86cd799439011',
}

describe('audit details are scrubbed on the way in', () => {
  it('never persists a credential quoted in a detail line', async () => {
    await recordAuditEntry({} as never, {
      ...base,
      details: `Rejected login for a@b.pk (see /login?email=a@b.pk&password=${SECRET})`,
    })
    const stored = String(inserted[0].details)
    expect(stored).not.toContain(SECRET)
    expect(stored).toContain('password=[redacted]')
    // The part an investigator actually needs survives: who, what, where.
    expect(stored).toContain('Rejected login for a@b.pk')
  })

  it('scrubs the batch writer the same way, entry for entry', async () => {
    await recordManyAuditEntries(
      {} as never,
      [
        { ...base, details: `reset token=${SECRET}` },
        { ...base, details: 'no secrets here' },
      ].map((input) => ({ ...input, outcome: 'failure' as const }))
    )
    expect(inserted).toHaveLength(2)
    expect(String(inserted[0].details)).not.toContain(SECRET)
    expect(String(inserted[0].details)).toContain('token=[redacted]')
    // An ordinary detail is stored word for word — audit entries are the record of
    // what happened, and rewriting them is not this function's job.
    expect(String(inserted[1].details)).toBe('no secrets here')
  })

  it('leaves an absent detail absent rather than creating an empty one', async () => {
    await recordAuditEntry({} as never, base)
    expect(inserted[0].details).toBeUndefined()
  })

  it('keeps redacting secret keys inside the structured values', async () => {
    await recordAuditEntry({} as never, {
      ...base,
      newValue: { email: 'a@b.pk', password: SECRET, nested: { currentPassword: SECRET } },
    })
    const stored = JSON.stringify(inserted[0].newValue)
    expect(stored).not.toContain(SECRET)
    expect(stored).toContain('"password":"[redacted]"')
    expect(stored).toContain('"email":"a@b.pk"')
  })

  it('leaves the entry shape untouched for an ordinary detail', async () => {
    // The scrub must not become an excuse to rewrite the record. SPEC §10.2.6
    // Test 17 makes this trail append-only and immutable, so an operator reading
    // it six months from now is reading exactly what was written then.
    await recordAuditEntry({} as never, {
      ...base,
      userId: '507f1f77bcf86cd799439012' as unknown as ObjectId,
      outcome: 'success',
      details: 'Updated supplier Arfa Textiles',
    })
    expect(inserted[0].details).toBe('Updated supplier Arfa Textiles')
    expect(inserted[0]).toMatchObject({
      action: 'update',
      entityType: 'user',
      outcome: 'success',
      userId: expect.anything(),
    })
    expect(inserted[0]).not.toHaveProperty('password')
    expect(inserted[0]).not.toHaveProperty('url')
  })
})
