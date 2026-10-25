import { ObjectId } from 'mongodb'
import { Db, Collection } from 'mongodb'
import { isTransientMongoError } from '@/lib/mongo-errors'

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
  /**
   * When the channel was archived, for the Archived Chats view. Optional on the
   * document: channels archived before Phase 3 simply have no timestamp, which
   * the UI shows as "archived earlier" rather than inventing one.
   */
  archivedAt?: Date | null
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
  archivedAt: c.archivedAt ?? null,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
})

/* --------------------------------- messages -------------------------------- */

/* -------------------------------- mentions -------------------------------- */
/**
 * A resolved @mention. The text keeps the human `@Name` run so a message reads
 * naturally in any consumer, while this array is the structured record: the
 * `userId` is derived SERVER-SIDE from the text against the active-user
 * directory (`@/lib/chat-mentions`), so a client can never forge a mention of a
 * user it merely typed a name for, and a notification always has a real id to
 * point at.
 */
export interface MessageMention {
  userId: ObjectId
  /** The display name the mention was resolved from, kept for rendering. */
  name: string
}

/* ------------------------------- references ------------------------------- */

/**
 * A link to a real record in another module. Only the type + id are stored —
 * never a copy of the record's name, figure or status, because a copied label
 * goes stale and can leak data the later viewer may not be entitled to see.
 * The read path re-resolves each id against the live record, per viewer
 * (`@/lib/chat-references`), so a chip always points at the actual record.
 */
export interface MessageReference {
  entityType: string
  entityId: ObjectId
}

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
  /**
   * Phase 3 collaboration fields. Both are OPTIONAL rather than defaulted: no
   * migration touches the existing history, and a message without them behaves
   * exactly as before (`[]` at serialisation time).
   */
  mentions?: MessageMention[]
  references?: MessageReference[]
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
  // A deleted message's collaboration data goes with its body: an unresolvable
  // mention list or record link would advertise a connection to content that is
  // no longer readable.
  mentions: m.isDeleted
    ? []
    : (m.mentions ?? []).map((x) => ({ userId: x.userId.toString(), name: x.name })),
  references: m.isDeleted
    ? []
    : (m.references ?? []).map((x) => ({
        entityType: x.entityType,
        entityId: x.entityId.toString(),
      })),
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

/**
 * The current idempotency index: unique on `{ channelId, clientId }` but ONLY
 * for documents that actually carry a string `clientId`.
 */
export const CHAT_CLIENT_IDEMPOTENCY_INDEX = 'messages_channel_client_partial_unique'

/**
 * The superseded Phase 7 definition — a compound `{ channelId, clientId }` index
 * declared `unique + sparse`. It is what produced the recurring
 * `E11000 … messages_channel_client_unique … { channelId, clientId: null }`.
 *
 * A compound **sparse** index only omits a document when it is missing EVERY
 * indexed field. A legacy message that has a `channelId` but no `clientId` is
 * therefore still indexed, under `{ channelId, null }` — and the second such
 * message in the same channel collides. `migrateLegacyMessages` backfills
 * `channelId` onto exactly those pre-channel rows, so every run fed a fresh
 * `{ general, null }` pair into the index and threw. See
 * `scripts/migrate-chat-clientid-index.ts` for the reversible swap.
 */
export const LEGACY_CHAT_CLIENT_IDEMPOTENCY_INDEX = 'messages_channel_client_unique'

let chatIndexesPromise: Promise<void> | null = null

/**
 * Idempotent per-process. Logged rather than thrown so an index hiccup degrades
 * to a slower scan instead of failing the request — matches `ensureTaskIndexes`
 * / `ensureSyncIndexes`.
 *
 * The global `{ createdAt: -1 }` message index is intentionally NOT created
 * here: `ensureSyncIndexes` already owns it for the change-cursor read, and
 * creating the same key pattern twice would fight over its name.
 *
 * It does NOT drop the legacy sparse index: boot-time work stays additive so a
 * process never performs a destructive schema change on its own. That swap is a
 * deliberate, approval-gated migration (`scripts/migrate-chat-clientid-index.ts`).
 * Until it runs, the migration below fails once, is logged once, and the memo is
 * HELD rather than reset — which is what stops the old every-request re-run.
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
          // insert collides here instead of duplicating the message. Partial (not
          // sparse) so messages without a clientId — every pre-channel row — are
          // left out of the index entirely and can never collide on `null`.
          getMessageCollection(db).createIndex(
            { channelId: 1, clientId: 1 },
            {
              unique: true,
              name: CHAT_CLIENT_IDEMPOTENCY_INDEX,
              partialFilterExpression: { clientId: { $type: 'string' } },
            }
          ),
          getChannelReadCollection(db).createIndex(
            { userId: 1, channelId: 1 },
            { unique: true, name: 'chatReads_user_channel' }
          ),
        ])
      } catch (error) {
        // Only a transient outage (Atlas cold start, a dropped socket) is worth
        // retrying on the next call. A permanent failure — a schema conflict, a
        // duplicate key from the legacy index — re-attempted on EVERY request is
        // exactly the terminal-spam behaviour this refactor removes, so we hold
        // the memo and attempt it once per process.
        if (isTransientMongoError(error)) chatIndexesPromise = null
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
 * any pre-channel message into `general`.
 *
 * Idempotent and NON-THRASHING. The memo is reset only for a transient failure
 * so the next request retries an Atlas cold start; a permanent failure is
 * logged once and the settled memo is kept, so a request after a broken init
 * neither repeats the work nor re-prints the same stack on every page load. The
 * error is swallowed either way — chat degrades to a slower scan, the request
 * never fails because of initialisation.
 */
export function ensureChatCollections(db: Db): Promise<void> {
  if (chatSetupPromise) return chatSetupPromise
  chatSetupPromise = (async () => {
    try {
      await ensureChatIndexes(db)
      await seedDefaultChannels(db)
      await migrateLegacyMessages(db)
    } catch (error) {
      if (isTransientMongoError(error)) chatSetupPromise = null
      console.error('ensureChatCollections failed:', error)
    }
  })()
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
