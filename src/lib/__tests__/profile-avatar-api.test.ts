/**
 * Authorization and storage contract for the profile-picture routes.
 *
 * `PUT/DELETE /api/profile/avatar` and `GET /api/profile/avatar/[id]` are the only
 * place in the app where a user writes a binary blob that is later served back into
 * other screens, so the properties locked here are the ones that make that safe:
 *
 *   1. WHOSE PICTURE IS NEVER CLIENT INPUT. Writes address `auth.user._id` and read
 *      bytes with `{ _id, userId }` in the same query. There is no body field, query
 *      parameter or route segment that names a subject, so a forged `userId` has
 *      nothing to influence and another member's file id is simply not a document
 *      the caller can reach.
 *   2. THE POINTER NEVER DANGLES. Upload inserts before it points and deletes after;
 *      removal unsets before it deletes. A user record therefore never names a
 *      picture that a request cannot fetch — which is also what `layout.spec.ts`
 *      would catch as a 404 on an `<img>` if the order were reversed.
 *   3. NOTHING ACCUMULATES. Every picture is one document owned by one user, and a
 *      replacement reclaims the document it replaced, including garbage left by an
 *      interrupted upload.
 *   4. VALIDATION IS CONTENT, NOT CLAIM. The bytes decide the stored type; a part
 *      that disagrees with its own content is refused, and an oversized body is
 *      refused before it is buffered.
 *
 * The session is the permissive Founder from `src/test/setup.ts`; suites that need
 * a pointer, a different owner or no session at all override `requireAuth` for that
 * one test. The database is the shared in-memory fake (`./helpers/mem-mongo`).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { requireAuth, AuthenticationError } from '@/lib/authorization'
import { PUT as putAvatar, DELETE as deleteAvatar } from '@/app/api/profile/avatar/route'
import { GET as getAvatar } from '@/app/api/profile/avatar/[id]/route'
import { PATCH as patchUser } from '@/app/api/users/[id]/route'
import { MAX_IMAGE_BYTES } from '@/lib/image-signature'
import { avatarWriteLimiter } from '@/lib/rate-limit'
import { createMemDb, type MemDb, type Doc } from './helpers/mem-mongo'

let mem: MemDb

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => mem.handle),
  getMongoClient: vi.fn(async () => mem.client),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

/* --------------------------------- fixtures -------------------------------- */

// `requireAuth` (globally mocked) resolves to this Founder; it is "the caller".
const ME = new ObjectId('507f1f77bcf86cd799439011')
const OTHER = new ObjectId('507f1f77bcf86cd799439055')

/**
 * A real PNG from the repo's own assets. Using encoder output rather than a
 * hand-made buffer is what makes the happy path mean something: if the file the
 * app ships cannot be uploaded, the feature does not work.
 */
const PNG = new Uint8Array(
  readFileSync(path.join(process.cwd(), 'public', 'icons', 'icon-192.png'))
)

/** JPEG signature + APP0 + EOI: enough structure for the sniffer, tiny on purpose. */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
  0x00, 0x00, 0x41, 0x41, 0x41, 0x41, 0xff, 0xd9,
])

const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x14, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  0x08, 0x00, 0x00, 0x00, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
])

