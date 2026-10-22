import { NextRequest } from 'next/server'
import { handleRouteError, withAuth, logRouteFailure } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { ensureChatCollections } from '@/lib/models/Chat'
import { directoryForClient, loadMentionDirectory } from '@/lib/chat-mentions'
import { successResponse } from '@/lib/api-response'

/**
 * GET /api/chat/members — the mention autocomplete directory.
 *
 * Chat needs to know who can be `@`-mentioned, and it needs to know that without
 * opening the Founder's user admin: `GET /api/users` is gated on `users.view`
 * and returns emails, role state and session metadata, none of which a composer
 * has any use for. So Chat gets its own deliberately narrow surface.
 *
 * The list is exactly the mention directory — active accounts whose role holds
 * `chat.view` — shaped to `{ id, name }`. A deactivated member disappears from
 * autocomplete, which is the friendly half of the server-side rule that refuses
 * to mention them at all.
 */
async function __GET(_request: NextRequest) {
  try {
    await authorize('chat', 'view')
    const db = await getDatabase()
    await ensureChatCollections(db)
    return successResponse(directoryForClient(await loadMentionDirectory(db)))
  } catch (error) {
    logRouteFailure('GET /api/chat/members', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const dynamic = 'force-dynamic'
