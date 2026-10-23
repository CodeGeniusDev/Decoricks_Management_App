import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/mongodb', () => ({ getDatabase: vi.fn() }))
vi.mock('@/lib/models/Tasks', () => ({ getTaskDocCollection: vi.fn() }))
vi.mock('@/lib/models/Chat', () => ({ getMessageCollection: vi.fn() }))
vi.mock('@/lib/models/Sales', () => ({ getOrderCollection: vi.fn(), getReturnCollection: vi.fn() }))
vi.mock('@/lib/models/Product', () => ({ getProductCollection: vi.fn(), getStockCollection: vi.fn() }))
vi.mock('@/lib/models/Ledger', () => ({ getLedgerCollection: vi.fn() }))
vi.mock('@/lib/models/Operations', () => ({ getBudgetCollection: vi.fn() }))
vi.mock('@/lib/models/Notifications', () => ({ getNotificationCollection: vi.fn() }))

import { computeCursor } from '@/lib/sync/cursor'
import { getTaskDocCollection } from '@/lib/models/Tasks'

const mockDb = {} as any

function chain(doc: any) {
  const c: any = {}
  c.find = vi.fn().mockReturnValue(c)
  c.sort = vi.fn().mockReturnValue(c)
  c.limit = vi.fn().mockReturnValue(c)
  c.project = vi.fn().mockReturnValue(c)
  c.next = vi.fn().mockResolvedValue(doc)
  return c
}

describe('sync cursor delete/archive propagation (polling)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tasks cursor queries with filter isArchived false so archiving newest row changes max timestamp', async () => {
    const chainObj = chain({ updatedAt: new Date('2024-01-02T00:00:00Z') })
    ;(getTaskDocCollection as any).mockReturnValue(chainObj)

    const cursor = await computeCursor(mockDb as any, ['tasks'])
    expect(cursor.tasks).toBe(new Date('2024-01-02T00:00:00Z').getTime())
    expect(chainObj.find).toHaveBeenCalledWith({ isArchived: false })
  })

  it('if newest row archived, cursor moves to next non-archived max (poll detects change)', async () => {
    const chainObj = chain({ updatedAt: new Date('2024-01-01T00:00:00Z') })
    ;(getTaskDocCollection as any).mockReturnValue(chainObj)

    const cursor = await computeCursor(mockDb as any, ['tasks'])
    expect(cursor.tasks).toBe(new Date('2024-01-01T00:00:00Z').getTime())
    expect(chainObj.sort).toHaveBeenCalledWith({ updatedAt: -1 })
  })
})
