/**
 * Phase 3 collaboration API tests — mentions, record references, archiving.
 *
 * These run the REAL handlers against `helpers/mem-mongo`, because the brief's
 * acceptance criteria are backend claims, not rendering claims. What is locked
 * here:
 *
 *   • mentions are derived SERVER-SIDE from the stored text against the active
 *     `chat.view` directory, so a deactivated or chat-less name produces neither
 *     a stored mention nor a notification, and a retried `clientId` produces
 *     neither a second message nor a second alert;
 *   • the notification carries a deep link to the conversation and never the
 *     message body;
 *   • record-reference SEARCH is gated by the caller's own module grants — a
 *     module the viewer cannot view is not queried at all, and no amount field
 *     ever leaves the server;
 *   • a reference id that does not exist, or that the sender may not open, is
 *     dropped rather than stored;
 *   • chips are resolved PER VIEWER on read: `hidden` for a record the reader
 *     cannot access, `unavailable` for one that has since been deleted;
 *   • archiving is conversation-wide and non-destructive: the room leaves the
 *     active list, keeps every message, refuses new posts, is readable only by a
 *     Founder through `?archived=true`, and restore puts it back with
 *     `archivedAt` cleared.
 *
 * `authorize`/`requireFounder` are permissive in `src/test/setup.ts`; each test
 * re-arms them with the identity it needs, including the ROLE DOCUMENT, because
 * `viewableModules()` reads grants from `auth.role` — a permissive auth result
 * with empty permissions is exactly the "no referenceable modules" case.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { ObjectId } from 'mongodb'
import {
  authorize,
  requireFounder,
  invalidateRoleCache,
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
import * as channelsRoute from '@/app/api/chat/channels/route'
import * as channelDetailRoute from '@/app/api/chat/channels/[id]/route'
import * as referencesRoute from '@/app/api/chat/references/route'
import * as membersRoute from '@/app/api/chat/members/route'

/* --------------------------------- people --------------------------------- */

const FOUNDER = new ObjectId('507f1f77bcf86cd799439011')
const AFNAN = new ObjectId('507f1f77bcf86cd7994390aa')
const HASNAT = new ObjectId('507f1f77bcf86cd7994390bb') // deactivated
const ALI = new ObjectId('507f1f77bcf86cd7994390cc') // role without chat.view

const ALL_VIEW = {
  chat: { view: true },
  sales: { view: true },
  tasks: { view: true },
  inventory: { view: true },
  budget: { view: true },
  finance: { view: true },
  suppliers: { view: true },
}

/** Chat only: the references a Partner may attach is the point of this role. */
const CHAT_ONLY = { chat: { view: true } }

/* ------------------------------- fixtures --------------------------------- */

const ctx = (userId: ObjectId, role: 'founder' | 'partner_afnan' | 'partner_ali') => ({
  user: {
    _id: userId,
    email: `${userId.toString()}@decoricks.com`,
    name: role === 'founder' ? 'Founder' : 'Afnan',
    role,
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 1,
  },
  session: { tokenHash: 'h', sessionVersion: 1, csrfToken: 'c', role },
  role: {
    name: role,
    displayName: role,
    permissions: role === 'founder' ? ALL_VIEW : CHAT_ONLY,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  permissions: {},
})

const asFounder = () => {
  ;(authorize as Mock).mockReset().mockImplementation(async () => ctx(FOUNDER, 'founder'))
  ;(requireFounder as Mock).mockReset().mockImplementation(async () => ctx(FOUNDER, 'founder'))
}

const asChatOnlyPartner = () => {
  ;(authorize as Mock).mockReset().mockImplementation(async () => ctx(AFNAN, 'partner_afnan'))
  ;(requireFounder as Mock).mockReset().mockRejectedValue(new AuthorizationError('chat', 'view'))
}

/* ------------------------------ request kit ------------------------------- */

const makeRequest = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init) as never
const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const messagesCtx = () => ({ params: Promise.resolve({ id: channelId.toString() }) }) as never
const channelCtx = (id = channelId.toString()) => ({ params: Promise.resolve({ id }) }) as never

/** Typed view of the two collections this suite reads back after a write. */
interface StoredMessage {
  content: string
  clientId: string
  mentions?: { userId: ObjectId; name: string }[]
  references?: { entityType: string; entityId: ObjectId }[]
}
interface AlertRow {
  userId: ObjectId
  type: string
  dedupeKey: string
  data: { link?: string }
}

