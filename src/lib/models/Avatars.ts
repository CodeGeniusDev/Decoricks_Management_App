import type { Binary as BinaryType, Collection, Db } from 'mongodb'
import { Binary, ObjectId } from 'mongodb'
import type { ImageContentType } from '@/lib/image-signature'
import { createIndexTolerant } from '@/lib/models/indexes'

/**
 * Profile pictures: one document per image in a dedicated `avatars` collection.
 *
 * Why a dedicated collection rather than GridFS or a base64 field on `users`:
 *
 *   - **Not GridFS.** GridFS splits a file into 255 KB chunks across two
 *     collections and makes replacement a delete-then-insert across both. Every
 *     picture here is bounded by `MAX_IMAGE_BYTES` (2 MB) — comfortably inside
 *     MongoDB's 16 MB document limit — so the chunk bookkeeping would be pure
 *     overhead: two collections to reason about, no streaming need, and a write
 *     path that could not be expressed as one atomic document swap.
 *   - **Not base64 on the user document.** A user row is read on every single
 *     request that checks the session. Inlining ~2.7 MB of base64 would put that
 *     payload on the hot path for the whole app, and base64 costs 33 % more
 *     storage on an Atlas M0 instance whose 512 MB budget already holds every
 *     financial record the business has. The bytes live here, fetched only when
 *     an `<img>` actually asks for them.
 *
 * The user document keeps only a reference and the small metadata needed to
 * render it (`avatarFileId`, `avatarContentType`, `avatarSizeBytes`,
 * `avatarUpdatedAt`), which is what makes the picture survive a logout, a
 * refresh, a different device and a redeploy: it is ordinary persisted database
 * state, not client state.
 *
 * Backup and restore need no registration here: `dumpDatabase` enumerates
 * `listCollections()` and round-trips through EJSON, which serialises BSON
 * Binary natively.
 */
export interface AvatarDoc {
  _id?: ObjectId
  /**
   * Owner. Enforced on READ as well as WRITE: a document belonging to somebody
   * else is not served, and not distinguished from one that does not exist.
   */
  userId: ObjectId
  /** The type sniffed from the bytes at upload time, never the client's claim. */
  contentType: ImageContentType
  sizeBytes: number
  uploadedAt: Date
  data: BinaryType
}

/**
 * The pointer fields stored on the user document. Declared here (rather than
 * importing `User`) so this module never depends on `models/User`, which depends
 * on it to build `avatarUrl`.
 */
export interface UserAvatarRef {
  avatarFileId?: ObjectId | string
}

/**
 * A file id is 24 hex characters. Everything reaching this point has come from
 * either a stored document or a URL segment, and the URL segment is used to build
 * a query — so it is validated before it is used rather than relying on MongoDB
 * to reject a malformed `ObjectId` with an opaque driver error.
 */
export const isValidFileId = (id: string): boolean => /^[0-9a-fA-F]{24}$/.test(id)

export const getAvatarCollection = (db: Db): Collection<AvatarDoc> =>
  db.collection<AvatarDoc>('avatars')

let avatarIndexesPromise: Promise<void> | null = null

/**
 * `{ userId: 1 }` is deliberately NOT unique. Replacing a picture inserts the
 * new document *before* the pointer moves and deletes the old one after, so two
 * documents for the same user exist for the length of one request — see
 * `src/app/api/profile/avatar/route.ts` for why that ordering is the only one
 * that never leaves the user's `avatarFileId` pointing at a document that is
 * already gone. A unique key would reject the replacement on every upload.
 */
export function ensureAvatarIndexes(db: Db): Promise<void> {
  if (!avatarIndexesPromise) {
    avatarIndexesPromise = (async () => {
      try {
        await createIndexTolerant(
          getAvatarCollection(db).createIndex({ userId: 1 }, { name: 'avatars_userId' })
        )
      } catch (error) {
        avatarIndexesPromise = null
        console.error('ensureAvatarIndexes failed:', error)
      }
    })()
  }
  return avatarIndexesPromise
}

/** Driver type for the `data` field, so route code never imports `Binary` ad hoc. */
export const toAvatarBinary = (bytes: Uint8Array): BinaryType => new Binary(bytes)

export const avatarBytes = (doc: AvatarDoc): Uint8Array => {
  const raw = doc.data as unknown as BinaryType
  return raw.value()
}

/**
 * The public path a picture is served from, or `undefined` when the user has no
 * picture — which is what makes the initial-based avatar the default rather than
 * a fallback the client has to remember to render.
 *
 * The file id is part of the URL, which doubles as the cache-buster: a replaced
 * picture gets a new id, therefore a new URL, therefore nothing to invalidate.
 * That is what lets the response be `immutable` — and why there is no `?v=`
 * query parameter to keep in sync.
 */
export const avatarUrlFor = (user: UserAvatarRef): string | undefined => {
  const id = user.avatarFileId
  if (!id) return undefined
  const serialised = typeof id === 'string' ? id : id.toString()
  if (!isValidFileId(serialised)) return undefined
  return `/api/profile/avatar/${serialised}`
}
