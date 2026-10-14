import { ObjectId, type Db } from 'mongodb'
import {
  getChannelCollection,
  getChannelReadCollection,
  getMessageCollection,
  type ChatChannel,
  type Message,
} from '@/lib/models/Chat'
import { commentWithinEditWindow } from '@/lib/business-policy'
import { sanitizeMessageText } from '@/lib/sanitize'
import { getKarachiDate } from '@/lib/date'

/**
 * Chat data-access shared by every channel/message route.
 *
 * Kept out of the route handlers so the tricky bits — idempotent insert, the
 * author/moderator edit-window decision, and unread counting — are one place
 * with direct unit coverage rather than copied per handler.
 */

export function isDuplicateKeyError(err: unknown): boolean {
  const code = (err as { code?: number })?.code
  if (code === 11000) return true
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /E11000|duplicate key/i.test(message)
}

/** Loads a channel by id, only if it exists and is not archived. */
export async function resolveActiveChannel(
  db: Db,
  channelId: ObjectId
): Promise<(ChatChannel & { _id: ObjectId }) | null> {
  const channel = await getChannelCollection(db).findOne({
    _id: channelId,
  } as never)
  if (!channel || channel.isArchived) return null
  return channel as ChatChannel & { _id: ObjectId }
}

export interface SendParams {
  channelId: ObjectId
  senderId: ObjectId
  senderName: string
  content: string
  clientId: string
}

export interface SendResult {
  message: Message & { _id: ObjectId }
  /** false when the unique index revealed a prior insert with the same clientId. */
  created: boolean
}

/**
 * Idempotent, sanitised message insert.
 *
 * The client generates `clientId` once per user intention and reuses it on
 * retry. A second insert with the same `{ channelId, clientId }` hits the
 * unique index; we then return the already-persisted document with
 * `created: false` so the caller replies 200 instead of creating a duplicate.
 * Content is sanitised to plain text before it is ever stored.
 */
export async function sendIdempotent(db: Db, params: SendParams): Promise<SendResult> {
  const col = getMessageCollection(db)
  const clean = sanitizeMessageText(params.content)

  const doc: Message = {
    channelId: params.channelId,
    senderId: params.senderId,
    senderName: params.senderName,
    content: clean,
    isSystem: false,
    clientId: params.clientId,
    isDeleted: false,
    createdAt: getKarachiDate(),
  }

  try {
    const result = await col.insertOne(doc as never)
    return {
      message: { ...doc, _id: result.insertedId } as Message & { _id: ObjectId },
      created: true,
    }
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const existing = (await col.findOne({
        channelId: params.channelId,
        clientId: params.clientId,
      } as never)) as (Message & { _id: ObjectId }) | null
      if (existing) return { message: existing, created: false }
    }
    throw error
  }
}

/* --------------------------- edit / delete guard --------------------------- */

export type Guard = { ok: true } | { ok: false; status: number; code: string; message: string }

/**
 * Row-level authorisation for editing or soft-deleting a message.
 *
 *   1. A soft-deleted message is immutable → 410.
 *   2. A moderator (Founder) may act on any message at any time.
 *   3. The author may act only on their own message within the edit window.
 *   4. Anyone else → 403.
 *
 * `createdAt` is never rewritten on edit, so the window clock cannot be reset
 * by repeated edits (the classic "edit extends its own deadline" bug).
 */
export function guardMessage(
  message: Message & { _id: ObjectId },
  viewerId: ObjectId,
  isModerator: boolean,
  windowMinutes: number,
  attemptedAt = new Date()
): Guard {
  if (message.isDeleted) {
    return {
      ok: false,
      status: 410,
      code: 'MESSAGE_DELETED',
      message: 'Message has already been deleted',
    }
  }
  if (isModerator) return { ok: true }
  if (!message.senderId.equals(viewerId)) {
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
      message: 'You can only edit or delete your own messages',
    }
  }
  if (!commentWithinEditWindow(message.createdAt, attemptedAt, windowMinutes)) {
    return {
      ok: false,
      status: 403,
      code: 'MESSAGE_WINDOW_CLOSED',
      message: `The edit window (${windowMinutes} min) has closed. Ask the Founder to moderate this message.`,
    }
  }
  return { ok: true }
}

/* ------------------------------ read / unread ------------------------------ */

/**
 * Unread counts per channel for one user: non-deleted, not-from-me messages
 * newer than the user's watermark. A channel never opened defaults to a zero
 * watermark, so the whole backlog counts as unread until the first visit.
 */
export async function computeUnreadCounts(
  db: Db,
  userId: ObjectId,
  channelIds: ObjectId[]
): Promise<Record<string, number>> {
  if (channelIds.length === 0) return {}
  const reads = await getChannelReadCollection(db)
    .find({ userId } as never)
    .toArray()
  const byChannel = new Map(reads.map((r) => [r.channelId.toString(), r.lastReadAt]))

  const col = getMessageCollection(db)
  const counts = await Promise.all(
    channelIds.map(async (channelId) => {
      const since = byChannel.get(channelId.toString()) ?? new Date(0)
      const n = await col.countDocuments({
        channelId,
        isDeleted: false,
        senderId: { $ne: userId },
        createdAt: { $gt: since },
      } as never)
      return [channelId.toString(), n] as [string, number]
    })
  )
  return Object.fromEntries(counts)
}

/** Upserts the user's last-read watermark for a channel. */
export async function markChannelRead(
  db: Db,
  userId: ObjectId,
  channelId: ObjectId,
  at: Date
): Promise<void> {
  const now = new Date()
  await getChannelReadCollection(db).updateOne(
    { userId, channelId } as never,
    { $set: { lastReadAt: at, updatedAt: now }, $setOnInsert: { userId, channelId } } as never,
    { upsert: true }
  )
}
