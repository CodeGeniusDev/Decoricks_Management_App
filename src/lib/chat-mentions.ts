import type { Db } from 'mongodb'
import { ObjectId } from 'mongodb'
import { getUserCollection, type Role } from '@/lib/models/User'
import { getRole, hasPermission } from '@/lib/authorization'
import { findMentionMatches } from '@/lib/chat-mention-text'
import type { ChatChannel, Message, MessageMention } from '@/lib/models/Chat'
import { emitNotification } from '@/lib/notifications/emit'
import { mentionKey } from '@/lib/notifications/dedupe'

/**
 * Phase 3 @mentions.
 *
 * The one decision that shapes this whole module: **mentions are derived on the
 * server from the message text, never accepted from the client.** A composer
 * sends `content` plus a list of user ids and the server trusts that list would
 * mean any signed-in member could fire a notification at a colleague they never
 * addressed, or at a user id they guessed. Deriving instead means the client
 * cannot claim anything the stored text does not already say: the `@Name` run in
 * the message and the `userId` in `mentions` come from the same server-side
 * match, so they cannot disagree, and the structured id (which the notification
 * needs) is authoritative rather than a decoration on display text.
 *
 * The cost of that choice is that a mention is only a mention if the visible
 * text contains it — which is exactly what the composer's autocomplete inserts,
 * and what a hand-typed `@Hasnat` produces too.
 */

/** A user who can legitimately be mentioned: active, and able to read Chat. */
export interface MentionableUser {
  _id: ObjectId
  name: string
}

/**
 * Raised by the 4-person team the app is built for, but the read is indexed by
 * `_id` and cached per request, so a wider team costs nothing extra here.
 */
const MAX_MENTIONS_PER_MESSAGE = 10

/**
 * The mentionable directory: every active user whose role holds `chat.view`.
 *
 * Two filters, both deliberate. `isActive` stops a mention (and therefore a
 * notification) reaching a deactivated account. The permission filter is the
 * one that matters for the brief's "do not expose private messages to
 * unauthorised users": a member who cannot open Chat has no business receiving
 * an alert that quotes a chat message, so they are not mentionable at all.
 *
 * Roles are resolved once per distinct role name, not once per user.
 */
export async function loadMentionDirectory(db: Db): Promise<MentionableUser[]> {
  const users = await getUserCollection(db)
    .find({ isActive: true }, { projection: { _id: 1, name: 1, role: 1 } })
    .toArray()

  const roleCache = new Map<string, Role | null>()
  const directory: MentionableUser[] = []
  for (const user of users) {
    const name = (user.name ?? '').trim()
    if (!user._id || !name) continue

    let role = roleCache.get(user.role)
    if (role === undefined) {
      role = await getRole(user.role, db)
      roleCache.set(user.role, role)
    }
    if (!role || !hasPermission(role, 'chat', 'view')) continue
    directory.push({ _id: user._id, name })
  }
  return directory
}

/**
 * Same directory, shaped for the client: no email, no role object, no field the
 * composer has no use for. Returned by `GET /api/chat/members`, which is the
 * only user-listing surface Chat needs — `GET /api/users` is Founder-only
 * settings data and must not become a side channel for autocomplete.
 */
export const directoryForClient = (directory: MentionableUser[]) =>
  directory.map((u) => ({ id: u._id.toString(), name: u.name }))

/**
 * Find every `@<name>` in already-sanitised text.
 *
 * The text grammar itself lives in `@/lib/chat-mention-text`, shared with the
 * composer and the message list so the three cannot disagree about what a
 * mention is. What this function adds is identity: it maps each located name to
 * a real user id from the directory, and collapses repeat mentions of the same
 * person inside one message to a single entry — so re-typing a name cannot
 * multiply chips or alerts — in the order the names appear in the message.
 *
 * Because the id comes from the server's own directory lookup, a name that
 * belongs to a deactivated or chat-less account simply never resolves, which is
 * the safe handling the brief asks for: no mention stored, no notification sent.
 */
export function findMentions(content: string, directory: MentionableUser[]): MessageMention[] {
  if (!content || directory.length === 0) return []

  const byName = new Map<string, ObjectId>()
  for (const user of directory) {
    const name = user.name.trim()
    if (name) byName.set(name, user._id)
  }

  const mentions: MessageMention[] = []
  const seen = new Set<string>()
  for (const match of findMentionMatches(content, [...byName.keys()])) {
    const userId = byName.get(match.name)
    if (!userId) continue
    const key = userId.toString()
    if (seen.has(key)) continue
    seen.add(key)
    mentions.push({ userId, name: match.name })
    if (mentions.length >= MAX_MENTIONS_PER_MESSAGE) break
  }
  return mentions
}

/**
 * Persist-time entry point: resolve the text into structured mentions.
 * Returns `undefined` when a message has none, so the common case stores no
 * extra fields at all (rather than an empty array per row).
 */
export function resolveMentionsForMessage(
  content: string,
  directory: MentionableUser[]
): MessageMention[] | undefined {
  const mentions = findMentions(content, directory)
  return mentions.length ? mentions : undefined
}

/**
 * Notify the mentioned members.
 *
 * Called only for a message that was genuinely inserted (`created: true`), and
 * keyed per message per recipient anyway, so a retried send that the idempotency
 * index folded into the original row can never alert twice. `emitNotification`
 * itself re-checks the recipient's active state, `chat.view` grant and personal
 * preference, and swallows the duplicate-key case — so this is safe to fire and
 * forget: it never throws for a business reason and never blocks a send that has
 * already succeeded.
 *
 * The alert carries the sender's name and the channel name, nothing else. The
 * message body stays in Chat behind `chat.view`, so a lock-screen push cannot
 * quote a conversation to someone who is not allowed to read it.
 */
export async function notifyMentions(
  db: Db,
  params: {
    message: Message & { _id: ObjectId }
    channel: Pick<ChatChannel, 'name'>
    mentions: MessageMention[]
  }
): Promise<number> {
  const senderId = params.message.senderId.toString()
  const messageId = params.message._id.toString()
  let created = 0

  for (const mention of params.mentions) {
    // Never alert someone about their own typing — the message is already on
    // their screen. The mention itself is still stored and rendered.
    if (mention.userId.toString() === senderId) continue
    const result = await emitNotification(db, {
      userId: mention.userId,
      type: 'mention',
      dedupeKey: mentionKey(messageId, mention.userId.toString()),
      title: 'You were mentioned',
      message: `${params.message.senderName ?? 'A teammate'} mentioned you in #${params.channel.name}`,
      data: {
        entityType: 'chat_message',
        entityId: messageId,
        // Deep link the reader straight to the conversation (Chat reads
        // `?channel=` on mount) instead of dropping them on an arbitrary channel.
        link: `/chat?channel=${params.message.channelId.toString()}`,
      },
    })
    if (result.created) created += 1
  }
  return created
}
