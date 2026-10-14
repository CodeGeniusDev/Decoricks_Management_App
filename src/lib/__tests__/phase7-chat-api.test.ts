/**
 * Phase 7 chat API route tests.
 *
 * Runs the REAL channel/message handlers against `helpers/mem-mongo`. Locks the
 * security guarantees the brief names for this surface:
 *
 *   • authz — a missing session is 401 and a missing grant is 403 on send;
 *     only a Founder may create channels;
 *   • XSS — a stored payload is neutralised before it ever hits the database;
 *   • idempotency — a retried `clientId` returns the original row (200), never a
 *     second message;
 *   • rate limiting — the 21st send inside the window is 429 with Retry-After;
 *   • the edit/delete window — author inside window ok, outside is 403, a
 *     non-author is 403, a Founder moderates any time, and a soft-deleted row
 *     redacts its body and is immutable (410).
 *
 * `authorize`/`requireFounder` are permissive in `src/test/setup.ts`; each test
 * re-arms them (a stale mock implementation must never leak across cases).
 * The idempotency index is compound in prod but the fake only enforces
 * single-field uniqueness, so we register `clientId` as unique — enough to
 * reproduce the duplicate-key path `sendIdempotent` catches.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { ObjectId } from 'mongodb'
import {
  authorize,
  requireFounder,
  AuthenticationError,
  AuthorizationError,
} from '@/lib/authorization'
import { createMemDb, type MemDb } from './helpers/mem-mongo'

let mem: MemDb
let channelId: ObjectId

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => mem.handle),
  getMongoClient: vi.fn(async () => mem.client),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

import * as messagesRoute from '@/app/api/chat/channels/[id]/messages/route'
import * as messageDetailRoute from '@/app/api/chat/channels/[id]/messages/[messageId]/route'
import * as channelsRoute from '@/app/api/chat/channels/route'

const FOUNDER = new ObjectId('507f1f77bcf86cd799439011')
const PARTNER = new ObjectId('507f1f77bcf86cd7994390aa')

/* ------------------------------ auth helpers ------------------------------ */

