import { ObjectId, type Collection, type Db, type WithId } from 'mongodb'
import {
  POSITION_GAP,
  getBoardCollection,
  getColumnCollection,
  getTaskActivityCollection,
  getTaskDocCollection,
  type Board,
  type Column,
  type TaskActivityKind,
  type TaskDoc,
} from '@/lib/models/Tasks'

/**
 * Server-side helpers for the Phase 6 task board (SPEC §3.1.15, §6.6).
 *
 * Only three things need to be exactly right here and nowhere else:
 *
 *   1. Positions stay monotonic per column even under interleaved inserts,
 *      with occasional rebalancing when the gap between two neighbours
 *      collapses.
 *   2. A version mismatch is refused — the loser of a drag race gets a
 *      409 with the current document so the UI can show it and refresh,
 *      never a silent overwrite.
 *   3. `completedAt`/`completedBy` follow the board's done column. Users
 *      never type those fields; they set themselves as a card moves in and
 *      clear themselves as it moves out, and every transition writes an
 *      activity entry (created / moved / completed / reopened / archived / …).
 */

/* ------------------------------- Conflict -------------------------------- */

export class TaskVersionConflictError extends Error {
  readonly status = 409
  readonly code = 'task_version_conflict'
  constructor(public readonly current: WithId<TaskDoc>) {
    super('Someone moved or edited this task. Refreshed.')
    this.name = 'TaskVersionConflictError'
  }
}

/* ------------------------------- Positions ------------------------------- */

/**
 * Position between two adjacent tasks. Sparse gaps of `POSITION_GAP` mean
 * inserting between A and B only ever writes one document (the new one gets
 * the midpoint). When neighbours are already 1 apart we renumber the column
 * (see `renumberColumnIfTight`).
 *
 * Passing `before=null, after=lastPos`  → append at end.
 * Passing `before=firstPos, after=null` → prepend at top.
 * Passing both null                     → first card in an empty column.
 */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return POSITION_GAP
  if (before === null) return (after as number) / 2
  if (after === null) return before + POSITION_GAP
  return Math.floor((before + after) / 2)
}

/** Returns a new position for a card being dropped after `afterTaskId` in a column. */
export async function computePosition(
  col: Collection<TaskDoc>,
  columnId: ObjectId,
  afterTaskId: ObjectId | null | undefined,
  excludeTaskId?: ObjectId
): Promise<number> {
  // Ordered ascending; skip the card we're moving so it doesn't count itself.
  const siblings = await col
    .find({ columnId, isArchived: false } as never)
    .sort({ position: 1 })
    .toArray()

  const others = excludeTaskId ? siblings.filter((s) => !s._id.equals(excludeTaskId)) : siblings

  if (others.length === 0) return POSITION_GAP

  if (afterTaskId === null || afterTaskId === undefined) {
    // Move to top: half of the current first position.
    return Math.max(1, Math.floor(others[0].position / 2))
  }

  const idx = others.findIndex((s) => s._id.equals(afterTaskId))
  if (idx === -1) throw new Error(`afterTaskId ${afterTaskId.toString()} not in column`)

  const before = others[idx].position
  const after = idx + 1 < others.length ? others[idx + 1].position : null
  return positionBetween(before, after)
}

/**
 * If two adjacent cards in a column have positions 1 apart, the next insert
 * between them has nowhere to go. Spread them back out to POSITION_GAP steps.
 * Called lazily after computing a position, never on read.
 */
export async function renumberColumnIfTight(db: Db, columnId: ObjectId): Promise<void> {
  const col = getTaskDocCollection(db)
  const all = await col
    .find({ columnId } as never)
    .sort({ position: 1 })
    .toArray()
  for (let i = 0; i < all.length - 1; i++) {
    if (all[i + 1].position - all[i].position < 2) {
      const bulk = col.initializeUnorderedBulkOp()
      all.forEach((doc, index) => {
        bulk.find({ _id: doc._id }).updateOne({ $set: { position: (index + 1) * POSITION_GAP } })
      })
      await bulk.execute()
      return
    }
  }
}

