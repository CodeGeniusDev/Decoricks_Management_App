/**
 * Phase 6 API route tests.
 *
 * Runs the REAL move + comment handlers against `helpers/mem-mongo`. These
 * lock the two guarantees the brief calls out for this phase and that no other
 * suite touches:
 *
 *   • optimistic concurrency — a stale `version` on the move route returns 409
 *     carrying the current card, and a successful move into the done column
 *     sets `completedAt` + writes both activity entries in one version bump;
 *   • the comment edit window — the author may edit only inside the resolved
 *     window, the Founder (tasks.editOthers) may moderate at any time, a
 *     soft-delete redacts the body, and acting on an already-deleted comment
 *     is 410 Gone.
 *
 * `@/lib/authorization` is mocked permissively by `src/test/setup.ts`; the
 * suites re-arm `authorize`/`requireAuth` in `beforeEach` so a leftover
 * implementation from one test can never poison the next (Vitest 2 `mockReset`
 * clears the implementation too).
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { ObjectId } from 'mongodb'
import { authorize, requireAuth } from '@/lib/authorization'
import { createMemDb, type MemDb } from './helpers/mem-mongo'

let mem: MemDb

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => mem.handle),
  getMongoClient: vi.fn(async () => mem.client),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

import * as moveRoute from '@/app/api/tasks/[id]/move/route'
import * as commentsRoute from '@/app/api/tasks/[id]/comments/route'
import * as commentDetailRoute from '@/app/api/tasks/[id]/comments/[commentId]/route'

/* -------------------------------- ids ------------------------------------ */

const FOUNDER = new ObjectId('507f1f77bcf86cd799439011')
const MEMBER = new ObjectId('507f1f77bcf86cd7994390aa')
const BOARD_ID = new ObjectId('507f1f77bcf86cd799439200')
const COL_TODO = new ObjectId('507f1f77bcf86cd799439201')
const COL_DONE = new ObjectId('507f1f77bcf86cd799439202')

/* ------------------------------ auth helpers ----------------------------- */