/** Points the mocked session at `userId`, optionally with avatar pointer fields. */
const signIn = (userId: ObjectId = ME, avatar: Doc = {}): void => {
  vi.mocked(requireAuth).mockImplementation(
    async () =>
      ({
        user: {
          _id: userId,
          email: 'founder@decoricks.com',
          name: 'Test Founder',
          role: 'founder',
          isActive: true,
          mustChangePassword: false,
          sessionVersion: 1,
          ...avatar,
        },
        session: {
          tokenHash: 'test-token-hash',
          sessionVersion: 1,
          csrfToken: 'test-csrf-token',
          role: 'founder',
        },
        role: {
          name: 'founder',
          displayName: 'Founder',
          permissions: {},
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
        permissions: {},
      }) as never
  )
}

const seedUser = (userId: ObjectId = ME, extra: Doc = {}): void => {
  mem.db.users.push({
    _id: userId,
    email: `${userId === ME ? 'founder' : 'partner'}@decoricks.com`,
    name: 'Seeded User',
    role: 'founder',
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 1,
    ...extra,
  })
}

const upload = (
  bytes: Uint8Array,
  options: { type?: string; filename?: string; headers?: Record<string, string> } = {}
): Promise<Response> => {
  const form = new FormData()
  form.append(
    'file',
    new Blob([bytes as BlobPart], { type: options.type ?? 'image/png' }),
    options.filename ?? 'picture.png'
  )
  return putAvatar(
    new Request('http://localhost/api/profile/avatar', {
      method: 'PUT',
      body: form,
      headers: options.headers,
    }) as never
  )
}

const remove = (): Promise<Response> => deleteAvatar()

/** Response envelope as the routes actually emit it. */
type Envelope = {
  success: boolean
  data?: Record<string, unknown>
  error?: { message: string; code?: string; details?: Record<string, unknown> }
}
const envelope = async (res: Response): Promise<Envelope> => (await res.json()) as Envelope

const avatarRows = (): Doc[] => mem.db.avatars.docs
const rowsOwnedBy = (userId: ObjectId): Doc[] =>
  avatarRows().filter((row) => String(row.userId) === userId.toString())
const userRow = (userId: ObjectId = ME): Doc =>
  mem.db.users.docs.find((row) => String(row._id) === userId.toString()) ?? {}
const auditActions = (): string[] => mem.db.auditLog.docs.map((row) => String(row.action))

beforeEach(() => {
  mem = createMemDb()
  signIn()
  seedUser()
  // The limiter is process-global and keyed by user; a suite that made thirty
  // writes would otherwise leave the next one testing the budget instead of the
  // route. Each test starts with a clean slate, exactly as separate users would.
  avatarWriteLimiter.release(`avatar:${ME}`)
  avatarWriteLimiter.release(`avatar:${OTHER}`)
})

afterEach(() => {
  vi.clearAllMocks()
})

/* ---------------------------------- PUT ----------------------------------- */

describe('PUT /api/profile/avatar stores the picture', () => {
  it('writes the bytes, points the user at them and answers with the URL', async () => {
    const res = await upload(PNG)
    expect(res.status).toBe(200)

    const body = await envelope(res)
    const user = body.data?.user as { avatarUrl?: string }
    const stored = rowsOwnedBy(ME)
    expect(stored).toHaveLength(1)
    expect(user.avatarUrl).toBe(`/api/profile/avatar/${stored[0]._id}`)

    expect(String(stored[0].userId)).toBe(ME.toString())
    expect(stored[0].contentType).toBe('image/png')
    expect(stored[0].sizeBytes).toBe(PNG.length)
    // The bytes are stored as they arrived, not re-encoded or truncated.
    expect(Array.from((stored[0].data as { value(): Uint8Array }).value())).toEqual(Array.from(PNG))
  })

  it('stores the type sniffed from the bytes, not the type the part claimed', async () => {
    // A JPEG sent with a `image/png` part header would be served back as a PNG —
    // a header that contradicts the content — so the mismatch is refused outright.
    const res = await upload(JPEG, { type: 'image/png' })
    expect(res.status).toBe(400)
    const body = await envelope(res)
    expect(body.error?.code).toBe('IMAGE_REJECTED')
    expect(body.error?.message).toContain('image/png')
    expect(body.error?.message).toContain('jpeg')
    expect(avatarRows()).toHaveLength(0)
  })

  it('accepts JPEG and WebP, recording what each one turned out to be', async () => {
    const jpeg = await upload(JPEG, { type: 'image/jpeg', filename: 'picture.jpg' })
    expect(jpeg.status).toBe(200)
    expect(rowsOwnedBy(ME)[0].contentType).toBe('image/jpeg')

    const webp = await upload(WEBP, { type: 'image/webp', filename: 'picture.webp' })
    expect(webp.status).toBe(200)
    expect(rowsOwnedBy(ME)[0].contentType).toBe('image/webp')
  })

  it('refuses a document that only claims to be an image and stores nothing', async () => {
    const res = await upload(new TextEncoder().encode('<svg onload="steal()"></svg>'), {
      type: 'image/svg+xml',
    })
    expect(res.status).toBe(400)
    const body = await envelope(res)
    expect(body.error?.code).toBe('IMAGE_REJECTED')
    expect(body.error?.message).toContain('JPEG, PNG and WebP')
    expect(avatarRows()).toHaveLength(0)
    expect(userRow().avatarFileId).toBeUndefined()
  })

  it('refuses a file over the limit after measuring the bytes', async () => {
    // A PNG frame — signature, IHDR header, closing IEND chunk — around a payload
    // one byte past the cap, so the refusal can only come from the measurement.
    const oversize = new Uint8Array(MAX_IMAGE_BYTES + 1)
    oversize.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    oversize.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
    oversize.set(
      [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82],
      oversize.length - 12
    )

    const res = await upload(oversize)
    expect(res.status).toBe(413)
    const body = await envelope(res)
    expect(body.error?.code).toBe('IMAGE_REJECTED')
    expect(body.error?.message).toContain('2 MB')
    expect(avatarRows()).toHaveLength(0)
  })

  it('refuses an enormous body from the Content-Length header, before parsing it', async () => {
    // The cap that holds is the byte measurement; this one exists so a 40 MB upload
    // is refused without the server buffering it to find out. A client CAN forge
    // the header, which is why the real check is still the bytes.
    const res = await upload(PNG, { headers: { 'content-length': String(40 * 1024 * 1024) } })
    expect(res.status).toBe(413)
    expect((await envelope(res)).error?.code).toBe('IMAGE_TOO_LARGE')
    expect(avatarRows()).toHaveLength(0)
  })

  it('refuses a request with no file part instead of storing an empty picture', async () => {
    const res = await putAvatar(
      new Request('http://localhost/api/profile/avatar', {
        method: 'PUT',
        body: new FormData(),
      }) as never
    )
    expect(res.status).toBe(400)
    expect((await envelope(res)).error?.code).toBe('NO_IMAGE')

    const notMultipart = await putAvatar(
      new Request('http://localhost/api/profile/avatar', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'data:image/png;base64,AAAA' }),
      }) as never
    )
    expect(notMultipart.status).toBe(400)
    expect(avatarRows()).toHaveLength(0)
  })

  it('401s before touching the database when there is no session', async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(new AuthenticationError())
    const res = await upload(PNG)
    expect(res.status).toBe(401)
    expect(avatarRows()).toHaveLength(0)
  })

  it('ignores a userId in the body — the session is the only subject', async () => {
    seedUser(OTHER)
    const form = new FormData()
    form.append('file', new Blob([PNG as BlobPart], { type: 'image/png' }), 'picture.png')
    form.append('userId', OTHER.toString())
    const res = await putAvatar(
      new Request('http://localhost/api/profile/avatar', { method: 'PUT', body: form }) as never
    )
    expect(res.status).toBe(200)
    // The picture is the caller's. The account named in the body gained nothing.
    expect(rowsOwnedBy(ME)).toHaveLength(1)
    expect(rowsOwnedBy(OTHER)).toHaveLength(0)
    expect(userRow(OTHER).avatarFileId).toBeUndefined()
  })
})

