import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getUserCollection, userToJSON } from '@/lib/models/User'
import { ensureAvatarIndexes, getAvatarCollection, toAvatarBinary } from '@/lib/models/Avatars'
import {
  MAX_IMAGE_BYTES,
  MAX_MULTIPART_BODY_BYTES,
  declaredTypeMatches,
  inspectImage,
} from '@/lib/image-signature'
import { errorResponse, notFoundError, successResponse } from '@/lib/api-response'
import { HttpError, getRequestMeta, handleRouteError, logRouteFailure, withAuth } from '@/lib/http'
import { requireAuth } from '@/lib/authorization'
import { recordAuditEntry } from '@/lib/audit'
import { avatarWriteLimiter } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * The authenticated member's own profile picture.
 *
 * `PUT` stores a new one (or replaces the current one), `DELETE` removes it.
 * There is no `GET` here on purpose: the bytes are served from
 * `/api/profile/avatar/[id]`, where the file id in the path doubles as the cache
 * key. Putting them in the same handler would mean either losing that cache key
 * or accepting an id from a query string that the client also chose — and the
 * whole point of this route is that nothing about the target user comes from the
 * client.
 *
 * Which user owns the picture is decided from the SESSION, on every method
 * (`requireAuth` → `auth.user._id`). No body field, query parameter or header is
 * ever consulted to identify the subject, so there is nothing for a forged
 * `userId` to influence — the requirement that a member can only touch their own
 * picture is a property of the route rather than a check inside it.
 */

const RATE_KEY = (userId: ObjectId): string => `avatar:${userId.toString()}`

/**
 * The 429 an exhausted write budget is answered with. `retryAfterMs` comes from
 * the limiter rather than a fixed guess, so the message tells the truth about how
 * long the caller actually has to wait.
 */
