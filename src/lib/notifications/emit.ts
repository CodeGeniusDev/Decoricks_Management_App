import type { Db } from 'mongodb'
import { ObjectId } from 'mongodb'
import { getUserCollection, type User } from '@/lib/models/User'
import {
  ensureNotificationIndexes,
  getNotificationCollection,
  type NotificationDoc,
} from '@/lib/models/Notifications'
import { getRole, hasPermission } from '@/lib/authorization'
import { realtimeBus } from '@/lib/realtime/bus'
import {
  NON_MUTEABLE_TYPES,
  NOTIFICATION_PERMISSION,
  resolveNotificationPrefs,
  type NotificationData,
  type NotificationType,
} from './types'
import { deliverPush } from './push'

/**
 * Server-side notification generation with dedupe (design §2.7).
 *
 * ONE entry point: every event — state hook or lazy sweep — funnels through
 * `emitNotification`. That centralisation is what makes the three hard
 * guarantees structural rather than per-call-site discipline:
 *
 *   1. Permission-aware (§2.3) — the recipient's grant is re-checked *at emit
 *      time*; without it no row is written, so a user can never receive — or
 *      even learn of — a notification about data they cannot see.
 *   2. Preference-aware (§2.2) — the recipient's `notificationPrefs` are honoured
 *      (the two operational-integrity types are always delivered).
 *   3. Deduped (§2.7) — the unique `{ userId, dedupeKey }` index means the same
 *      event never notifies twice; a violation is "already sent", NOT an error.
 *
 * It NEVER throws for a business reason (suppressed / deduped returns
 * `{ created: false }`), so a write route that fires notifications can call it
 * without a try/catch and cannot fail a successful create because an alert was
 * refused.
 */

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000

export interface EmitInput {
  userId: string | ObjectId
  type: NotificationType
  dedupeKey: string
  title: string
  message: string
  data: NotificationData
}

export interface EmitResult {
  created: boolean
  notificationId?: string
}

/** Resolve + permission/pref-gate one recipient, then insert deduped. */
export async function emitNotification(db: Db, input: EmitInput): Promise<EmitResult> {
  const userId = input.userId instanceof ObjectId ? input.userId : new ObjectId(input.userId)

  // Fetch the recipient once: we need their active state, role (permission gate)
  // and notificationPrefs in the same read.
  const user = await getUserCollection(db)
    .findOne(
      { _id: userId },
      { projection: { _id: 1, isActive: 1, role: 1, notificationPrefs: 1 } }
    )

  if (!user || user.isActive !== true) return { created: false }

  // 1. Permission gate — suppress entirely if the recipient cannot view the
  //    module this notification is about. `null` means it is about their own
  //    data (their queued sync entries) so no module grant is required.
  const permission = NOTIFICATION_PERMISSION[input.type]
  if (permission) {
    const role = await getRole(user.role, db)
    if (!role || !hasPermission(role, permission[0], permission[1])) return { created: false }
  }

  // 2. Preference gate — the two non-muteable integrity types always pass;
  //    `resolveNotificationPrefs` already forces them enabled, so this is just
  //    the per-type opt-out for everything else.
  const prefs = resolveNotificationPrefs(user.notificationPrefs)
  if (!NON_MUTEABLE_TYPES.has(input.type) && !prefs[input.type].enabled) {
    return { created: false }
  }

  await ensureNotificationIndexes(db)

  const now = new Date()
  const doc: Omit<NotificationDoc, '_id'> = {
    userId,
    type: input.type,
    dedupeKey: input.dedupeKey,
    title: input.title,
    message: input.message,
    data: input.data,
    isRead: false,
    createdAt: now,
  }

  let insertedId: ObjectId
  try {
    const result = await getNotificationCollection(db).insertOne(doc as never)
    insertedId = result.insertedId
  } catch (error) {
    // 3. Dedupe: the unique index rejected it as already-notified. Not an error.
    if (isDuplicateKeyError(error)) return { created: false }
    throw error
  }

  // Delivery — only for a row that actually wrote. The live signal is user-scoped
  // (carries the recipient id) so the SSE route fans it only to that user's
  // streams, and push is best-effort on top. Both are non-fatal to the insert.
  realtimeBus.publish('notifications', now.getTime(), userId.toString())
  void deliverPush(db, userId.toString(), {
    title: input.title,
    body: input.message,
    link: input.data.link,
    notificationId: insertedId.toString(),
    type: input.type,
  })

  return { created: true, notificationId: insertedId.toString() }
}

/** Every active user holding `<module>.view`, for broadcast events. */
async function eligibleUsers(db: Db, module: string | null): Promise<User[]> {
  const users = await getUserCollection(db).find({ isActive: true }).toArray()
  if (!module) return users
  const gated: User[] = []
  for (const user of users) {
    const role = await getRole(user.role, db)
    if (role && hasPermission(role, module, 'view')) gated.push(user)
  }
  return gated
}

/**
 * Broadcast one event to every eligible recipient. Each `emitNotification` still
 * applies the per-user permission + preference + dedupe gates, so calling this
 * for a low-stock event is safe even for a Founder-less deployment or a user who
 * muted the type — they simply get nothing.
 *
 * `userId` on the shared input is ignored; recipients are resolved here.
 */
export async function emitToAllEligible(
  db: Db,
  input: Omit<EmitInput, 'userId'>
): Promise<number> {
  const permission = NOTIFICATION_PERMISSION[input.type]
  const recipients = await eligibleUsers(db, permission ? permission[0] : null)
  const results = await Promise.all(
    recipients.map((user) =>
      emitNotification(db, { ...input, userId: user._id as ObjectId })
    )
  )
  return results.filter((r) => r.created).length
}

/**
 * Emit to an explicit set of users (e.g. a task's assignees, or a sync entry's
 * owner). Still permission- and preference-gated per recipient, so passing an
 * assignee who cannot view tasks drops them silently.
 */
export async function emitToUsers(
  db: Db,
  userIds: (string | ObjectId)[],
  input: Omit<EmitInput, 'userId'>
): Promise<number> {
  const unique = [...new Set(userIds.map((id) => id.toString()))]
  const results = await Promise.all(
    unique.map((id) => emitNotification(db, { ...input, userId: id }))
  )
  return results.filter((r) => r.created).length
}

/** The Founder's user id(s) — for conflict and financial alerts to the owner. */
export async function getFounderUserIds(db: Db): Promise<string[]> {
  const founders = await getUserCollection(db)
    .find({ role: 'founder', isActive: true })
    .toArray()
  return founders.map((f) => f._id.toString())
}
