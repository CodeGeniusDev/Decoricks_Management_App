import { ObjectId } from 'mongodb'
import { Db, Collection } from 'mongodb'

/**
 * Phase 7 team-chat documents (SPEC §3.1.9, §7).
 *
 * Three collections describe the chat:
 *
 *   - `chatChannels`    — rooms. `general`, `orders`, `content` are seeded and
 *                         guaranteed to exist; the Founder can add more. Only
 *                         `isArchived` ever "removes" one, never a delete.
 *   - `messages`        — append-only per channel. Edits and deletes are
 *                         in-place flags (`editedAt` / `isDeleted`) inside a
 *                         Founder-configurable window; the body is redacted on
 *                         serialisation, never physically destroyed, so the
 *                         audit story can always be reconstructed.
 *   - `chatChannelReads`— one { userId, channelId, lastReadAt } watermark that
 *                         drives per-channel unread counts. No denormalised
 *                         counters that can drift.
 *
 * Everything here is additive over the Phase 1 single-thread `messages`
 * collection: `ensureChatCollections` backfills the pre-channel rows into
 * `general` so no deployment needs a separate migration step.
 */

/* -------------------------------- channels -------------------------------- */

/** Slug of a channel that is always present. `general` receives migrated mail. */
export const DEFAULT_CHANNEL_KEYS = ['general', 'orders', 'content'] as const
export type DefaultChannelKey = (typeof DEFAULT_CHANNEL_KEYS)[number]

const DEFAULT_CHANNELS: ReadonlyArray<{ key: string; name: string; description: string }> = [
  { key: 'general', name: 'General', description: 'Everyday team chatter' },
  { key: 'orders', name: 'Orders', description: 'Order and delivery coordination' },
  { key: 'content', name: 'Content', description: 'Design and content planning' },
]

export interface ChatChannel {
  _id?: ObjectId
  /** Unique slug. Stable identity for clients that hard-code `general`. */
  key: string
  name: string
  description?: string
  isArchived: boolean
  /** null for the three seeded channels; a Founder's id for created ones. */
  createdBy: ObjectId | null
  createdAt: Date
  updatedAt: Date
}

export const getChannelCollection = (db: Db): Collection<ChatChannel> =>
  db.collection<ChatChannel>('chatChannels')

export const channelToJSON = (c: ChatChannel) => ({
  _id: c._id?.toString(),
  key: c.key,
  name: c.name,
  description: c.description,
  isArchived: c.isArchived,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
})

/* --------------------------------- messages -------------------------------- */

export interface Message {
  _id?: ObjectId
  /** Owning channel. Backfilled for pre-channel documents by the migration. */
  channelId: ObjectId
  senderId: ObjectId
  senderName?: string
  content: string
  isSystem: boolean
  /** Client-generated; unique within a channel when present. Retry guard. */
  clientId?: string
  editedAt?: Date | null
  isDeleted: boolean
  deletedAt?: Date | null
  deletedBy?: ObjectId | null
  createdAt: Date
}

export const getMessageCollection = (db: Db): Collection<Message> =>
  db.collection<Message>('messages')

/**
 * `content` is nulled once a message is soft-deleted so no read path can leak
 * the redacted text; `isDeleted` + `deletedAt` remain so the UI can render the
 * "This message was deleted" tombstone and the audit trail stays whole.
 */
export const messageToJSON = (m: Message) => ({
  _id: m._id?.toString(),
  channelId: m.channelId?.toString(),
  senderId: m.senderId.toString(),
  senderName: m.senderName,
  content: m.isDeleted ? null : m.content,
  isSystem: m.isSystem,
  clientId: m.clientId,
  editedAt: m.editedAt ?? null,
  isDeleted: m.isDeleted,
  deletedAt: m.deletedAt ?? null,
  createdAt: m.createdAt,
})

/* ------------------------------ read watermarks ---------------------------- */