/* ------------------------------- replacement ------------------------------- */

describe('replacing a picture', () => {
  it('moves the pointer to the new document and reclaims the old one', async () => {
    const first = await upload(PNG)
    expect(first.status).toBe(200)
    const oldId = rowsOwnedBy(ME)[0]._id as ObjectId
    /*
     * The session user is the live document — `getAuthenticatedUser` $lookups it on
     * every request — so after the first upload the caller's own record is what
     * carries `avatarFileId`, and that is what makes the route log a REPLACEMENT
     * rather than a first upload. In this harness the session is mocked, so the
     * pointer is supplied the way the database would supply it.
     */
    signIn(ME, { avatarFileId: oldId })

    const second = await upload(JPEG, { type: 'image/jpeg', filename: 'p.jpg' })
    expect(second.status).toBe(200)
    const fresh = rowsOwnedBy(ME)
    expect(fresh).toHaveLength(1)
    expect(String(fresh[0]._id)).not.toBe(oldId.toString())
    expect(fresh[0].contentType).toBe('image/jpeg')
    expect(userRow().avatarFileId).toEqual(fresh[0]._id)

    const body = await envelope(second)
    const user = body.data?.user as { avatarUrl?: string }
    expect(user.avatarUrl).toBe(`/api/profile/avatar/${fresh[0]._id}`)
    // A new URL per picture is what lets the bytes be cached `immutable`.
    expect(user.avatarUrl).not.toBe(`/api/profile/avatar/${oldId}`)

    const entries = mem.db.auditLog.docs
    expect(entries.map((row) => row.action)).toEqual(['create_avatar', 'update_avatar'])
    const replacement = entries[1]
    expect((replacement.oldValue as Doc).avatarFileId).toBe(oldId.toString())
    expect((replacement.newValue as Doc).avatarFileId).toBe(String(fresh[0]._id))
    expect((replacement.newValue as Doc).contentType).toBe('image/jpeg')
    // The trail says a picture changed; it never stores the picture or its bytes.
    expect(JSON.stringify(replacement)).not.toContain('base64')
  })

  it('reclaims garbage from an interrupted upload', async () => {
    // A document with no pointer naming it: what a crashed request leaves behind.
    mem.db.avatars.push({
      _id: new ObjectId(),
      userId: ME,
      contentType: 'image/png',
      sizeBytes: 10,
      uploadedAt: new Date(0),
      data: { value: () => new Uint8Array(10) },
    })
    await upload(PNG)
    expect(rowsOwnedBy(ME)).toHaveLength(1)
  })

  it('never accumulates documents across repeated replacements', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await upload(PNG)).status).toBe(200)
    }
    expect(rowsOwnedBy(ME)).toHaveLength(1)
  })

  it('cannot reach another member picture', async () => {
    seedUser(OTHER)
    mem.db.avatars.push({
      _id: new ObjectId(),
      userId: OTHER,
      contentType: 'image/png',
      sizeBytes: PNG.length,
      uploadedAt: new Date(),
      data: { value: () => PNG },
    })
    const theirs = rowsOwnedBy(OTHER)[0]._id as ObjectId

    await upload(JPEG, { type: 'image/jpeg', filename: 'p.jpg' })

    // Their picture is still there, unchanged, and still theirs.
    expect(rowsOwnedBy(OTHER)).toHaveLength(1)
    expect(String(rowsOwnedBy(OTHER)[0]._id)).toBe(theirs.toString())
    expect(rowsOwnedBy(OTHER)[0].contentType).toBe('image/png')
    expect(rowsOwnedBy(ME)).toHaveLength(1)
  })
})

