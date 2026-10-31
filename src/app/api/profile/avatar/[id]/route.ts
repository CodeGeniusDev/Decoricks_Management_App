import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import {
  avatarBytes,
  ensureAvatarIndexes,
  getAvatarCollection,
  isValidFileId,
} from '@/lib/models/Avatars'
import { notFoundError } from '@/lib/api-response'
import { handleRouteError, logRouteFailure, withAuth } from '@/lib/http'
import { requireAuth } from '@/lib/authorization'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * GET /api/profile/avatar/[id] — the stored bytes.
 *
 * Separated from the collection route because the security property that matters
 * here is different. Writes are safe by construction: they address
 * `auth.user._id` and never take a target from the request. This route DOES take
 * an identifier from the URL — somebody else's file id, pasted into an address
 * bar, is a perfectly ordinary request — so ownership is part of the query itself
 * rather than a check performed after fetching:
 *
 * ```
 * { _id: new ObjectId(id), userId: auth.user._id }
 * ```
 *
 * A document belonging to a colleague cannot match. The answer for "your id" and
 * for "somebody else's id" is the same 404, so the response cannot be used to
 * discover whether another member has a picture at all.
 *
 * A malformed id is answered the same way rather than with a 400: distinguishing
 * "not a valid id" from "not yours" would leak information for no benefit, and
 * nothing legitimate ever produces one — the URL is built from a stored id.
 *
 * `allowPasswordChange` is set on the read and not on the writes: an account
 * sitting on the change-password screen has no avatar UI to serve, but refusing a
 * picture for an account that is merely mid-password-reset would be a status the
 * client cannot act on, and reading one's own bytes is not the operation worth
 * gating.
 */
async function __GET(_request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireAuth({ allowPasswordChange: true })
    const { id } = await context.params
    if (!isValidFileId(id)) return notFoundError('Profile picture not found')

    const db = await getDatabase()
    await ensureAvatarIndexes(db)

    const doc = await getAvatarCollection(db).findOne({
      _id: new ObjectId(id),
      userId: auth.user._id as ObjectId,
    } as never)
    if (!doc) return notFoundError('Profile picture not found')

    /*
     * `immutable` is honest because the URL contains the file id and every
     * replacement mints a new one: two identical URLs can never name two
     * different images, so a cached copy cannot be stale. `private` keeps it out
     * of any shared cache — the bytes are one person's face.
     *
     * The content type is the value that was SNIFFED from the bytes when they
     * were stored, never whatever the uploader's browser claimed in the part
     * header, which is what keeps `X-Content-Type-Options: nosniff` (set for
     * every route in next.config) from being a hazard rather than a protection.
     */
    const bytes = avatarBytes(doc)
    return new NextResponse(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': doc.contentType,
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  } catch (error) {
    logRouteFailure('GET /api/profile/avatar/[id]', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