const seedChannel = (over: Record<string, unknown> = {}): ObjectId => {
  const _id = (over._id as ObjectId) ?? new ObjectId()
  mem.collection('chatChannels').push({
    _id,
    key: `room-${_id.toString().slice(-4)}`,
    name: 'General',
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  })
  return _id
}

const send = async (body: Record<string, unknown>) => {
  const res = await messagesRoute.POST(
    makeRequest(`/api/chat/channels/${channelId}/messages`, json(body)),
    messagesCtx()
  )
  return { status: res.status, body: await res.json() }
}

const readMessages = (query = 'limit=50') =>
  messagesRoute.GET(makeRequest(`/api/chat/channels/${channelId}/messages?${query}`), messagesCtx())

const storedMessage = (): StoredMessage =>
  mem.collection('messages').docs[0] as unknown as StoredMessage
const storedMessages = () => mem.collection('messages').docs as unknown as StoredMessage[]
const notifications = () => mem.collection('notifications').docs as unknown as AlertRow[]

/** The seed the reference registry can actually find, with a sensitive field
 *  that must never appear in a search result or a chip. */
const seedOrder = (over: Record<string, unknown> = {}): ObjectId => {
  const _id = (over._id as ObjectId) ?? new ObjectId()
  mem.collection('orders').push({
    _id,
    orderNumber: 'ORD-1042',
    customerName: 'Alina Shah',
    orderStatus: 'in_progress',
    totalAmount: 7500000,
    customerPhone: '0300-0000000',
    ...over,
  })
  return _id
}

beforeEach(() => {
  mem = createMemDb({ chatChannels: ['key'], messages: ['clientId'] })
  channelId = seedChannel()

  // `getRoles()` caches for 2s across the whole process; without this the roles
  // seeded by the first test would answer for every test after it.
  invalidateRoleCache()
  mem.collection('roles').reset([
    { _id: new ObjectId(), name: 'founder', displayName: 'Founder', permissions: ALL_VIEW },
    { _id: new ObjectId(), name: 'partner_afnan', displayName: 'Afnan', permissions: CHAT_ONLY },
    {
      _id: new ObjectId(),
      name: 'viewer',
      displayName: 'Viewer',
      permissions: { sales: { view: true } },
    },
  ])
  mem.collection('users').reset([
    { _id: FOUNDER, name: 'Founder', email: 'f@d.com', role: 'founder', isActive: true },
    { _id: AFNAN, name: 'Afnan Ali', email: 'a@d.com', role: 'partner_afnan', isActive: true },
    { _id: HASNAT, name: 'Hasnat Ali', email: 'h@d.com', role: 'founder', isActive: false },
    { _id: ALI, name: 'Ali Raza', email: 'al@d.com', role: 'viewer', isActive: true },
  ])
  asFounder()
})

/* -------------------------------- mentions -------------------------------- */

describe('Phase 3 mentions', () => {
  it('stores a structured mention with a real user id and notifies that user', async () => {
    const { status, body } = await send({
      content: '@Afnan Ali please review ORD-1042',
      clientId: 'cid-mention-1',
    })

    expect(status).toBe(201)
    expect(body.data.mentions).toEqual([{ userId: AFNAN.toString(), name: 'Afnan Ali' }])

    const stored = storedMessage()
    expect(stored.mentions).toHaveLength(1)
    // Structured, not textual: what is persisted is an ObjectId, not a name.
    expect(stored.mentions![0].userId).toBeInstanceOf(ObjectId)
    expect(stored.mentions![0].userId.toString()).toBe(AFNAN.toString())

    const alerts = notifications()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].userId.toString()).toBe(AFNAN.toString())
    expect(alerts[0].type).toBe('mention')
    // The alert links to the conversation and quotes no message content.
    expect(alerts[0].data.link).toBe(`/chat?channel=${channelId.toString()}`)
    expect(JSON.stringify(alerts[0])).not.toContain('ORD-1042')
  })

  it('a name that is not a mentionable member produces no mention and no alert', async () => {
    // `Hasnat` is deactivated and `Ali Raza` holds no chat.view grant, so neither
    // is in the directory at all; the text still stores, minus the mention.
    const { status, body } = await send({
      content: '@Hasnat Ali and @Ali Raza and @Nobody',
      clientId: 'cid-mention-2',
    })

    expect(status).toBe(201)
    expect(body.data.mentions ?? []).toEqual([])
    expect(notifications()).toHaveLength(0)
  })

  it('never alerts the sender about their own typing, but keeps the mention', async () => {
    ;(authorize as Mock).mockImplementation(async () => ctx(FOUNDER, 'founder'))
    const { body } = await send({ content: 'looping in @Founder now', clientId: 'cid-mention-3' })

    expect(body.data.mentions).toHaveLength(1)
    expect(notifications()).toHaveLength(0)
  })

  it('a retried clientId replays the original row: one message, one alert', async () => {
    const first = await send({ content: '@Afnan Ali ping', clientId: 'cid-dupe' })
    expect(first.status).toBe(201)
    const retry = await send({ content: '@Afnan Ali ping', clientId: 'cid-dupe' })

    expect(retry.status).toBe(200)
    expect(retry.body.data._id).toBe(first.body.data._id)
    expect(storedMessages()).toHaveLength(1)
    expect(notifications()).toHaveLength(1)
  })

  it('GET /api/chat/members exposes ids and names only — no email, no role', async () => {
    const res = await membersRoute.GET(makeRequest('/api/chat/members'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toEqual([
      { id: FOUNDER.toString(), name: 'Founder' },
      { id: AFNAN.toString(), name: 'Afnan Ali' },
    ])
    expect(JSON.stringify(body.data)).not.toContain('@d.com')
  })
})