/* --------------------------------- GET ------------------------------------ */

describe('GET /api/profile/avatar/[id] serves bytes to the owner only', () => {
  const storeMine = async (): Promise<ObjectId> => {
    await upload(PNG)
    return rowsOwnedBy(ME)[0]._id as ObjectId
  }

  const get = async (id: string): Promise<Response> =>
    getAvatar(
      new Request(`http://localhost/api/profile/avatar/${id}`) as never,
      {
        params: Promise.resolve({ id }),
      } as never
    )

  it('returns the exact stored bytes with the sniffed type', async () => {
    const id = await storeMine()
    const res = await get(id.toString())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(PNG))
  })

  it('caches privately and immutably, because the URL changes with every picture', async () => {
    const id = await storeMine()
    const res = await get(id.toString())
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable')
  })

  it('404s for another member file id, with the same answer as one that does not exist', async () => {
    const id = await storeMine()
    vi.mocked(requireAuth).mockImplementation(
      async () =>
        ({
          user: {
            _id: OTHER,
            email: 'partner@decoricks.com',
            name: 'Partner',
            role: 'partner_ali',
          },
          session: {},
          role: { name: 'partner_ali', displayName: 'Partner', permissions: {} },
          permissions: {},
        }) as never
    )

    const stolen = await get(id.toString())
    const missing = await get(new ObjectId().toString())
    expect(stolen.status).toBe(404)
    expect(missing.status).toBe(404)
    /*
     * Identical bodies: the response cannot be used to discover whether a colleague
     * has a profile picture at all. `timestamp` is the one field excluded, and it is
     * excluded because it is not part of the claim: every response stamps the instant
     * it was written, so two perfectly correct answers differ whenever the calls fall
     * either side of a millisecond boundary. Comparing it made this test fail on the
     * clock — observed as `…15.573Z` against `…15.574Z` — which is a defect in the
     * assertion, not in the route.
     */
    const withoutTimestamp = (body: { timestamp?: unknown } & Record<string, unknown>) => {
      const { timestamp, ...rest } = body
      return rest
    }
    const stolenBody = await stolen.json()
    expect(withoutTimestamp(await missing.json())).toEqual(withoutTimestamp(stolenBody))
    expect(stolenBody.error?.message).toContain('Profile picture not found')
  })

  it('answers a cross-user probe with a JSON error, never with image bytes', async () => {
    const id = await storeMine()
    vi.mocked(requireAuth).mockImplementation(
      async () =>
        ({
          user: {
            _id: OTHER,
            email: 'partner@decoricks.com',
            name: 'Partner',
            role: 'partner_ali',
          },
          session: {},
          role: { name: 'partner_ali', displayName: 'Partner', permissions: {} },
          permissions: {},
        }) as never
    )
    const res = await get(id.toString())
    expect(res.headers.get('Content-Type')).toContain('application/json')
    const text = await res.text()
    expect(text).not.toContain(String(id))
    expect(text.includes(Buffer.from(PNG.subarray(0, 24)).toString('base64'))).toBe(false)
  })

  it('404s a malformed id rather than handing it to the database', async () => {
    for (const id of ['not-an-id', '../etc/passwd', '', '<script>', '0'.repeat(24)]) {
      const res = await get(id)
      expect(res.status, id).toBe(404)
    }
  })

  it('401s when there is no session', async () => {
    const id = await storeMine()
    vi.mocked(requireAuth).mockRejectedValueOnce(new AuthenticationError())
    expect((await get(id.toString())).status).toBe(401)
  })
})

