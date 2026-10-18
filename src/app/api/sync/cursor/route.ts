import { NextRequest } from 'next/server'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorize, requireAuth } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { successResponse } from '@/lib/api-response'
import { computeCursor, ensureSyncIndexes, SYNC_MODULES } from '@/lib/sync/cursor'
import type { SyncModule } from '@/lib/sync/types'
import type { PermissionModule } from '@/lib/models/User'

/**
 * GET /api/sync/cursor
 *
 * The single cheap read behind every realtime subscriber. It answers one
 * question — "has anything in these modules changed since I last looked?" —
 * by returning the newest `updatedAt`/`createdAt` timestamp per module. It
 * never returns row data, so a poll leaks nothing beyond "something changed",
 * and each subscriber still re-fetches its own records through the normal
 * permission-checked endpoints.
 *
 * Permissions are enforced *per module*: a Partner who cannot view finance
 * simply gets no `finance` key back, rather than a 403 that would break the
 * whole poll. Sessions are handled by `withAuth`; a missing/expired session is
 * a 401 exactly like every other route.
 *
 * The client sends `x-session-background: 1` on polls so an idle tab's chatter
 * with this endpoint does not extend the rolling inactivity timeout.
 */

const PERMISSION: Record<Exclude<SyncModule, 'notifications'>, [module: PermissionModule, action: string]> = {
  tasks: ['tasks', 'view'],
  chat: ['chat', 'view'],
  sales: ['sales', 'view'],
  inventory: ['inventory', 'view'],
  finance: ['finance', 'view'],
}

async function __GET(request: NextRequest) {
  try {
    const caller = await requireAuth()
    const callerId = caller.user._id?.toString()

    const raw = new URL(request.url).searchParams
      .get('modules')
      ?.split(',')
      .map((m) => m.trim())
      .filter(Boolean)

    // Fall back to every module when none requested, and drop any unknown name
    // so a malformed query cannot reach the source map.
    const requested = (raw && raw.length ? raw : SYNC_MODULES).filter((m): m is SyncModule =>
      (SYNC_MODULES as string[]).includes(m)
    )

    const db = await getDatabase()
    await ensureSyncIndexes(db)

    // Keep only the modules this caller is actually allowed to view.
    const permitted: SyncModule[] = []
    for (const mod of requested) {
      // `notifications` is user-scoped: any authenticated caller may ask for it,
      // because computeCursor answers it with only *their own* newest timestamp.
      if (mod === 'notifications') {
        permitted.push(mod)
        continue
      }
      const [permModule, action] = PERMISSION[mod]
      try {
        await authorize(permModule, action)
        permitted.push(mod)
      } catch {
        // No permission for this module — omit it instead of failing the poll.
      }
    }

    const cursor = await computeCursor(db, permitted, callerId)
    const res = successResponse(cursor)
    res.headers.set('Cache-Control', 'no-store')
    return res
  } catch (error) {
    console.error('GET /api/sync/cursor failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const dynamic = 'force-dynamic'
