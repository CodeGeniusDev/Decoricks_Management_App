/**
 * Chat UI domain types + pure reconciliation helpers.
 *
 * The helpers are framework-free and side-effect-free so the tricky ordering
 * rules — dedup between an optimistic message and the authoritative server copy,
 * and stable chronological ordering — can be unit-tested directly instead of
 * only through a browser.
 */

/** How the composer renders a single outgoing message. */
export type MessageStatus = 'sending' | 'sent' | 'failed'

/** A message as serialised by `messageToJSON` on the server. */
export interface ServerMessage {
  _id: string
  channelId: string
  senderId: string
  senderName: string
  content: string
  isSystem: boolean
  clientId?: string
  editedAt?: string | null
  isDeleted: boolean
  createdAt: string
  /** Server-computed: may the caller edit/delete this row right now? */
  editable?: boolean
}

/** A message on the client: server copy plus a local status, or an optimistic
 *  pending row that has no `_id` yet (its `tempId` doubles as the clientId). */
export interface ChatMessage extends ServerMessage {
  /** Present only on optimistic rows that have not been persisted. */
  tempId?: string
  status?: MessageStatus
}

/** A channel from `GET /api/chat/channels`, enriched for the sidebar. */
export interface ChatChannel {
  _id: string
  key: string
  name: string
  description?: string
  isArchived: boolean
  createdAt: string
  unreadCount: number
  canManage: boolean
}

const timeOf = (m: ChatMessage): number => Date.parse(m.createdAt) || 0

/**
 * Chronological order, oldest first. Mongo ObjectIds are lexicographically
 * sortable and, within the same millisecond, monotonic — so `createdAt` then
 * `_id` is a stable total order. Optimistic rows (no `_id`) sort to the end of
 * their millisecond so they never jump ahead of a server message sent first.
 */
export function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => {
    const ta = timeOf(a)
    const tb = timeOf(b)
    if (ta !== tb) return ta - tb
    return (a._id ?? '\uffff').localeCompare(b._id ?? '\uffff')
  })
}

/** Identity used to match a client row to a server row across a reconcile. */
const identity = (m: ChatMessage): string => m._id || m.tempId || m.clientId || ''

/**
 * Merge a fetched page into the current view without duplicates or reorder
 * glitches.
 *
 * Rules:
 *  - `incoming` is authoritative: a server row always wins over an optimistic
 *    row that shares its `clientId` (or temp `clientId` === optimistic tempId),
 *    which is how a pending send is replaced by the real document.
 *  - Rows are deduped by `_id`, and an optimistic row is dropped once a server
 *    row with the same clientId exists.
 *  - `prepend` (load-older) keeps existing rows untouched and adds older ones;
 *    `tail` (live/incremental) adds newer ones. Either way the result is re-sorted
 *    so nothing ever renders out of order.
 */
export function mergeMessages(
  current: ChatMessage[],
  incoming: ServerMessage[],
  mode: 'prepend' | 'tail' = 'tail'
): ChatMessage[] {
  // Optimistic rows whose clientId now exists on the server are retired; the
  // authoritative server row (added below) takes their place, so a pending send
  // is replaced — never duplicated — when the live tail or the POST response
  // delivers the persisted document.
  const persistedClientIds = new Set(
    incoming.filter((s) => s.clientId).map((s) => s.clientId as string)
  )
  const kept = current.filter((m) => m._id || !persistedClientIds.has(m.clientId || m.tempId || ''))

  const byIdentity = new Map<string, ChatMessage>()
  for (const m of kept) byIdentity.set(identity(m), m)
  for (const s of incoming) byIdentity.set(s._id, { ...s, status: 'sent' })

  let merged = sortMessages(Array.from(byIdentity.values()))

  // Guard against unbounded growth for a very long-lived session; keep the most
  // recent window. The oldest are still re-fetchable via load-older.
  const CAP = 500
  if (mode === 'tail' && merged.length > CAP) merged = merged.slice(merged.length - CAP)

  return merged
}

/** The newest `createdAt` (epoch ms) among persisted rows — the poll `since`. */
export function newestTimestamp(messages: ChatMessage[]): number {
  let max = 0
  for (const m of messages) {
    if (m._id) max = Math.max(max, timeOf(m))
  }
  return max
}