/* -------------------------------- Activity ------------------------------- */

/**
 * Append a single activity entry. Errors from this path are logged but never
 * rethrown: an activity write must not fail the mutation the user performed,
 * but the failure is loud enough that we notice it in the console and in the
 * audit log the caller writes separately.
 */
export async function recordTaskActivity(
  db: Db,
  input: {
    taskId: ObjectId
    actorId: ObjectId
    kind: TaskActivityKind
    changes?: Record<string, unknown>
  }
): Promise<void> {
  try {
    await getTaskActivityCollection(db).insertOne({
      taskId: input.taskId,
      actorId: input.actorId,
      kind: input.kind,
      changes: input.changes,
      at: new Date(),
    } as never)
  } catch (error) {
    console.error('recordTaskActivity failed:', error)
  }
}

/* ------------------------------- Versioning ------------------------------ */

/**
 * Bump-and-write with optimistic concurrency.
 *
 * The find-and-modify is atomic (single-document). If the stored version is
 * not `expected`, the update matches zero documents and we throw the conflict
 * carrying the current document so the API route can serialise a 409 body.
 *
 * `$set` is the caller's already-built payload; the helper merges in
 * `version: expected + 1` and `updatedAt` so no route has to remember them.
 */
export async function writeTaskWithVersion(
  db: Db,
  taskId: ObjectId,
  expectedVersion: number,
  set: Partial<Omit<TaskDoc, '_id' | 'version' | 'createdAt' | 'createdBy'>>
): Promise<WithId<TaskDoc>> {
  const col = getTaskDocCollection(db)
  const now = new Date()
  const updated = await col.findOneAndUpdate(
    { _id: taskId, version: expectedVersion } as never,
    { $set: { ...set, version: expectedVersion + 1, updatedAt: now } } as never,
    { returnDocument: 'after' }
  )
  if (updated) return updated as WithId<TaskDoc>

  const current = await col.findOne({ _id: taskId } as never)
  if (!current) throw new Error(`Task ${taskId.toString()} not found`)
  throw new TaskVersionConflictError(current as WithId<TaskDoc>)
}

/* ------------------------- Completion transitions ------------------------ */

/**
 * Given the two columns the card is moving between, decide whether this is a
 * completion, a reopen, or a normal move. Returns the extra fields to $set
 * and the activity kind to record.
 *
 *   into done   → completedAt = now, completedBy = actorId, kind = 'completed'
 *   out of done → completedAt = null, completedBy = null, kind = 'reopened'
 *   otherwise   → kind = 'moved', no completion-field changes
 *
 * A `moved` activity entry is written unconditionally so the timeline shows
 * every column change; the completed / reopened entries are additional.
 */
export function describeMove(
  from: Column | null,
  to: Column,
  actorId: ObjectId
): {
  set: Partial<Pick<TaskDoc, 'completedAt' | 'completedBy'>>
  activityKind: 'completed' | 'reopened' | 'moved'
} {
  const wasDone = from?.isDoneColumn === true
  const isDone = to.isDoneColumn === true

  if (!wasDone && isDone) {
    return {
      set: { completedAt: new Date(), completedBy: actorId },
      activityKind: 'completed',
    }
  }
  if (wasDone && !isDone) {
    return { set: { completedAt: null, completedBy: null }, activityKind: 'reopened' }
  }
  return { set: {}, activityKind: 'moved' }
}

/* ------------------------------ Overdue math ----------------------------- */

/**
 * Karachi-midnight-aware overdue cutoff. "Past due" means the task's
 * `dueDate` (Karachi day) is strictly before today in Karachi. So a card
 * due TODAY is not yet overdue even at 23:59 Karachi; it becomes overdue at
 * 00:00 Karachi tomorrow. Callers that need due-soon (24–72h) can use
 * `computeDueWindowKarachi` and inspect the end boundary.
 *
 * Implemented with `Intl.DateTimeFormat` directly on the passed instant so a
 * test can inject a specific "now" (the existing `getKarachiDate()` reads the
 * wall clock and is not testable).
 */
