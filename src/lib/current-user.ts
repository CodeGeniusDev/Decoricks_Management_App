import { ObjectId } from 'mongodb'
import { requireAuth } from '@/lib/authorization'

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
 */
export const getActor = async (): Promise<{ id: ObjectId; name: string; role: string }> => {
  const auth = await requireAuth()
  return {
    id: auth.user._id as ObjectId,
    name: auth.user.name,
    role: auth.user.role,
  }
}