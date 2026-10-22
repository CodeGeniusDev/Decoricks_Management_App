import { Db, Collection, ObjectId } from 'mongodb'
import { createIndexTolerant } from './indexes'

/**
 * Phase 6 task-board core documents (SPEC §3.1.15.1–.6).
 *
 * Five collections now describe the board:
 *
 *   - `boards`       — top-level container, Founder-managed.
 *   - `columns`      — ordered stages within a board; one is `isDoneColumn`.
 *   - `tasks`        — cards. Belong to a (board, column) pair. Versioned so
 *                      two people cannot drag the same card into different
 *                      slots and both "win" silently.
 *   - `taskComments` — thread per card, author-only edit within a window.
 *   - `taskActivity` — append-only audit trail (created / assigned / moved /
 *                      completed / reopened / commented / archived / edited).
 *   - `taskLabels`   — small archive of tag chips referenced by `labelIds`.
 *
 * Nothing here is ever hard-deleted: `isArchived` / `archivedAt` / `isDeleted`
 * are the only removals. Task moves increment `version`; the API rejects with
 * 409 when a client sends a stale one. The board's done column drives
 * `completedAt`/`completedBy` — those fields are never typed by the user.
 *
 * Positions use sparse gaps (POSITION_GAP = 1024) so an insert-between-two
 * cards rewrites only one document; a full column renumber is reserved for
 * the (very rare) case where adjacent gaps collapse below 1.
 */

/** Distance between two adjacent positions in a column. */
export const POSITION_GAP = 1024

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'

export const TASK_PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent']

export type TaskActivityKind =
  'created' | 'assigned' | 'moved' | 'completed' | 'reopened' | 'commented' | 'archived' | 'edited'

export const TASK_ACTIVITY_KINDS: TaskActivityKind[] = [
  'created',
  'assigned',
  'moved',
  'completed',
  'reopened',
  'commented',
  'archived',
  'edited',
]

/* --------------------------------- boards --------------------------------- */

export interface Board {
  _id?: ObjectId
  name: string
  description?: string
  createdBy?: ObjectId
  isActive: boolean
  archivedAt?: Date | null
  idempotencyKey?: string
  createdAt: Date
  updatedAt: Date
}

export const getBoardCollection = (db: Db): Collection<Board> => db.collection<Board>('boards')

export const boardToJSON = (b: Board) => ({
  _id: b._id?.toString(),
  name: b.name,
  description: b.description,
  isActive: b.isActive,
  archivedAt: b.archivedAt ?? null,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
  createdBy: b.createdBy?.toString() ?? null,
})

/* --------------------------------- columns -------------------------------- */

export interface Column {
  _id?: ObjectId
  boardId: ObjectId
  name: string
  /** Sparse ordinal. Two adjacent cards can be swapped without touching others. */
  position: number
  /** Exactly one column per board is the done column; drives completedAt. */
  isDoneColumn: boolean
  isArchived: boolean
  createdBy: ObjectId
  createdAt: Date
  updatedAt: Date
}

export const getColumnCollection = (db: Db): Collection<Column> => db.collection<Column>('columns')

export const columnToJSON = (c: Column) => ({
  _id: c._id?.toString(),
  boardId: c.boardId.toString(),
  name: c.name,
  position: c.position,
  isDoneColumn: c.isDoneColumn,
  isArchived: c.isArchived,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
})

/* ---------------------------------- tasks --------------------------------- */

export interface ChecklistItem {
  _id?: ObjectId
  text: string
  isDone: boolean
  doneAt?: Date | null
  doneBy?: ObjectId | null
}