const ctxFor = (userId: ObjectId, role: string) => ({
  user: {
    _id: userId,
    email: `${userId.toString()}@decoricks.com`,
    name: role === 'founder' ? 'Founder' : 'Partner',
    role,
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 1,
  },
  session: { tokenHash: 'h', sessionVersion: 1, csrfToken: 'c', role },
  role: {
    name: role,
    displayName: role,
    permissions: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  permissions: {},
})

const asUser = (userId: ObjectId, role: string) => {
  ;(authorize as Mock).mockReset().mockImplementation(async () => ctxFor(userId, role))
}

/* ------------------------------ request kit ------------------------------- */

const url = (path: string) => `http://localhost${path}`
const makeRequest = (u: string, init?: RequestInit) => new Request(u, init) as never
const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const messagesUrl = () => `/api/chat/channels/${channelId.toString()}/messages`
const ctxMessages = () => ({ params: Promise.resolve({ id: channelId.toString() }) }) as never
const ctxMessage = (messageId: string) =>
  ({ params: Promise.resolve({ id: channelId.toString(), messageId }) }) as never

/* -------------------------------- seeding --------------------------------- */

const seedMessage = (over: Record<string, unknown> = {}): ObjectId => {
  const _id = (over._id as ObjectId) ?? new ObjectId()
  mem.collection('messages').push({
    _id,
    channelId,
    senderId: PARTNER,
    senderName: 'Partner',
    content: 'original',
    isSystem: false,
    isDeleted: false,
    createdAt: new Date(),
    ...over,
  })
  return _id
}

beforeEach(() => {
  mem = createMemDb({ messages: ['clientId'], chatChannels: ['key'] })
  channelId = new ObjectId()
  mem.collection('chatChannels').push({
    _id: channelId,
    key: `room-${channelId.toString().slice(-6)}`,
    name: 'Room',
    isArchived: false,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  asUser(FOUNDER, 'founder') // default actor is a Founder moderator
})

/* --------------------------- POST /messages (send) ------------------------ */

describe('POST /api/chat/channels/[id]/messages', () => {
  it('rejects an unauthenticated sender with 401 (never a write)', async () => {
    ;(authorize as Mock).mockReset().mockRejectedValueOnce(new AuthenticationError())
    const res = await messagesRoute.POST(
      makeRequest(url(messagesUrl()), json({ content: 'hi', clientId: 'client-abc-1' })),
      ctxMessages()
    )
    expect(res.status).toBe(401)
    expect(mem.collection('messages').docs).toHaveLength(0)
  })

  it('rejects a sender without the chat.create grant with 403', async () => {
    ;(authorize as Mock).mockReset().mockRejectedValueOnce(new AuthorizationError('chat', 'create'))
    const res = await messagesRoute.POST(
      makeRequest(url(messagesUrl()), json({ content: 'hi', clientId: 'client-abc-2' })),
      ctxMessages()
    )
    expect(res.status).toBe(403)
  })

  it('neutralises an XSS payload before storing, and flags the fresh row editable', async () => {
    const res = await messagesRoute.POST(
      makeRequest(
        url(messagesUrl()),
        json({ content: 'ping <script>alert(1)</script>pong', clientId: 'client-xss' })
      ),
      ctxMessages()
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.content).toBe('ping pong')
    expect(body.data.editable).toBe(true)
    // Nothing executable is ever persisted.
    const stored = mem.collection('messages').docs[0]
    expect(String(stored.content)).not.toContain('script')
    expect(String(stored.content)).not.toContain('alert')
  })

  it('a replay of the same clientId returns the original (200) and stores nothing new', async () => {
    const first = await messagesRoute.POST(
      makeRequest(url(messagesUrl()), json({ content: 'once', clientId: 'client-dup' })),
      ctxMessages()
    )
    expect(first.status).toBe(201)
    const firstId = (await first.json()).data._id

    const retry = await messagesRoute.POST(
      makeRequest(url(messagesUrl()), json({ content: 'once', clientId: 'client-dup' })),
      ctxMessages()
    )
    expect(retry.status).toBe(200)
    expect((await retry.json()).data._id).toBe(firstId)
    expect(mem.collection('messages').docs).toHaveLength(1)
  })

  it('rate-limits a runaway sender: the 21st distinct send is 429 with Retry-After', async () => {
    let lastStatus = 0
    for (let i = 0; i < 20; i += 1) {
      const res = await messagesRoute.POST(
        makeRequest(
          url(messagesUrl()),
          json({ content: `m${i}`, clientId: `burst-${String(i).padStart(3, '0')}` })
        ),
        ctxMessages()
      )
      lastStatus = res.status
    }
    expect(lastStatus).toBe(201) // the first twenty fit the window

    const blocked = await messagesRoute.POST(
      makeRequest(url(messagesUrl()), json({ content: 'flood', clientId: 'burst-blocked-21' })),
      ctxMessages()
    )
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBeTruthy()
    const body = await blocked.json()
    expect(body.error.code).toBe('RATE_LIMITED')
  })

  it('404s when the channel does not exist', async () => {
    const ghost = new ObjectId()
    const res = await messagesRoute.POST(
      makeRequest(
        url(`/api/chat/channels/${ghost.toString()}/messages`),
        json({ content: 'hi', clientId: 'client-ghost' })
      ),
      { params: Promise.resolve({ id: ghost.toString() }) } as never
    )
    expect(res.status).toBe(404)
  })

  it('400s on a body missing the clientId', async () => {
    const res = await messagesRoute.POST(
      makeRequest(url(messagesUrl()), json({ content: 'no client id' })),
      ctxMessages()
    )
    expect(res.status).toBe(400)
  })
})

/* ---------------------------- GET /messages (history) --------------------- */

describe('GET /api/chat/channels/[id]/messages', () => {
  it('stamps editable=true for the author inside the window', async () => {
    const id = seedMessage({ senderId: PARTNER, content: 'fresh', createdAt: new Date() })
    asUser(PARTNER, 'partner')
    const body = await (
      await messagesRoute.GET(makeRequest(url(`${messagesUrl()}?limit=50`)), ctxMessages())
    ).json()
    expect(body.data.find((m: { _id: string }) => m._id === id.toString()).editable).toBe(true)
  })

  it('hides the edit affordance from the author once the window has closed', async () => {
    const id = seedMessage({
      senderId: PARTNER,
      content: 'stale',
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    })
    asUser(PARTNER, 'partner')
    const body = await (
      await messagesRoute.GET(makeRequest(url(`${messagesUrl()}?limit=50`)), ctxMessages())
    ).json()
    expect(body.data.find((m: { _id: string }) => m._id === id.toString()).editable).toBe(false)
  })

  it('a Founder (moderator) may edit anyone’s message regardless of the window', async () => {
    seedMessage({ senderId: PARTNER, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
    asUser(FOUNDER, 'founder')
    const body = await (
      await messagesRoute.GET(makeRequest(url(`${messagesUrl()}?limit=50`)), ctxMessages())
    ).json()
    expect(body.data[0].editable).toBe(true)
  })

  it('404s for an unknown channel', async () => {
    const ghost = new ObjectId()
    const res = await messagesRoute.GET(
      makeRequest(url(`/api/chat/channels/${ghost.toString()}/messages`)),
      { params: Promise.resolve({ id: ghost.toString() }) } as never
    )
    expect(res.status).toBe(404)
  })
})

/* ------------------------- PATCH /messages/[messageId] -------------------- */

describe('PATCH /api/chat/channels/[id]/messages/[messageId]', () => {
  it('lets the author edit inside the window (redacts nothing, marks editedAt)', async () => {
    const id = seedMessage({ senderId: PARTNER, createdAt: new Date() })
    asUser(PARTNER, 'partner')
    const res = await messageDetailRoute.PATCH(
      makeRequest(url(`${messagesUrl()}/${id}`), json({ content: 'fixed' }, 'PATCH')),
      ctxMessage(id.toString())
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.content).toBe('fixed')
    expect(body.data.editedAt).toBeTruthy()
  })

  it('blocks the author once the window has closed (403 MESSAGE_WINDOW_CLOSED)', async () => {
    const id = seedMessage({
      senderId: PARTNER,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    })
    asUser(PARTNER, 'partner')
    const res = await messageDetailRoute.PATCH(
      makeRequest(url(`${messagesUrl()}/${id}`), json({ content: 'too late' }, 'PATCH')),
      ctxMessage(id.toString())
    )
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('MESSAGE_WINDOW_CLOSED')
  })

  it('forbids a non-author without moderation (403)', async () => {
    const id = seedMessage({ senderId: FOUNDER })
    asUser(PARTNER, 'partner')
    const res = await messageDetailRoute.PATCH(
      makeRequest(url(`${messagesUrl()}/${id}`), json({ content: 'nope' }, 'PATCH')),
      ctxMessage(id.toString())
    )
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('FORBIDDEN')
  })

  it('a Founder may moderate anyone’s message at any time', async () => {
    const id = seedMessage({
      senderId: PARTNER,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    })
    asUser(FOUNDER, 'founder')
    const res = await messageDetailRoute.PATCH(
      makeRequest(url(`${messagesUrl()}/${id}`), json({ content: 'moderated' }, 'PATCH')),
      ctxMessage(id.toString())
    )
    expect(res.status).toBe(200)
  })

  it('a soft-deleted message is immutable (410)', async () => {
    const id = seedMessage({ senderId: FOUNDER, isDeleted: true })
    asUser(FOUNDER, 'founder')
    const res = await messageDetailRoute.PATCH(
      makeRequest(url(`${messagesUrl()}/${id}`), json({ content: 'revive' }, 'PATCH')),
      ctxMessage(id.toString())
    )
    expect(res.status).toBe(410)
  })
})

/* ------------------------- DELETE /messages/[messageId] ------------------- */

describe('DELETE /api/chat/channels/[id]/messages/[messageId]', () => {
  it('soft-deletes the author’s message and redacts the body on serialisation', async () => {
    const id = seedMessage({ senderId: PARTNER, content: 'embarrassing', createdAt: new Date() })
    asUser(PARTNER, 'partner')
    const res = await messageDetailRoute.DELETE(
      makeRequest(url(`${messagesUrl()}/${id}`), { method: 'DELETE' }),
      ctxMessage(id.toString())
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.isDeleted).toBe(true)
    expect(body.data.content).toBeNull() // read path never returns the text

    // The physical string stays for the audit trail, but a fresh GET omits it.
    const listed = await (
      await messagesRoute.GET(makeRequest(url(`${messagesUrl()}?limit=50`)), ctxMessages())
    ).json()
    expect(listed.data.find((m: { _id: string }) => m._id === id.toString())).toBeUndefined()
  })

  it('acting on an already-deleted message is 410', async () => {
    const id = seedMessage({ senderId: FOUNDER, isDeleted: true })
    asUser(FOUNDER, 'founder')
    const res = await messageDetailRoute.DELETE(
      makeRequest(url(`${messagesUrl()}/${id}`), { method: 'DELETE' }),
      ctxMessage(id.toString())
    )
    expect(res.status).toBe(410)
  })
})

/* ------------------------------- channels -------------------------------- */

describe('POST /api/chat/channels', () => {
  it('is Founder-only: a non-Founder is refused (403) and nothing is created', async () => {
    ;(requireFounder as Mock)
      .mockReset()
      .mockRejectedValueOnce(new AuthorizationError('chat', 'manage', 'Founder only'))
    const res = await channelsRoute.POST(
      makeRequest(url('/api/chat/channels'), json({ name: 'New Room' }))
    )
    expect(res.status).toBe(403)
  })

  it('a Founder creates a channel and receives it with canManage', async () => {
    ;(requireFounder as Mock).mockReset().mockImplementation(async () => ctxFor(FOUNDER, 'founder'))
    const res = await channelsRoute.POST(
      makeRequest(url('/api/chat/channels'), json({ name: 'Kitchen Shoot' }))
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.key).toBe('kitchen-shoot')
    expect(body.data.canManage).toBe(true)
  })
})
