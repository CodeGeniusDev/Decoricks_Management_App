/**
 * chat-service unit tests (Phase 7).
 *
 * The data-access layer is exercised against `helpers/mem-mongo`. The chat
 * idempotency index is compound in production ({ channelId, clientId }); the
 * in-memory fake only enforces single-field uniqueness, so we register
 * `clientId` as the unique field — enough to reproduce the duplicate-key (11000)
 * path that `sendIdempotent` catches and turns into a "return the existing row"
 * instead of a second insert.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ObjectId, type Db } from 'mongodb'
import { createMemDb, type MemDb } from './helpers/mem-mongo'
import {
  computeUnreadCounts,
  guardMessage,
  markChannelRead,
  resolveActiveChannel,
  sendIdempotent,
} from '@/lib/chat-service'
import type { Message } from '@/lib/models/Chat'

const CHANNEL = new ObjectId()
const OTHER_CHANNEL = new ObjectId()
const ME = new ObjectId()
const OTHER = new ObjectId()

let mem: MemDb
const db = (): Db => mem.handle as Db

beforeEach(() => {
  mem = createMemDb({ messages: ['clientId'], chatChannels: ['key'] })
})

describe('sendIdempotent', () => {
  const params = (clientId: string, content = 'hey <b>there</b>') => ({
    channelId: CHANNEL,
    senderId: ME,
    senderName: 'Me',
    content,
    clientId,
  })

  it('stores the sanitised plain text and reports a fresh create', async () => {
    const res = await sendIdempotent(db(), params('c1'))
    expect(res.created).toBe(true)
    expect(res.message.content).toBe('hey there') // tags stripped before storage
    expect(res.message._id).toBeInstanceOf(ObjectId)
  })

  it('a retry with the same clientId returns the original row and creates nothing new', async () => {
    const first = await sendIdempotent(db(), params('same'))
    const retry = await sendIdempotent(db(), params('same', 'DIFFERENT TEXT'))

    expect(retry.created).toBe(false)
    expect(String(retry.message._id)).toBe(String(first.message._id))
    // The persisted (first) content wins — a replay never overwrites or duplicates.
    expect(retry.message.content).toBe('hey there')
    expect(mem.collection('messages').docs).toHaveLength(1)
  })

  it('distinct clientIds are distinct messages', async () => {
    await sendIdempotent(db(), params('a'))
    await sendIdempotent(db(), params('b'))
    expect(mem.collection('messages').docs).toHaveLength(2)
  })
})

describe('computeUnreadCounts / markChannelRead', () => {
  const seedMessage = (over: Partial<Message>) => {
    mem.collection('messages').push({
      _id: new ObjectId(),
      channelId: CHANNEL,
      senderId: OTHER,
      content: 'x',
      isSystem: false,
      isDeleted: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ...over,
    })
  }

  it('counts only others’ non-deleted messages newer than the watermark', async () => {
    seedMessage({ createdAt: new Date('2026-01-01T00:00:00.000Z') }) // other → unread
    seedMessage({ senderId: ME, createdAt: new Date('2026-01-01T00:01:00.000Z') }) // mine → ignored
    seedMessage({ isDeleted: true, createdAt: new Date('2026-01-01T00:02:00.000Z') }) // deleted → ignored
    seedMessage({ createdAt: new Date('2026-01-02T00:00:00.000Z') }) // other → unread

    // No read record yet → zero watermark → whole backlog counts.
    const counts = await computeUnreadCounts(db(), ME, [CHANNEL, OTHER_CHANNEL])
    expect(counts[CHANNEL.toString()]).toBe(2)
    expect(counts[OTHER_CHANNEL.toString()]).toBe(0)
  })

  it('advancing the watermark clears the unread count', async () => {
    seedMessage({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
    await markChannelRead(db(), ME, CHANNEL, new Date('2026-01-05T00:00:00.000Z'))

    const counts = await computeUnreadCounts(db(), ME, [CHANNEL])
    expect(counts[CHANNEL.toString()]).toBe(0)
  })

  it('a watermark older than some messages leaves those as unread', async () => {
    seedMessage({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
    seedMessage({ createdAt: new Date('2026-01-03T00:00:00.000Z') })
    await markChannelRead(db(), ME, CHANNEL, new Date('2026-01-02T00:00:00.000Z'))

    const counts = await computeUnreadCounts(db(), ME, [CHANNEL])
    expect(counts[CHANNEL.toString()]).toBe(1) // only the 01-03 message
  })

  it('returns {} for an empty channel list (no needless queries)', async () => {
    expect(await computeUnreadCounts(db(), ME, [])).toEqual({})
  })
})

describe('resolveActiveChannel', () => {
  const channel = (over: Record<string, unknown>) => {
    const _id = (over._id as ObjectId) ?? new ObjectId()
    mem.collection('chatChannels').push({
      _id,
      key: `k-${_id.toString().slice(-4)}`,
      name: 'Room',
      isArchived: false,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    })
    return _id
  }

  it('returns an active channel and null for archived or missing ones', async () => {
    const active = channel({})
    const archived = channel({ isArchived: true })
    const ghost = new ObjectId()

    expect(await resolveActiveChannel(db(), active)).not.toBeNull()
    expect(await resolveActiveChannel(db(), archived)).toBeNull()
    expect(await resolveActiveChannel(db(), ghost)).toBeNull()
  })
})

describe('guardMessage', () => {
  const message = (over: Partial<Message> = {}): Message & { _id: ObjectId } => ({
    _id: new ObjectId(),
    channelId: CHANNEL,
    senderId: ME,
    content: 'x',
    isSystem: false,
    isDeleted: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  })

  const T10 = new Date('2026-01-01T00:10:00.000Z') // inside a 15-min window
  const T60 = new Date('2026-01-01T01:00:00.000Z') // outside it

  it('a soft-deleted message is immutable (410), even for a moderator', () => {
    const gate = guardMessage(message({ isDeleted: true }), ME, true, 15, T10)
    expect(gate).toMatchObject({ ok: false, status: 410, code: 'MESSAGE_DELETED' })
  })

  it('a moderator may act on any message at any time', () => {
    const gate = guardMessage(message(), OTHER, true, 15, T60)
    expect(gate).toEqual({ ok: true })
  })

  it('a non-author without moderation is forbidden (403)', () => {
    const gate = guardMessage(message(), OTHER, false, 15, T10)
    expect(gate).toMatchObject({ ok: false, status: 403, code: 'FORBIDDEN' })
  })

  it('the author inside the window is allowed', () => {
    expect(guardMessage(message(), ME, false, 15, T10)).toEqual({ ok: true })
  })

  it('the author after the window closes is rejected (403 MESSAGE_WINDOW_CLOSED)', () => {
    const gate = guardMessage(message(), ME, false, 15, T60)
    expect(gate).toMatchObject({ ok: false, status: 403, code: 'MESSAGE_WINDOW_CLOSED' })
  })
})