export interface TaskDoc {
  _id?: ObjectId
  taskNumber?: string
  boardId: ObjectId
  columnId: ObjectId
  /** Sparse ordinal within the column. Independent of the column's own position. */
  position: number
  title: string
  description?: string
  /** References `users._id`. Empty array = unassigned. */
  assigneeIds: ObjectId[]
  /**
   * Legacy Phase 2 single-assignee role label. Read-only for existing
   * documents; migration scripts populate `assigneeIds` from this value.
   * New writes never touch it. Retained for the historical record only.
   */
  assigneeName?: string
  priority: TaskPriority
  dueDate?: Date | null
  labelIds: ObjectId[]
  checklist: ChecklistItem[]
  /** Set only when the card sits in the board's `isDoneColumn`. */
  completedAt?: Date | null
  completedBy?: ObjectId | null
  /** Optimistic concurrency token. Every server-accepted write bumps it. */
  version: number
  isArchived: boolean
  archivedAt?: Date | null
  /** Client-generated; unique when present. Prevents duplicate creates. */
  idempotencyKey?: string
  createdBy: ObjectId
  createdAt: Date
  updatedAt: Date
}

export const getTaskDocCollection = (db: Db): Collection<TaskDoc> => db.collection<TaskDoc>('tasks')

export const taskToJSON = (t: TaskDoc) => ({
  _id: t._id?.toString(),
  taskNumber: t.taskNumber,
  boardId: t.boardId.toString(),
  columnId: t.columnId.toString(),
  position: t.position,
  title: t.title,
  description: t.description,
  assigneeIds: t.assigneeIds.map((a) => a.toString()),
  assigneeName: t.assigneeName,
  priority: t.priority,
  dueDate: t.dueDate ?? null,
  labelIds: t.labelIds.map((l) => l.toString()),
  checklist: (t.checklist ?? []).map((c) => ({
    _id: c._id?.toString(),
    text: c.text,
    isDone: c.isDone,
    doneAt: c.doneAt ?? null,
    doneBy: c.doneBy?.toString() ?? null,
  })),
  completedAt: t.completedAt ?? null,
  completedBy: t.completedBy?.toString() ?? null,
  version: t.version,
  isArchived: t.isArchived,
  archivedAt: t.archivedAt ?? null,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  createdBy: t.createdBy.toString(),
})

/* ------------------------------ taskComments ------------------------------ */

export interface TaskComment {
  _id?: ObjectId
  taskId: ObjectId
  authorId: ObjectId
  body: string
  editedAt?: Date | null
  isDeleted: boolean
  deletedAt?: Date | null
  deletedBy?: ObjectId | null
  createdAt: Date
  updatedAt: Date
}

export const getTaskCommentCollection = (db: Db): Collection<TaskComment> =>
  db.collection<TaskComment>('taskComments')

export const taskCommentToJSON = (c: TaskComment) => ({
  _id: c._id?.toString(),
  taskId: c.taskId.toString(),
  authorId: c.authorId.toString(),
  body: c.isDeleted ? null : c.body,
  editedAt: c.editedAt ?? null,
  isDeleted: c.isDeleted,
  deletedAt: c.deletedAt ?? null,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
})

/* ------------------------------ taskActivity ------------------------------ */

export interface TaskActivityEntry {
  _id?: ObjectId
  taskId: ObjectId
  actorId: ObjectId
  kind: TaskActivityKind
  changes?: Record<string, unknown>
  at: Date
}

export const getTaskActivityCollection = (db: Db): Collection<TaskActivityEntry> =>
  db.collection<TaskActivityEntry>('taskActivity')

export const taskActivityToJSON = (a: TaskActivityEntry) => ({
  _id: a._id?.toString(),
  taskId: a.taskId.toString(),
  actorId: a.actorId.toString(),
  kind: a.kind,
  changes: a.changes,
  at: a.at,
})

/* ------------------------------- taskLabels ------------------------------- */

export interface TaskLabel {
  _id?: ObjectId
  name: string
  /** Brand hex, e.g. "#0EA5E9". No gradients, no arbitrary CSS. */
  color: string
  isActive: boolean
  createdBy: ObjectId
  createdAt: Date
  updatedAt: Date
}

export const getTaskLabelCollection = (db: Db): Collection<TaskLabel> =>
  db.collection<TaskLabel>('taskLabels')

export const taskLabelToJSON = (l: TaskLabel) => ({
  _id: l._id?.toString(),
  name: l.name,
  color: l.color,
  isActive: l.isActive,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
})

/* -------------------------------- indexes --------------------------------- */

let taskIndexesPromise: Promise<void> | null = null

