import { ObjectId } from 'mongodb'
import { requireAuth, type AuthorizationResult } from '@/lib/authorization'
import type { AuthenticatedUser } from '@/lib/auth/session'

/**
 * Resolves the acting user for server-side writes (`createdBy`, `updatedBy`).
 *
 * Phase 1 had no sessions, so this returned a placeholder ObjectId read from
 * `AUTH_ACTOR_ID` — which meant an anonymous caller could write to any
 * collection and every record was attributed to a fake actor. Now that sessions
 * exist, the actor is always the authenticated session holder.
 *
 * `AUTH_ACTOR_ID` / `AUTH_ACTOR_NAME` are gone from the environment contract;
 * see `src/lib/env.ts`.
 *
 * Pass the result of the `authorize()` / `requireFounder()` / `requireAuth()`
 * call the handler has already made. Resolving the caller costs one Atlas round
 * trip (~65ms measured, and it is almost entirely network), so calling this with
 * no argument after a grant check read the same session document twice in one
 * request: `GET /api/tasks` spent 143ms of its 205ms total on session lookups.
 * Reusing the verified caller removes the second read and nothing else — the
 * permission check still ran, still on the server, still for this request.
 */
export const getActor = async (
  verified?: AuthenticatedUser | AuthorizationResult
): Promise<{ id: ObjectId; name: string; role: string }> => {
  const { user } = verified ?? (await requireAuth())
  return {
    id: user._id as ObjectId,
    name: user.name,
    role: user.role,
  }
}
