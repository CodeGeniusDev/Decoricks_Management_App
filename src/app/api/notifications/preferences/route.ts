import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { requireAuth } from '@/lib/authorization'
import { HttpError, handleRouteError } from '@/lib/http'
import { successResponse } from '@/lib/api-response'
import { getUserCollection } from '@/lib/models/User'
import {
  NON_MUTEABLE_TYPES,
  NOTIFICATION_TYPES,
  resolveNotificationPrefs,
  type NotificationPrefs,
  type NotificationType,
} from '@/lib/notifications/types'

/**
 * /api/notifications/preferences — the per-user on/off switches (design §2.2).
 *
 * GET returns the *resolved* map (stored values merged over defaults), so a user
 * created before Phase 9 sees every type enabled rather than an empty object, and
 * the two operational-integrity types are always reported on. PATCH accepts a
 * partial map and persists only the muteable types the caller is allowed to
 * toggle — a request to disable `sync_failure`/`sync_conflict` is silently
 * ignored, because those must always reach the affected user. Unknown keys are
 * rejected so a typo cannot quietly create a dead preference.
 *
 * This is the caller's OWN preference document; `requireAuth` is the whole gate.
 */

export const dynamic = 'force-dynamic'

const isNotificationType = (value: string): value is NotificationType =>
  (NOTIFICATION_TYPES as string[]).includes(value)

async function __GET() {
  const auth = await requireAuth()
  const db = await getDatabase()
  const user = await getUserCollection(db).findOne(
    { _id: auth.user._id as ObjectId },
    { projection: { notificationPrefs: 1 } }
  )
  return successResponse({ preferences: resolveNotificationPrefs(user?.notificationPrefs) })
}

async function __PATCH(request: NextRequest) {
  const auth = await requireAuth()
  const body = (await request.json().catch(() => null)) as
    | { preferences?: Record<string, { enabled?: unknown }> }
    | null

  const incoming = body?.preferences
  if (!incoming || typeof incoming !== 'object') {
    throw new HttpError('`preferences` object is required', 400, 'VALIDATION_ERROR')
  }

  // Validate every key before touching the database — reject-then-write, never
  // half-apply a malformed toggle request.
  for (const [key, value] of Object.entries(incoming)) {
    if (!isNotificationType(key)) {
      throw new HttpError(`Unknown notification type "${key}"`, 400, 'VALIDATION_ERROR')
    }
    if (typeof value?.enabled !== 'boolean') {
      throw new HttpError(`"${key}".enabled must be a boolean`, 400, 'VALIDATION_ERROR')
    }
  }

  const db = await getDatabase()
  const user = await getUserCollection(db).findOne(
    { _id: auth.user._id as ObjectId },
    { projection: { notificationPrefs: 1 } }
  )
  const merged: NotificationPrefs = resolveNotificationPrefs(user?.notificationPrefs)

  for (const [key, value] of Object.entries(incoming)) {
    // Non-muteable types are refused a "false" and coerced to "true"; the value
    // is never written as disabled, so the emit gate can always rely on it.
    if (NON_MUTEABLE_TYPES.has(key as NotificationType)) {
      merged[key as NotificationType] = { enabled: true }
    } else {
      merged[key as NotificationType] = { enabled: value.enabled as boolean }
    }
  }

  await getUserCollection(db).updateOne(
    { _id: auth.user._id as ObjectId } as never,
    { $set: { notificationPrefs: merged, updatedAt: new Date() } } as never
  )

  return successResponse({ preferences: merged })
}

export const GET = async (): Promise<Response> => {
  try {
    return await __GET()
  } catch (error) {
    return handleRouteError(error)
  }
}

export const PATCH = async (request: NextRequest): Promise<Response> => {
  try {
    return await __PATCH(request)
  } catch (error) {
    return handleRouteError(error)
  }
}