const rateLimited = (retryAfterMs: number): HttpError => {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return new HttpError(
    `Too many profile-picture changes. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
    429,
    'RATE_LIMITED'
  )
}

/**
 * A `File` from a multipart body, read without trusting anything about it.
 *
 * Duck-typed on `Blob` rather than `instanceof File` because the global `File`
 * constructor is not guaranteed across every runtime this code is loaded into
 * (unit tests, edge-built bundles), while `Blob` has been a Node global for
 * longer than the engine range this project supports.
 */
const asUploadPart = (value: FormDataEntryValue | null): Blob | null => {
  if (!value || typeof value === 'string') return null
  return value instanceof Blob ? value : null
}

/** PUT /api/profile/avatar — multipart body with a single `file` part. */
async function __PUT(request: NextRequest) {
  try {
    const meta = await getRequestMeta()
    const auth = await requireAuth()
    const userId = auth.user._id as ObjectId

    const rate = avatarWriteLimiter.consume(RATE_KEY(userId))
    if (!rate.allowed) throw rateLimited(rate.retryAfterMs)

    /*
     * Rejected on the header before the body is read, so an enormous upload is
     * refused with a 413 rather than by buffering it and finding out afterwards.
     * A client CAN lie about `Content-Length`, and the real bytes are still
     * measured by `inspectImage` below — the cap that actually holds is that
     * second check; this one only saves the memory the parse would have used.
     */
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_MULTIPART_BODY_BYTES) {
      throw new HttpError(
        `Image is too large. The maximum size is ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`,
        413,
        'IMAGE_TOO_LARGE'
      )
    }

    let file: Blob | null = null
    try {
      const form = await request.formData()
      file = asUploadPart(form.get('file'))
    } catch {
      // A malformed or absent multipart body is a client mistake, not a fault.
      throw new HttpError('Choose an image file to upload.', 400, 'NO_IMAGE')
    }
    if (!file) throw new HttpError('Choose an image file to upload.', 400, 'NO_IMAGE')

    const bytes = new Uint8Array(await file.arrayBuffer())
    const inspection = inspectImage(bytes)
    if (!inspection.ok) {
      throw new HttpError(
        inspection.message,
        inspection.code === 'too_large' ? 413 : 400,
        'IMAGE_REJECTED'
      )
    }
    /*
     * The part's own MIME type is checked against what the bytes turned out to
     * be, but never used as the stored value. A `image/png` part that sniffs as
     * JPEG is a renamed file, and storing the claim would make the response
     * header disagree with the content forever.
     */
    if (!declaredTypeMatches(file.type, inspection.contentType)) {
      throw new HttpError(
        `That file says it is ${file.type}, but its contents are a ${inspection.contentType.replace('image/', '')} image.`,
        400,
        'IMAGE_REJECTED'
      )
    }

    const db = await getDatabase()
    await ensureAvatarIndexes(db)
    const avatars = getAvatarCollection(db)
    const now = new Date()

    const previousId = auth.user.avatarFileId instanceof ObjectId ? auth.user.avatarFileId : null

    /*
     * Insert → point → delete-previous. The order is the invariant.
     *
     * Deleting the old document FIRST would leave the user's `avatarFileId`
     * naming a document that no longer exists for the length of one request, and
     * any tab that loads in that window gets a 404 on an `<img>` — which the
     * dashboard/profile screen sweep in `src/e2e/layout.spec.ts` correctly treats
     * as a real fault. Inserting first means the worst case is one extra
     * unreferenced document, which is invisible to the user and reclaimed by the
     * sweep below.
     */
    const inserted = await avatars.insertOne({
      userId,
      contentType: inspection.contentType,
      sizeBytes: inspection.size,
      uploadedAt: now,
      data: toAvatarBinary(bytes),
    })

    try {
      /*
       * One `updateOne` carrying all four fields: `avatarFileId` and the metadata
       * describing it can only change together, so splitting them would create a
       * window where the app renders a JPEG as a PNG or reports a size that is
       * not the stored one.
       */
      await getUserCollection(db).updateOne(
        { _id: userId },
        {
          $set: {
            avatarFileId: inserted.insertedId,
            avatarContentType: inspection.contentType,
            avatarSizeBytes: inspection.size,
            avatarUpdatedAt: now,
            updatedAt: now,
          },
        }
      )
    } catch (error) {
      // The pointer never moved, so the user keeps the picture they had. Drop
      // the orphan the same way the sweep below would, and surface the failure.
      await avatars.deleteOne({ _id: inserted.insertedId, userId } as never)
      throw error
    }

    /*
     * Reclaims both the document just replaced and anything left behind by an
     * interrupted upload: every document owned by this user that is not the one
     * now pointed at. `deleteOne` rather than `deleteMany` because at most one
     * stale document can exist per replacement, so one deletion per upload keeps
     * the count from ever growing — without a sweep that could reach into a
     * document some other request is mid-way through creating.
     */
    await avatars.deleteOne({
      userId,
      _id: { $ne: inserted.insertedId },
    } as never)

    await recordAuditEntry(db, {
      userId,
      userEmail: auth.user.email,
      action: previousId ? 'update_avatar' : 'create_avatar',
      entityType: 'user',
      entityId: userId,
      oldValue: previousId ? { avatarFileId: previousId.toString() } : undefined,
      newValue: {
        avatarFileId: inserted.insertedId.toString(),
        contentType: inspection.contentType,
        sizeBytes: inspection.size,
      },
      details: `Profile picture ${previousId ? 'replaced' : 'uploaded'} (${inspection.contentType}, ${inspection.size} bytes)`,
      outcome: 'success',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    const updated = await getUserCollection(db).findOne({ _id: userId } as never)
    return successResponse({
      user: updated ? userToJSON(updated) : { ...userToJSON(auth.user), avatarUrl: undefined },
    })
  } catch (error) {
    logRouteFailure('PUT /api/profile/avatar', error)
    return handleRouteError(error)
  }
}

/** DELETE /api/profile/avatar — back to the initial-based avatar. */
async function __DELETE() {
  try {
    const meta = await getRequestMeta()
    const auth = await requireAuth()
    const userId = auth.user._id as ObjectId

    const rate = avatarWriteLimiter.consume(RATE_KEY(userId))
    if (!rate.allowed) throw rateLimited(rate.retryAfterMs)

    const currentId = auth.user.avatarFileId
    if (!(currentId instanceof ObjectId)) {
      return notFoundError('There is no profile picture to remove.')
    }

    const db = await getDatabase()
    const now = new Date()

    /*
     * The pointer is cleared BEFORE the document is removed — the same reason the
     * upload inserts first: there must never be a moment where the user record
     * names a picture that a request can no longer fetch.
     */
    await getUserCollection(db).updateOne(
      { _id: userId },
      {
        $unset: {
          avatarFileId: '',
          avatarContentType: '',
          avatarSizeBytes: '',
          avatarUpdatedAt: '',
        },
        $set: { updatedAt: now },
      }
    )

    await getAvatarCollection(db).deleteOne({ _id: currentId, userId } as never)

    await recordAuditEntry(db, {
      userId,
      userEmail: auth.user.email,
      action: 'delete_avatar',
      entityType: 'user',
      entityId: userId,
      oldValue: { avatarFileId: currentId.toString() },
      details: 'Profile picture removed',
      outcome: 'success',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse({ user: { ...userToJSON(auth.user), avatarUrl: undefined } })
  } catch (error) {
    logRouteFailure('DELETE /api/profile/avatar', error)
    return handleRouteError(error)
  }
}

export const PUT = withAuth(__PUT)
export const DELETE = withAuth(__DELETE)