/* ------------------------------- references ------------------------------- */

describe('Phase 3 record references', () => {
  it('searches real records and links to the detail page, with no sensitive value', async () => {
    const orderId = seedOrder()
    const res = await referencesRoute.GET(makeRequest('/api/chat/references?q=ORD-10'))
    const body = await res.json()

    expect(res.status).toBe(200)
    const hit = body.data.results.find((r: { entityType: string }) => r.entityType === 'order')
    expect(hit).toBeTruthy()
    expect(hit.entityId).toBe(orderId.toString())
    expect(hit.label).toBe('ORD-1042')
    expect(hit.href).toBe(`/sales/${orderId.toString()}`)
    // Money and phone live on the order; a picker preview must not carry them.
    const serialized = JSON.stringify(body.data)
    expect(serialized).not.toContain('7500000')
    expect(serialized).not.toContain('0300-0000000')
  })

  it('does not query, and does not offer, a module the caller cannot view', async () => {
    asChatOnlyPartner()
    const res = await referencesRoute.GET(makeRequest('/api/chat/references?q=ORD-10'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.results).toEqual([])
    expect(body.data.types.map((t: { entityType: string }) => t.entityType)).toEqual([])
  })

  it('stores an authorised reference as an id, and renders it as a live chip', async () => {
    const orderId = seedOrder()
    const { body } = await send({
      content: 'see this one',
      clientId: 'cid-ref-1',
      references: [{ entityType: 'order', entityId: orderId.toString() }],
    })

    expect(body.data.references).toEqual([
      {
        state: 'available',
        entityType: 'order',
        entityId: orderId.toString(),
        label: 'ORD-1042',
        meta: 'Alina Shah · in_progress',
        href: `/sales/${orderId.toString()}`,
      },
    ])
    // What is persisted is the pointer, not the copied-out label.
    const stored = storedMessage()
    expect(stored.references![0].entityId).toBeInstanceOf(ObjectId)
    expect(JSON.stringify(stored.references)).not.toContain('ORD-1042')
  })

  it('the chip follows the record: a renamed order shows its NEW name', async () => {
    const orderId = seedOrder()
    await send({
      content: 'look',
      clientId: 'cid-ref-rename',
      references: [{ entityType: 'order', entityId: orderId.toString() }],
    })
    mem.collection('orders').updateOne({ _id: orderId }, { $set: { orderNumber: 'ORD-9999' } })

    const res = await readMessages()
    const body = await res.json()
    expect(body.data[0].references[0].label).toBe('ORD-9999')
  })

  it('drops a reference the sender may not attach, or that points at nothing', async () => {
    const orderId = seedOrder()
    asChatOnlyPartner()
    const ghost = new ObjectId()
    const { status, body } = await send({
      content: 'two dead links',
      clientId: 'cid-ref-bad',
      references: [
        { entityType: 'order', entityId: orderId.toString() }, // not viewable by this role
        { entityType: 'task', entityId: ghost.toString() }, // does not exist
      ],
    })

    expect(status).toBe(201)
    expect(body.data.references).toEqual([])
    // The row simply has no `references` field, which is what keeps a plain
    // message byte-identical to its pre-Phase-3 shape.
    expect(storedMessage().references ?? []).toEqual([])
  })

  it('renders per viewer: hidden for an inaccessible record, unavailable once deleted', async () => {
    const orderId = seedOrder()
    await send({
      content: 'shared context',
      clientId: 'cid-ref-mixed',
      references: [{ entityType: 'order', entityId: orderId.toString() }],
    })

    // A partner without sales.view sees an inert chip and learns nothing about it.
    asChatOnlyPartner()
    const masked = await readMessages()
    const maskedBody = await masked.json()
    expect(maskedBody.data[0].references).toEqual([
      { state: 'hidden', entityType: 'order', entityId: orderId.toString() },
    ])

    // The record disappearing is a different answer, and neither one is a dead link.
    asFounder()
    mem.collection('orders').deleteOne({ _id: orderId })
    const gone = await readMessages()
    const goneBody = await gone.json()
    expect(goneBody.data[0].references).toEqual([
      { state: 'unavailable', entityType: 'order', entityId: orderId.toString() },
    ])
  })
})

/* --------------------------------- archive -------------------------------- */

describe('Phase 3 archiving', () => {
  const archive = async (isArchived: boolean) => {
    const res = await channelDetailRoute.PATCH(
      makeRequest(`/api/chat/channels/${channelId}`, json({ isArchived })),
      channelCtx()
    )
    return { status: res.status, body: await res.json() }
  }

  it('archive stamps archivedAt, hides the room from the list and preserves messages', async () => {
    await send({ content: 'first', clientId: 'cid-arch-1' })
    await send({ content: 'second', clientId: 'cid-arch-2' })

    const { status, body } = await archive(true)
    expect(status).toBe(200)
    expect(body.data.isArchived).toBe(true)
    expect(body.data.archivedAt).toBeTruthy()

    const list = await channelsRoute.GET(makeRequest('/api/chat/channels'))
    expect((await list.json()).data).toEqual([])

    const archived = await channelsRoute.GET(makeRequest('/api/chat/channels?archived=true'))
    const archivedBody = await archived.json()
    expect(archivedBody.data).toHaveLength(1)
    expect(archivedBody.data[0].messageCount).toBe(2)
    expect(storedMessages()).toHaveLength(2)
  })

  it('the archived list is Founder-only, and the audit trail separates the actions', async () => {
    await archive(true)
    const auditActions = mem.collection('auditLog').docs.map((d) => d.action)
    expect(auditActions).toContain('chat_channel_archived')

    asChatOnlyPartner()
    const res = await channelsRoute.GET(makeRequest('/api/chat/channels?archived=true'))
    expect(res.status).toBe(403)
  })

  it('an archived room is unreadable on the normal path and unpostable, but readable archived', async () => {
    await send({ content: 'history stays', clientId: 'cid-arch-3' })
    await archive(true)

    const normal = await messagesRoute.GET(
      makeRequest(`/api/chat/channels/${channelId}/messages?limit=50`),
      messagesCtx()
    )
    expect(normal.status).toBe(404)

    const post = await send({ content: 'try me', clientId: 'cid-arch-4' })
    expect(post.status).toBe(404)
    expect(storedMessages()).toHaveLength(1)

    const read = await readMessages('limit=50&archived=true')
    expect(read.status).toBe(200)
    const readBody = await read.json()
    expect(readBody.data).toHaveLength(1)
    expect(readBody.data[0].content).toBe('history stays')
  })

  it('restore returns the room with its history and clears archivedAt', async () => {
    await send({ content: 'before', clientId: 'cid-arch-5' })
    await archive(true)
    const { status, body } = await archive(false)

    expect(status).toBe(200)
    expect(body.data.isArchived).toBe(false)
    expect(body.data.archivedAt).toBeNull()

    const list = await channelsRoute.GET(makeRequest('/api/chat/channels'))
    const listBody = await list.json()
    expect(listBody.data).toHaveLength(1)
    expect(listBody.data[0]._id).toBe(channelId.toString())

    const history = await readMessages()
    expect((await history.json()).data).toHaveLength(1)

    const actions = mem.collection('auditLog').docs.map((d) => d.action)
    expect(actions).toContain('chat_channel_restored')

    // Two more archive requests: the first genuinely re-closes the room, the
    // second is a no-op. The audit log must record the transition, not the
    // request — so exactly one new `archived` line, never two.
    const archivedSoFar = actions.filter((a) => a === 'chat_channel_archived').length
    await archive(true)
    await archive(true)
    const after = mem.collection('auditLog').docs.map((d) => d.action)
    expect(after.filter((a) => a === 'chat_channel_archived')).toHaveLength(archivedSoFar + 1)
    expect(after.filter((a) => a === 'chat_channel_updated')).toHaveLength(1)
  })
})
