import { NextRequest } from 'next/server'
import { handleRouteError, withAuth, logRouteFailure } from '@/lib/http'
import { discoverViewScopes } from '@/lib/authorization'
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
 * This is the fallback half of `/api/events`: the same question, the same module
 * set, the same per-module scope. It therefore resolves that scope the same way
 * — see the `discoverViewScopes` note below.
 *
 * The client sends `x-session-background: 1` on polls so an idle tab's chatter
 * with this endpoint does not extend the rolling inactivity timeout.
 */

const PERMISSION: Record<
  Exclude<SyncModule, 'notifications'>,
  [module: PermissionModule, action: string]
> = {
  tasks: ['tasks', 'view'],
  chat: ['chat', 'view'],
  sales: ['sales', 'view'],
  inventory: ['inventory', 'view'],
  finance: ['finance', 'view'],
}

async function __GET(request: NextRequest) {
  try {
    /*
     * ONE session aggregate for the whole module set.
     *
     * This used to be `requireAuth()` plus a serial `authorize()` per module —
     * six identical session lookups per poll, measured in production as
     * `auth:session=462ms x6` inside a 833–933 ms request for an endpoint that
     * returns six numbers and no row data (`scripts/api-timing-summary.cjs`,
     * median 1427 ms / p95 3073 ms over 195 calls in the final suite window).
     * It is the *polling* path, so the cost was paid every 6 s per open tab,
     * for every tab, exactly when the SSE stream has just failed and the client
     * is most behind. `GET /api/events` had the identical bug and was fixed;
     * leaving this one misaligned meant the fallback was slower than the
     * primary, which is backwards.
     *
     * The net effect is unchanged: the 401 for no session is kept, a module the
     * caller cannot view is still silently omitted, and an account still on a
     * temporary password is still denied every gated module — because the role
     * grants are withheld, not because six calls each threw.
     *
     * What is deliberately not kept: the `permission_denied` audit row per
     * module the caller merely has no widget for. That is a non-event, it was
     * written on every 6-second poll by every such caller, and SPEC §3.1.19
     * wants the log to carry *real* denied attempts. Genuine attempts on actual
     * data endpoints still audit through `authorize()`.
     */
    const { userId: callerId, viewable } = await discoverViewScopes(
      Object.values(PERMISSION).map(([module]) => module)
    )
    const granted = new Set(viewable)

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
      if (granted.has(PERMISSION[mod][0])) permitted.push(mod)
      // Otherwise omit it: a missing grant must not fail the whole poll.
    }

    const cursor = await computeCursor(db, permitted, callerId)
    const res = successResponse(cursor)
    res.headers.set('Cache-Control', 'no-store')
    return res
  } catch (error) {
    logRouteFailure('GET /api/sync/cursor', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const dynamic = 'force-dynamic'