/* -------------------------------- DELETE ---------------------------------- */

describe('DELETE /api/profile/avatar goes back to the initial', () => {
  /**
   * Uploads a picture and puts the resulting pointer on the session user, which is
   * what a live `getAuthenticatedUser` read would carry. `DELETE` decides from the
   * session record, not by re-reading the user, so a mocked session has to be as
   * current as a real one.
   */
  const withPicture = async (): Promise<ObjectId> => {
    await upload(PNG)
    const id = rowsOwnedBy(ME)[0]._id as ObjectId
    signIn(ME, { avatarFileId: id, avatarContentType: 'image/png', avatarSizeBytes: PNG.length })
    return id
  }

  it('clears the pointer and removes the document', async () => {
    await withPicture()
    const res = await remove()
    expect(res.status).toBe(200)

    const row = userRow()
    expect(row.avatarFileId).toBeUndefined()
    expect(row.avatarContentType).toBeUndefined()
    expect(row.avatarSizeBytes).toBeUndefined()
    expect(row.avatarUpdatedAt).toBeUndefined()
    expect(avatarRows()).toHaveLength(0)

    const body = await envelope(res)
    expect((body.data?.user as { avatarUrl?: string }).avatarUrl).toBeUndefined()
    expect(auditActions()).toContain('delete_avatar')
  })

  it('answers 404 when there is nothing to remove and deletes nothing', async () => {
    const res = await remove()
    expect(res.status).toBe(404)
    expect((await envelope(res)).error?.message).toContain('no profile picture')
    expect(avatarRows()).toHaveLength(0)
  })

  it('cannot remove another member picture by forging their id into the pointer', async () => {
    // The worst case this route can be handed: a user record that names somebody
    // else's document. Ownership is part of the delete filter, so the query matches
    // nothing and the colleague keeps their picture.
    seedUser(OTHER)
    mem.db.avatars.push({
      _id: new ObjectId(),
      userId: OTHER,
      contentType: 'image/png',
      sizeBytes: PNG.length,
      uploadedAt: new Date(),
      data: { value: () => PNG },
    })
    const theirs = rowsOwnedBy(OTHER)[0]._id as ObjectId
    signIn(ME, { avatarFileId: theirs })

    const res = await remove()
    expect(res.status).toBe(200)
    expect(rowsOwnedBy(OTHER)).toHaveLength(1)
    expect(userRow().avatarFileId).toBeUndefined()
  })

  it('401s when there is no session, and the picture survives', async () => {
    await withPicture()
    vi.mocked(requireAuth).mockRejectedValueOnce(new AuthenticationError())
    expect((await remove()).status).toBe(401)
    expect(avatarRows()).toHaveLength(1)
  })
})

/* ------------------------- failure leaves no half-state --------------------- */

