/**
 * Serial allocation (Phase 5 BUILD #7 support).
 *
 * Order, purchase and return numbers are human-facing and carry a unique index,
 * so allocating one by "read the highest and add one" is a crash waiting to
 * happen: two concurrent creates read the same highest, both pick the same
 * candidate and the loser dies on the index. These tests pin the atomic
 * counter behaviour, including the seed that keeps hand-made numbers unique.
 */
import { describe, it, expect } from 'vitest'
import { ObjectId, type Db } from 'mongodb'
import { allocateSerial, monthPrefix } from '@/lib/serial'
import { createMemDb } from './helpers/mem-mongo'

const db = () => createMemDb().handle as unknown as Db

const spec = (prefix: string) => ({
  collection: 'orders',
  field: 'orderNumber',
  prefix,
})

describe('allocateSerial', () => {
  it('hands out a gapless sequence within one month prefix', async () => {
    const handle = db()
    const prefix = monthPrefix('SO')
    const first = await allocateSerial(handle, spec(prefix))
    const second = await allocateSerial(handle, spec(prefix))
    const third = await allocateSerial(handle, spec(prefix))

    expect(first).toBe(`${prefix}-0001`)
    expect(second).toBe(`${prefix}-0002`)
    expect(third).toBe(`${prefix}-0003`)
  })

  it('continues above the numbers already stored when the counter is created', async () => {
    const mem = createMemDb()
    mem.db.orders.push({ _id: new ObjectId(), orderNumber: `${monthPrefix('SO')}-0007` })
    mem.db.orders.push({ _id: new ObjectId(), orderNumber: `${monthPrefix('SO')}-0012` })

    const next = await allocateSerial(mem.handle as unknown as Db, spec(monthPrefix('SO')))
    expect(next).toBe(`${monthPrefix('SO')}-0013`)
  })

  it('gives every concurrent caller its own number — 20 at once, no repeats', async () => {
    const handle = db()
    const prefix = monthPrefix('SO')
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () => allocateSerial(handle, spec(prefix)))
    )

    expect(new Set(numbers).size).toBe(20)
    expect(numbers.map((n) => Number(n.slice(prefix.length + 1))).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1)
    )
  })

  it('keeps separate counters per prefix, so months never collide', async () => {
    const handle = db()
    expect(await allocateSerial(handle, spec('SO-202610'))).toBe('SO-202610-0001')
    expect(await allocateSerial(handle, spec('SO-202611'))).toBe('SO-202611-0001')
    expect(await allocateSerial(handle, spec('SO-202610'))).toBe('SO-202610-0002')
  })
})
