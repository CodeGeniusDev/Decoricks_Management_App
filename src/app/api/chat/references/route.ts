import { NextRequest } from 'next/server'
import { handleRouteError, withAuth, logRouteFailure } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { ensureChatCollections } from '@/lib/models/Chat'
import { REFERENCE_SPECS, searchReferences, viewableModules } from '@/lib/chat-references'
import { referenceSearchSchema } from '@/lib/schemas/chat'
import { recordSearchLimiter } from '@/lib/rate-limit'
import { errorResponse, successResponse, validationError } from '@/lib/api-response'

/**
 * GET /api/chat/references — cross-module record search for the picker.
 *
 * One endpoint deliberately spans every module, because the alternative (the
 * composer calling each module's own list API) would need the client to know
 * which endpoints exist, hold each module's query shape, and decide what it may
 * see — and "what it may see" is exactly the decision that must not live on the
 * client. Here the caller's role resolves the searchable set server-side:
 *
 *   • only types whose module the caller's role can `view` are queried at all,
 *     so a record the viewer cannot see is never read, let alone serialized;
 *   • the response carries labels, identifiers and a link — never an amount, a
 *     phone number or an address, because a picker list is a preview surface and
 *     previews are the easiest place to leak;
 *   • the value a chip eventually displays is resolved again, per viewer, when
 *     the message is read (see `resolveReferences`), so this endpoint's output
 *     being cached or replayed cannot pin a record's state into a message.
 *
 * `types` is returned alongside the results so the picker renders the modules
 * THIS user can reference rather than a hard-coded list that drifts from the
 * role matrix.
 */
async function __GET(request: NextRequest) {
  try {
    const auth = await authorize('chat', 'view')
    const db = await getDatabase()
    await ensureChatCollections(db)

    const allowed = viewableModules(auth)
    const types = REFERENCE_SPECS.filter((spec) => allowed.has(spec.module)).map((spec) => ({
      entityType: spec.entityType,
      label: spec.label,
    }))

    const { searchParams } = new URL(request.url)
    const query = searchParams.get('q')?.trim() ?? ''
    if (!query) return successResponse({ types, results: [] })

    const parsed = referenceSearchSchema.safeParse({
      q: query,
      ...(searchParams.get('type') ? { type: searchParams.get('type') } : {}),
    })
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      )
    }

    const rateKey = auth.user._id?.toString() ?? 'anonymous'
    const rate = recordSearchLimiter.consume(rateKey)
    if (!rate.allowed) {
      const res = errorResponse(
        'You are searching too quickly. Please slow down.',
        429,
        'RATE_LIMITED',
        { retryAfterMs: rate.retryAfterMs }
      )
      res.headers.set('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)))
      return res
    }

    const results = await searchReferences(db, auth, {
      query,
      entityType: parsed.data.type,
      // A grouped, all-modules search stays short per module; a single-type
      // search can afford to scroll deeper.
      limitPerType: parsed.data.type ? 12 : 4,
    })

    return successResponse({ types, results })
  } catch (error) {
    logRouteFailure('GET /api/chat/references', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const dynamic = 'force-dynamic'