function karachiYMD(now: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10)
  return { y: get('year'), m: get('month'), d: get('day') }
}

/**
 * Returns the UTC instant that marks the START of "today, Karachi". A task
 * is overdue iff its `dueDate` is set and strictly less than this instant.
 */
export function overdueCutoffKarachiMidnight(now = new Date()): Date {
  const { y, m, d } = karachiYMD(now)
  return new Date(Date.UTC(y, m - 1, d))
}

/**
 * The [from, to] UTC range covering Karachi days `fromDay .. toDay`
 * inclusive, for a `YYYY-MM-DD` string pair. Used by the list filter and by
 * the Phase 9 notification feed later (both share the same definition).
 */
export function karachiDayRange(fromDay: string, toDay: string): { start: Date; end: Date } {
  const [fy, fm, fd] = fromDay.split('-').map(Number)
  const [ty, tm, td] = toDay.split('-').map(Number)
  const start = new Date(Date.UTC(fy, fm - 1, fd))
  // Karachi "day end" for UTC comparison: the instant Karachi midnight starts
  // the NEXT day. Equivalent to +24h at the day granularity.
  const end = new Date(Date.UTC(ty, tm - 1, td) + 24 * 60 * 60 * 1000 - 1)
  return { start, end }
}

/* --------------------------- Default columns ----------------------------- */

/**
 * SPEC §3.1.15.2: the default board ships with To Do / In Progress / Review /
 * Done. The last one is the done column. Used by the board create route so
 * the exact spelling is not duplicated across files.
 */
export const DEFAULT_BOARD_COLUMNS = [
  { name: 'To Do', isDoneColumn: false },
  { name: 'In Progress', isDoneColumn: false },
  { name: 'Review', isDoneColumn: false },
  { name: 'Done', isDoneColumn: true },
]

/** Board-creation helper: writes the board plus its default columns. */
export async function createBoardWithDefaults(
  db: Db,
  input: { name: string; description?: string; createdBy: ObjectId; idempotencyKey?: string }
): Promise<WithId<Board>> {
  const now = new Date()
  const boardDoc: Omit<Board, '_id'> = {
    name: input.name,
    description: input.description,
    isActive: true,
    archivedAt: null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  } as never

  const inserted = await getBoardCollection(db).insertOne(boardDoc as never)
  const boardId = inserted.insertedId as ObjectId

  const columns = DEFAULT_BOARD_COLUMNS.map((c, i) => ({
    boardId,
    name: c.name,
    position: (i + 1) * POSITION_GAP,
    isDoneColumn: c.isDoneColumn,
    isArchived: false,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  }))
  await getColumnCollection(db).insertMany(columns as never)

  return { _id: boardId, ...boardDoc } as WithId<Board>
}

/* ------------------------------ Task numbers ----------------------------- */

/**
 * Builds `TASK-YYYYMM-NNNN` from the highest existing number in the current
 * month, retrying on collision (a concurrent insert between our read and our
 * write). The unique-sparse index on `taskNumber` catches the race; the route
 * layer surfaces a duplicate as a 409 so the caller can retry with a fresh
 * idempotency key.
 */
export async function createTaskNumber(col: Collection<TaskDoc>): Promise<string> {
  const now = new Date()
  const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const prefix = `TASK-${ym}`

  for (let attempt = 0; attempt < 5; attempt++) {
    const highest = await col
      .find({ taskNumber: { $regex: `^${prefix}-` } } as never)
      .sort({ taskNumber: -1 })
      .limit(1)
      .toArray()
    const last = highest[0]?.taskNumber
    const seq = last ? parseInt(last.slice(prefix.length + 1), 10) + 1 : 1
    const candidate = `${prefix}-${String(seq).padStart(4, '0')}`
    if (!(await col.findOne({ taskNumber: candidate } as never))) return candidate
  }
  throw new Error('Could not allocate a unique task number')
}
