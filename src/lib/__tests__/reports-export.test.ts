import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Tests for GET /api/reports/export — the permission-checked, audit-logged
 * CSV/PDF download (Phase 8 Checkpoint 3, METRICS §L).
 *
 * Pins the guarantees the brief names:
 *  - "a user cannot export a figure they cannot view server-side": the whole
 *    aggregation sits behind `authorizeAllViews`, so a denied caller never
 *    receives bytes and never gets an audit entry.
 *  - every successful export writes exactly one `export`/`report` audit entry.
 *  - CSV is `text/csv` with the flattened Section/Item/Value table; the PDF is
 *    real PDF bytes (`%PDF`).
 *  - it reuses `buildPeriodReport`, so a bad period/date is refused with 400
 *    before any bytes or audit row are produced.
 */

const cursor = (rows: unknown[] = []) => {
  const c: Record<string, unknown> = {
    sort: () => c,
    limit: () => c,
    skip: () => c,
    project: () => c,
    next: async () => (rows.length ? rows[0] : null),
    toArray: async () => rows,
  }
  return c
}

const collection = (_name: string) => ({
  aggregate: vi.fn(() => cursor([])),
  find: vi.fn(() => cursor([])),
  findOne: vi.fn(async () => null),
  countDocuments: vi.fn(async () => 0),
})

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => ({ collection: (name: string) => collection(name) })),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

// Spy the append-only audit writer so we can assert an export is recorded.
vi.mock('@/lib/audit', () => ({
  recordAuditEntry: vi.fn(async () => undefined),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

const get = (query: string) => new Request('http://localhost/api/reports/export' + query) as never

describe('GET /api/reports/export', () => {
  it('returns a CSV download stamped with the report period', async () => {
    const { GET } = await import('@/app/api/reports/export/route')
    const res = await GET(get('?period=week&format=csv'))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/text\/csv/)
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment; filename=".*\.csv"/)
    expect(res.headers.get('Cache-Control')).toBe('no-store')

    const text = await res.text()
    expect(text).toContain('Section,Item,Value')
    expect(text).toContain('Sales,Revenue,PKR 0.00')
    expect(text).toContain('Profit & Loss,Net profit,PKR 0.00')
  })

  it('returns real PDF bytes for format=pdf', async () => {
    const { GET } = await import('@/app/api/reports/export/route')
    const res = await GET(get('?period=month&date=2026-10-15&format=pdf'))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toMatch(/\.pdf"/)

    const bytes = new Uint8Array(await res.arrayBuffer())
    // "%PDF" magic header proves the pdf-lib document actually serialized.
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF')
    expect(bytes.length).toBeGreaterThan(500)
  })

  it('records one export audit entry per successful download', async () => {
    const { GET } = await import('@/app/api/reports/export/route')
    const { recordAuditEntry } = await import('@/lib/audit')

    await GET(get('?period=week&format=csv'))

    expect(recordAuditEntry).toHaveBeenCalledTimes(1)
    const [, input] = vi.mocked(recordAuditEntry).mock.calls[0]
    expect(input).toMatchObject({ action: 'export', entityType: 'report', outcome: 'success' })
    expect(input.newValue).toMatchObject({ format: 'csv', period: 'week' })
  })

  it('refuses an unknown format before producing bytes or an audit entry', async () => {
    const { GET } = await import('@/app/api/reports/export/route')
    const { recordAuditEntry } = await import('@/lib/audit')

    const res = await GET(get('?period=week&format=xlsx'))
    expect(res.status).toBe(400)
    expect(recordAuditEntry).not.toHaveBeenCalled()
  })

  it('rejects a malformed date', async () => {
    const { GET } = await import('@/app/api/reports/export/route')
    const res = await GET(get('?period=week&date=nope&format=csv'))
    expect(res.status).toBe(400)
  })

  it('never exports for a caller who cannot view every underlying module', async () => {
    const { GET } = await import('@/app/api/reports/export/route')
    const { recordAuditEntry } = await import('@/lib/audit')
    const { authorizeAllViews, AuthorizationError } = await import('@/lib/authorization')

    // A revoked `inventory.view` makes the aggregate route refuse: no bytes,
    // no figure the caller could not already see, and no export audit entry.
    vi.mocked(authorizeAllViews).mockRejectedValueOnce(
      new AuthorizationError('inventory', 'view', 'Missing view permission for: inventory')
    )

    const res = await GET(get('?period=week&format=csv'))
    expect(res.status).toBe(403)
    expect(recordAuditEntry).not.toHaveBeenCalled()
  })

  it('stamps the filename with the period start date', async () => {
    const { GET } = await import('@/app/api/reports/export/route')
    const res = await GET(get('?period=month&date=2026-10-15&format=csv'))
    // The Karachi month starts 2026-10-01; the download reflects that civil
    // date (not the UTC instant of the range boundary, and not "today").
    expect(res.headers.get('Content-Disposition')).toMatch(/month-report-2026-10-01\.csv/)
  })
})