const ctxFor = (userId: ObjectId, opts: { editOthers?: boolean } = {}) => ({
  user: {
    _id: userId,
    email: `${userId.toString()}@decoricks.com`,
    name: 'Test Actor',
    role: opts.editOthers ? 'founder' : 'partner',
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 1,
  },
  session: { tokenHash: 'h', sessionVersion: 1, csrfToken: 'c', role: 'role' },
  role: {
    name: 'role',
    displayName: 'Role',
    permissions: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  permissions: {
    tasks: { view: true, edit: true, comment: true, editOthers: opts.editOthers === true },
  },
})

/** Sets the identity + moderation flag the mocked `authorize` hands back. */
const asActor = (userId: ObjectId, editOthers = false) => {
  ;(authorize as Mock).mockReset().mockImplementation(async () => ctxFor(userId, { editOthers }))
  ;(requireAuth as Mock).mockReset().mockImplementation(async () => ctxFor(userId, { editOthers }))
}

/* ------------------------------- seeding --------------------------------- */

const seedColumns = () => {
  mem
    .collection('columns')
    .push(
      {
        _id: COL_TODO,
        boardId: BOARD_ID,
        name: 'To Do',
        position: 1,
        isDoneColumn: false,
        isArchived: false,
        createdBy: FOUNDER,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: COL_DONE,
        boardId: BOARD_ID,
        name: 'Done',
        position: 2,
        isDoneColumn: true,
        isArchived: false,
        createdBy: FOUNDER,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    )
}

const seedTask = (over: Record<string, unknown> = {}): ObjectId => {
  const _id = (over._id as ObjectId) ?? new ObjectId()
  mem.collection('tasks').push({
    _id,
    taskNumber: 'TASK-202610-0001',
    boardId: BOARD_ID,
    columnId: COL_TODO,
    position: 1024,
    title: 'Seed task',
    assigneeIds: [],
    priority: 'medium',
    dueDate: null,
    labelIds: [],
    checklist: [],
    completedAt: null,
    completedBy: null,
    version: 1,
    isArchived: false,
    archivedAt: null,
    createdBy: FOUNDER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  })
  return _id
}

const seedComment = (over: Record<string, unknown>): ObjectId => {
  const _id = (over._id as ObjectId) ?? new ObjectId()
  mem.collection('taskComments').push({
    _id,
    taskId: over.taskId ?? new ObjectId(),
    authorId: MEMBER,
    body: 'original body',
    editedAt: null,
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  })
  return _id
}

/* ------------------------------ request kit ------------------------------ */

const makeRequest = (url: string, init?: RequestInit) => new Request(url, init) as never
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const patch = (body: unknown): RequestInit => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const del = (): RequestInit => ({ method: 'DELETE' })
const ctxTask = (id: string) => ({ params: Promise.resolve({ id }) }) as never
const ctxComment = (id: string, commentId: string) =>
  ({ params: Promise.resolve({ id, commentId }) }) as never

const taskDoc = (id: ObjectId) =>
  mem.collection('tasks').docs.find((d) => String(d._id) === String(id))!
const commentDoc = (id: ObjectId) =>
  mem.collection('taskComments').docs.find((d) => String(d._id) === String(id))!
const activityKinds = (taskId: ObjectId) =>
  mem
    .collection('taskActivity')
    .docs.filter((d) => String(d.taskId) === String(taskId))
    .map((d) => d.kind)

beforeEach(() => {
  asActor(FOUNDER, true)
  mem = createMemDb()
  seedColumns()
})

/* -------------------------------------------------------------------------- */
/*  Move route                                                                */
/* -------------------------------------------------------------------------- */

describe('POST /api/tasks/[id]/move', () => {
  it('returns 409 with the current card when the version is stale', async () => {
    const taskId = seedTask({ version: 1 })
    asActor(FOUNDER, true)

    const res = await moveRoute.POST(
      makeRequest(
        'http://localhost/api/tasks/x/move',
        json({ toColumnId: COL_DONE.toString(), version: 99 })
      ),
      ctxTask(taskId.toString())
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('task_version_conflict')
    expect(body.error.details.current.version).toBe(1)
    // Nothing mutated: the card never left its column or bumped version.
    expect(taskDoc(taskId).version).toBe(1)
    expect(String(taskDoc(taskId).columnId)).toBe(String(COL_TODO))
  })

  it('moves into the done column, sets completedAt and bumps the version', async () => {
    const taskId = seedTask({ version: 3 })
    asActor(FOUNDER, true)

    const res = await moveRoute.POST(
      makeRequest(
        'http://localhost/api/tasks/x/move',
        json({ toColumnId: COL_DONE.toString(), version: 3 })
      ),
      ctxTask(taskId.toString())
    )

    expect(res.status).toBe(200)
    const doc = taskDoc(taskId)
    expect(String(doc.columnId)).toBe(String(COL_DONE))
    expect(doc.version).toBe(4)
    expect(doc.completedAt).toBeInstanceOf(Date)
    expect(String(doc.completedBy)).toBe(String(FOUNDER))
    // Timeline shows both the physical move and the completion transition.
    expect(activityKinds(taskId)).toContain('moved')
    expect(activityKinds(taskId)).toContain('completed')
  })

  it('denies a Partner who neither created nor is assigned the card', async () => {
    const taskId = seedTask({ createdBy: FOUNDER, assigneeIds: [] })
    asActor(MEMBER, false)

    const res = await moveRoute.POST(
      makeRequest(
        'http://localhost/api/tasks/x/move',
        json({ toColumnId: COL_DONE.toString(), version: 1 })
      ),
      ctxTask(taskId.toString())
    )

    expect(res.status).toBe(403)
  })
})

/* -------------------------------------------------------------------------- */
/*  Comment thread + edit window                                              */
/* -------------------------------------------------------------------------- */

describe('POST /api/tasks/[id]/comments', () => {
  it('creates a comment and records a commented activity entry', async () => {
    const taskId = seedTask()
    asActor(MEMBER, false)

    const res = await commentsRoute.POST(
      makeRequest('http://localhost/api/tasks/x/comments', json({ body: 'Looks good to ship' })),
      ctxTask(taskId.toString())
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.body).toBe('Looks good to ship')
    expect(activityKinds(taskId)).toContain('commented')
  })

  it('404s when the task does not exist', async () => {
    asActor(MEMBER, false)
    const res = await commentsRoute.POST(
      makeRequest('http://localhost/api/tasks/x/comments', json({ body: 'orphan' })),
      ctxTask(new ObjectId().toString())
    )
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/tasks/[id]/comments/[commentId] — edit window', () => {
  it('lets the author edit inside the default 15-minute window', async () => {
    const taskId = seedTask()
    const postedAt = new Date()
    const commentId = seedComment({ taskId, authorId: MEMBER, createdAt: postedAt })
    asActor(MEMBER, false)

    const res = await commentDetailRoute.PATCH(
      makeRequest('http://localhost/api/tasks/x/comments/y', patch({ body: 'fixed a typo' })),
      ctxComment(taskId.toString(), commentId.toString())
    )

    expect(res.status).toBe(200)
    const doc = commentDoc(commentId)
    expect(doc.body).toBe('fixed a typo')
    expect(doc.editedAt).toBeInstanceOf(Date)
    // Edit-window clock never resets on edit.
    expect((doc.createdAt as Date).getTime()).toBe(postedAt.getTime())
  })

  it('blocks the author once the window has closed', async () => {
    const taskId = seedTask()
    const twentyMinAgo = new Date(Date.now() - 20 * 60_000)
    const commentId = seedComment({ taskId, authorId: MEMBER, createdAt: twentyMinAgo })
    asActor(MEMBER, false)

    const res = await commentDetailRoute.PATCH(
      makeRequest('http://localhost/api/tasks/x/comments/y', patch({ body: 'too late' })),
      ctxComment(taskId.toString(), commentId.toString())
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('COMMENT_WINDOW_CLOSED')
    expect(commentDoc(commentId).body).toBe('original body')
  })

  it('lets a Founder (editOthers) moderate a comment after the window closed', async () => {
    const taskId = seedTask()
    const twentyMinAgo = new Date(Date.now() - 20 * 60_000)
    const commentId = seedComment({ taskId, authorId: MEMBER, createdAt: twentyMinAgo })
    asActor(FOUNDER, true)

    const res = await commentDetailRoute.PATCH(
      makeRequest('http://localhost/api/tasks/x/comments/y', patch({ body: 'moderated' })),
      ctxComment(taskId.toString(), commentId.toString())
    )

    expect(res.status).toBe(200)
    expect(commentDoc(commentId).body).toBe('moderated')
  })
})

describe('DELETE /api/tasks/[id]/comments/[commentId] — soft delete', () => {
  it('soft-deletes, redacts the body on read, and 410s a second mutation', async () => {
    const taskId = seedTask()
    const commentId = seedComment({ taskId, authorId: MEMBER, createdAt: new Date() })
    asActor(MEMBER, false)

    const res = await commentDetailRoute.DELETE(
      makeRequest('http://localhost/api/tasks/x/comments/y', del()),
      ctxComment(taskId.toString(), commentId.toString())
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.isDeleted).toBe(true)
    expect(body.data.body).toBeNull() // redacted on serialisation
    expect(commentDoc(commentId).isDeleted).toBe(true) // row is only soft-deleted

    // Acting on an already-deleted comment is Gone, not a silent success.
    const again = await commentDetailRoute.DELETE(
      makeRequest('http://localhost/api/tasks/x/comments/y', del()),
      ctxComment(taskId.toString(), commentId.toString())
    )
    expect(again.status).toBe(410)
    const againBody = await again.json()
    expect(againBody.error.code).toBe('COMMENT_DELETED')
  })
})