export interface ChannelRead {
  _id?: ObjectId
  userId: ObjectId
  channelId: ObjectId
  lastReadAt: Date
  updatedAt: Date
}

export const getChannelReadCollection = (db: Db): Collection<ChannelRead> =>
  db.collection<ChannelRead>('chatChannelReads')

/* --------------------------------- indexes -------------------------------- */

let chatIndexesPromise: Promise<void> | null = null

/**
 * Idempotent per-process. Logged rather than thrown so a transient index hiccup
 * degrades to a slower scan instead of failing the request — matches
 * `ensureTaskIndexes` / `ensureSyncIndexes`.
 *
 * The global `{ createdAt: -1 }` message index is intentionally NOT created
 * here: `ensureSyncIndexes` already owns it for the change-cursor read, and
 * creating the same key pattern twice would fight over its name.
 */
export function ensureChatIndexes(db: Db): Promise<void> {
  if (!chatIndexesPromise) {
    chatIndexesPromise = (async () => {
      try {
        await Promise.all([
          getChannelCollection(db).createIndex(
            { key: 1 },
            { unique: true, name: 'chatChannels_key_unique' }
          ),
          getChannelCollection(db).createIndex(
            { isArchived: 1, updatedAt: -1 },
            { name: 'chatChannels_archived_updated' }
          ),
          // Channel history + cursor pagination (`{ channelId, createdAt }`).
          getMessageCollection(db).createIndex(
            { channelId: 1, createdAt: -1 },
            { name: 'messages_channel_created' }
          ),
          // Idempotent send: a client retry reuses the same clientId, so a second
          // insert collides here instead of duplicating the message.
          getMessageCollection(db).createIndex(
            { channelId: 1, clientId: 1 },
            { unique: true, sparse: true, name: 'messages_channel_client_unique' }
          ),
          getChannelReadCollection(db).createIndex(
            { userId: 1, channelId: 1 },
            { unique: true, name: 'chatReads_user_channel' }
          ),
        ])
      } catch (error) {
        chatIndexesPromise = null
        console.error('ensureChatIndexes failed:', error)
      }
    })()
  }
  return chatIndexesPromise
}

/* -------------------------------- migration ------------------------------- */

let chatSetupPromise: Promise<void> | null = null

/**
 * Brings the chat collections to a usable state on first touch: builds
 * indexes, ensures the three default channels exist, and additively backfills
 * any pre-channel message into `general`. Safe to call on every request — the
 * work happens once per process and the queries it repeats are indexed no-ops.
 */
export function ensureChatCollections(db: Db): Promise<void> {
  if (!chatSetupPromise) {
    chatSetupPromise = (async () => {
      try {
        await ensureChatIndexes(db)
        await seedDefaultChannels(db)
        await migrateLegacyMessages(db)
      } catch (error) {
        // Reset so a transient failure (e.g. Atlas cold start) is retried by
        // the next request rather than permanently skipping the migration.
        chatSetupPromise = null
        console.error('ensureChatCollections failed:', error)
      }
    })()
  }
  return chatSetupPromise
}

/** $setOnInsert only: a Founder renaming/archiving `general` is never clobbered. */
async function seedDefaultChannels(db: Db): Promise<void> {
  const col = getChannelCollection(db)
  const now = new Date()
  await Promise.all(
    DEFAULT_CHANNELS.map((c) =>
      col.updateOne(
        { key: c.key },
        {
          $setOnInsert: {
            key: c.key,
            name: c.name,
            description: c.description,
            isArchived: false,
            createdBy: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true }
      )
    )
  )
}

/** Additive: touches only documents that predate the channel model. */
async function migrateLegacyMessages(db: Db): Promise<void> {
  const general = await getChannelCollection(db).findOne({ key: 'general' })
  if (!general?._id) return
  const col = getMessageCollection(db)
  await col.updateMany({ channelId: { $exists: false } }, { $set: { channelId: general._id } })
  await col.updateMany({ isDeleted: { $exists: false } }, { $set: { isDeleted: false } })
}
