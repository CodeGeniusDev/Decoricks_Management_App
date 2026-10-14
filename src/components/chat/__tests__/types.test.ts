/**
 * Chat reconciliation helpers (Phase 7 UI).
 *
 * These two pure functions are where "no duplicate or out-of-order messages,
 * messages don't jump on send" actually lives, so they are pinned here rather
 * than only observed in a browser.
 */
import { describe, it, expect } from 'vitest'
import {
  mergeMessages,
  newestTimestamp,
  sortMessages,
  type ChatMessage,
  type ServerMessage,
} from '../types'

const server = (over: Partial<ServerMessage>): ServerMessage => ({
  _id: 'id',
  channelId: 'ch',
  senderId: 'u',
  senderName: 'U',
  content: 'hi',
  isSystem: false,
  isDeleted: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const optimistic = (clientId: string, at: string): ChatMessage => ({
  ...server({ _id: '' as string, clientId, createdAt: at }),
  tempId: clientId,
  status: 'sending',
})

describe('sortMessages', () => {
  it('orders oldest → newest by createdAt', () => {
    const out = sortMessages([
      server({ _id: 'b', createdAt: '2026-01-01T00:00:02.000Z' }),
      server({ _id: 'a', createdAt: '2026-01-01T00:00:01.000Z' }),
      server({ _id: 'c', createdAt: '2026-01-01T00:00:03.000Z' }),
    ])
    expect(out.map((m) => m._id)).toEqual(['a', 'b', 'c'])
  })

  it('breaks same-millisecond ties by _id so order is stable', () => {
    const t = '2026-01-01T00:00:01.000Z'
    const out = sortMessages([
      server({ _id: 'zz', createdAt: t }),
      server({ _id: 'aa', createdAt: t }),
    ])
    expect(out.map((m) => m._id)).toEqual(['aa', 'zz'])
  })

  it('keeps an optimistic row (no _id) after a server row in the same millisecond', () => {
    const t = '2026-01-01T00:00:01.000Z'
    const out = sortMessages([optimistic('tmp', t), server({ _id: 'srv', createdAt: t })])
    expect(out.map((m) => m._id)).toEqual(['srv', ''])
  })
})

describe('mergeMessages', () => {
  it('retires the optimistic row and replaces it with the authoritative server copy — never both', () => {
    const current: ChatMessage[] = [
      server({ _id: 'p1', createdAt: '2026-01-01T00:00:00.000Z' }),
      optimistic('client-42', '2026-01-01T00:00:05.000Z'),
    ]

    // The server now returns the persisted version of the pending send.
    const merged = mergeMessages(current, [
      server({
        _id: 'srv-42',
        clientId: 'client-42',
        content: 'hello',
        createdAt: '2026-01-01T00:00:05.500Z',
      }),
    ])

    expect(merged).toHaveLength(2) // p1 + srv-42, the temp row is gone
    expect(merged.find((m) => m.tempId === 'client-42')).toBeUndefined()
    const srv = merged.find((m) => m._id === 'srv-42')
    expect(srv?.status).toBe('sent')
  })

  it('is idempotent: re-merging an already-present server row adds no duplicate', () => {
    const one = server({ _id: 's1', clientId: 'c1' })
    let current = mergeMessages([], [one])
    current = mergeMessages(current, [one])
    current = mergeMessages(current, [one])
    expect(current.filter((m) => m._id === 's1')).toHaveLength(1)
  })

  it('prepend (load-older) keeps current rows and adds older ones, re-sorted', () => {
    const current = [server({ _id: 'b', createdAt: '2026-01-01T00:00:02.000Z' })]
    const older = [
      server({ _id: 'a', createdAt: '2026-01-01T00:00:01.000Z' }),
      server({ _id: 'a0', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const merged = mergeMessages(current, older, 'prepend')
    expect(merged.map((m) => m._id)).toEqual(['a0', 'a', 'b'])
  })

  it('tail merge caps growth and keeps the most recent window', () => {
    let current: ChatMessage[] = []
    // Feed 600 distinct server rows one page at a time.
    for (let i = 0; i < 60; i += 1) {
      const page = Array.from({ length: 10 }, (_, j) => {
        const n = i * 10 + j
        return server({
          _id: String(n).padStart(4, '0'),
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
        })
      })
      current = mergeMessages(current, page, 'tail')
    }
    expect(current.length).toBeLessThanOrEqual(500)
    expect(current[current.length - 1]._id).toBe('0599')
  })
})

describe('newestTimestamp', () => {
  it('ignores optimistic (unpersisted) rows so a poll never asks for the future', () => {
    const msgs: ChatMessage[] = [
      server({ _id: 's1', createdAt: '2026-01-01T00:00:01.000Z' }),
      optimistic('tmp', '2026-01-01T00:00:09.000Z'), // not persisted yet
    ]
    expect(newestTimestamp(msgs)).toBe(Date.parse('2026-01-01T00:00:01.000Z'))
  })

  it('returns the max persisted createdAt', () => {
    const msgs: ChatMessage[] = [
      server({ _id: 's1', createdAt: '2026-01-01T00:00:01.000Z' }),
      server({ _id: 's2', createdAt: '2026-01-01T00:00:05.000Z' }),
    ]
    expect(newestTimestamp(msgs)).toBe(Date.parse('2026-01-01T00:00:05.000Z'))
  })
})