/**
 * Idempotent per-process. Failures are logged rather than thrown so read-only
 * deployments (and read paths during a permissions hiccups) keep working —
 * matches the ensureInventoryIndexes convention.
 *
 * Each index is ensured through `createIndexTolerant` (see `./indexes`) so one
 * already-registered index cannot reject the batch and put every board request
 * into a rebuild-and-relog loop.
 */
export function ensureTaskIndexes(db: Db): Promise<void> {
  if (!taskIndexesPromise) {
    taskIndexesPromise = (async () => {
      try {
        await Promise.all([
          // boards
          createIndexTolerant(
            getBoardCollection(db).createIndex(
              { isActive: 1, updatedAt: -1 },
              { name: 'boards_active_updated' }
            )
          ),
          createIndexTolerant(
            getBoardCollection(db).createIndex(
              { idempotencyKey: 1 },
              {
                unique: true,
                partialFilterExpression: { idempotencyKey: { $type: 'string' } },
                name: 'boards_idempotency_unique',
              }
            )
          ),

          // columns
          createIndexTolerant(
            getColumnCollection(db).createIndex(
              { boardId: 1, position: 1 },
              { name: 'columns_board_position' }
            )
          ),
          createIndexTolerant(
            getColumnCollection(db).createIndex(
              { boardId: 1, isDoneColumn: 1 },
              { name: 'columns_board_done' }
            )
          ),

          // tasks
          createIndexTolerant(
            getTaskDocCollection(db).createIndex(
              { boardId: 1, columnId: 1, position: 1 },
              { name: 'tasks_board_column_position' }
            )
          ),
          createIndexTolerant(
            getTaskDocCollection(db).createIndex({ assigneeIds: 1 }, { name: 'tasks_assignees' })
          ),
          createIndexTolerant(
            getTaskDocCollection(db).createIndex({ dueDate: 1 }, { name: 'tasks_due' })
          ),
          createIndexTolerant(
            getTaskDocCollection(db).createIndex({ priority: 1 }, { name: 'tasks_priority' })
          ),
          createIndexTolerant(
            getTaskDocCollection(db).createIndex(
              { isArchived: 1, updatedAt: -1 },
              { name: 'tasks_archived_updated' }
            )
          ),
          createIndexTolerant(
            getTaskDocCollection(db).createIndex(
              { taskNumber: 1 },
              { unique: true, sparse: true, name: 'tasks_number_unique' }
            )
          ),
          createIndexTolerant(
            getTaskDocCollection(db).createIndex(
              { idempotencyKey: 1 },
              {
                unique: true,
                // A partial index on the *type*, not `sparse`. `sparse` still
                // indexes documents that store the field as an explicit `null`,
                // and legacy keyless cards do exactly that — two of them then
                // collide on the unique key and the whole index build fails
                // (E11000), silently leaving task idempotency unenforced. Only
                // string keys participate, so null/absent cards are excluded and
                // no destructive data cleanup is needed on an existing database.
                partialFilterExpression: { idempotencyKey: { $type: 'string' } },
                name: 'tasks_idempotency_unique',
              }
            )
          ),

          // comments
          createIndexTolerant(
            getTaskCommentCollection(db).createIndex(
              { taskId: 1, createdAt: 1 },
              { name: 'taskComments_task_created' }
            )
          ),
          createIndexTolerant(
            getTaskCommentCollection(db).createIndex(
              { authorId: 1 },
              { name: 'taskComments_author' }
            )
          ),

          // activity
          createIndexTolerant(
            getTaskActivityCollection(db).createIndex(
              { taskId: 1, at: -1 },
              { name: 'taskActivity_task_at' }
            )
          ),

          // labels
          createIndexTolerant(
            getTaskLabelCollection(db).createIndex(
              { name: 1 },
              { unique: true, name: 'taskLabels_name_unique' }
            )
          ),
          createIndexTolerant(
            getTaskLabelCollection(db).createIndex({ isActive: 1 }, { name: 'taskLabels_active' })
          ),
        ])
      } catch (error) {
        taskIndexesPromise = null
        console.error('ensureTaskIndexes failed:', error)
      }
    })()
  }
  return taskIndexesPromise
}