describe('a failed upload leaves the current picture standing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('removes the orphan and keeps the old pointer when the user write fails', async () => {
    const first = await upload(PNG)
    expect(first.status).toBe(200)
    const oldId = rowsOwnedBy(ME)[0]._id as ObjectId

    // A database fault between "inserted the new bytes" and "moved the pointer".
    // Not a network error: those are answered 503 by design, and this is about the
    // unexpected kind.
    mem.db.users.updateOne = async () => {
      throw new Error('BSON field updatedAt is not writable in this schema')
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await upload(JPEG, { type: 'image/jpeg', filename: 'p.jpg' })
    expect(res.status).toBe(500)
    const body = await envelope(res)
    expect(body.error?.code).toBe('INTERNAL_ERROR')
    // No raw driver message, no connection detail — a trace id the user can quote.
    expect(body.error?.message).not.toContain('BSON')
    expect(JSON.stringify(body)).not.toMatch(/mongodb|E11000|objectId|stack/i)
    expect(body.error?.details).toHaveProperty('traceId')
    spy.mockRestore()

    // The user still has the picture they had, and the failed insert is gone.
    expect(String(userRow().avatarFileId)).toBe(oldId.toString())
    expect(rowsOwnedBy(ME)).toHaveLength(1)
    expect(String(rowsOwnedBy(ME)[0]._id)).toBe(oldId.toString())
  })
})

/* -------------------------------- rate limit -------------------------------- */

describe('the write budget is per user', () => {
  it('turns a loop of picture changes into a 429 instead of unlimited writes', async () => {
    const nobody = new ObjectId('507f1f77bcf86cd799439099')
    signIn(nobody)
    seedUser(nobody)

    for (let i = 0; i < 30; i += 1) {
      expect((await upload(PNG)).status).toBe(200)
    }

    const blocked = await upload(JPEG, { type: 'image/jpeg', filename: 'p.jpg' })
    expect(blocked.status).toBe(429)
    const body = await envelope(blocked)
    expect(body.error?.code).toBe('RATE_LIMITED')
    expect(body.error?.message).toMatch(/Try again in \d+ second/)

    // Removal spends from the same budget, and the refused write stored nothing.
    expect((await remove()).status).toBe(429)
    expect(rowsOwnedBy(nobody)).toHaveLength(1)

    // A colleague is untouched by it — this is the reason the key is the user.
    signIn(ME)
    seedUser(ME)
    expect((await upload(PNG)).status).toBe(200)
  })
})

/* ------------------------------ deactivation ------------------------------ */

describe('deactivating a member leaves their picture exactly as it was', () => {
  /*
   * What an account closing means for a stored picture. The app has no user
   * deletion anywhere — `PATCH /api/users/[id]` is the only mutation an account
   * receives and no route removes a user document — so there is no cascade to
   * write and none to forget. What the route DOES delete is the member's sessions,
   * and the picture has to survive that blast radius for two reasons: bytes
   * belonging to a person who might come back, and a pointer on a user document
   * that must never name a document which is gone.
   */
  it('revokes the sessions and reclaims nothing else', async () => {
    const partner = new ObjectId('507f1f77bcf86cd799439077')
    signIn(partner)
    seedUser(partner, { role: 'partner' })
    expect((await upload(PNG)).status).toBe(200)

    const pointer = String(userRow(partner).avatarFileId)
    const stored = rowsOwnedBy(partner)
    expect(stored).toHaveLength(1)

    // Two live sessions for the member about to be switched off.
    mem.db.sessions.push({ _id: new ObjectId(), userId: partner, tokenHash: 'one' })
    mem.db.sessions.push({ _id: new ObjectId(), userId: partner, tokenHash: 'two' })
    const other = new ObjectId()
    mem.db.sessions.push({ _id: new ObjectId(), userId: other, tokenHash: 'three' })

    const res = await patchUser(
      new Request(`http://localhost/api/users/${partner}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: false }),
        headers: { 'content-type': 'application/json' },
      }) as never,
      { params: Promise.resolve({ id: partner.toString() }) }
    )
    expect(res.status).toBe(200)

    // The sessions are the only thing that was deleted.
    expect(mem.db.sessions.docs.map((row) => String(row.tokenHash))).toEqual(['three'])

    // The picture is unreachable rather than gone: the read is owner-scoped and an
    // owner with no session cannot ask for it. The document and the pointer stay,
    // byte-identical, so a reactivation returns the member to exactly what they had.
    expect(String(userRow(partner).avatarFileId)).toBe(pointer)
    const after = rowsOwnedBy(partner)
    expect(after).toHaveLength(1)
    expect(Array.from((after[0].data as { value(): Uint8Array }).value())).toEqual(Array.from(PNG))

    // And the response the Founder sees still describes a real, resolvable picture.
    const body = await envelope(res)
    const user = body.data?.user as { avatarUrl?: string; isActive?: boolean }
    expect(user.isActive).toBe(false)
    expect(user.avatarUrl).toBe(`/api/profile/avatar/${pointer}`)
  })
})
