import { z } from 'zod'

/**
 * Phase 6 board schemas (SPEC §3.1.15.1–.6).
 *
 * Every mutation that changes task data carries `version` (except creates,
 * which set it to 1). The server rejects a stale version with 409; see
 * `lib/task-service.ts` and SPEC §6.6 Conflict Resolution.
 *
 * Idempotency keys guard creates — replaying the same POST returns the
 * original document, same as finance/inventory.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id')

const idempotencyKey = z
  .string()
  .trim()
  .min(8, 'Idempotency key too short')
  .max(120, 'Idempotency key too long')
  .optional()

const brandHex = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a 6-digit brand hex (e.g. #0EA5E9)')

/* --------------------------------- boards --------------------------------- */

export const boardCreateSchema = z.object({
  name: z.string().trim().min(1, 'Board name is required').max(120),
  description: z.string().trim().max(1000).optional(),
  /** Optional seed columns; defaults to To Do / In Progress / Review / Done. */
  columns: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        isDoneColumn: z.boolean().optional().default(false),
      })
    )
    .max(12, 'At most 12 initial columns')
    .optional(),
  idempotencyKey,
})

export const boardUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  /** Setting `false` archives; SPEC: never a hard delete. */
  isActive: z.boolean().optional(),
})

/* --------------------------------- columns -------------------------------- */

export const columnCreateSchema = z.object({
  boardId: objectId,
  name: z.string().trim().min(1, 'Column name is required').max(120),
  /** Optional insertion point; omit to append at the end. */
  afterColumnId: objectId.optional(),
  isDoneColumn: z.boolean().optional().default(false),
})

export const columnUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  isArchived: z.boolean().optional(),
  /**
   * Promoting a column to done demotes the previous done column and clears
   * completedAt on the old column's tasks. Server handles that atomically.
   */
  isDoneColumn: z.boolean().optional(),
})

export const columnReorderSchema = z.object({
  boardId: objectId,
  /** Complete, ordered list of non-archived column ids for the board. */
  columnIds: z.array(objectId).min(1).max(50),
})

/* ---------------------------------- tasks --------------------------------- */

const taskPriorityEnum = z.enum(['low', 'medium', 'high', 'urgent'])
const checklistItemSchema = z.object({
  _id: objectId.optional(),
  text: z.string().trim().min(1, 'Checklist item text is required').max(500),
  isDone: z.boolean().default(false),
})

export const taskCreateSchema = z.object({
  boardId: objectId,
  columnId: objectId,
  /** Optional insertion point within the column; omit to append at the end. */
  afterTaskId: objectId.optional(),
  title: z.string().trim().min(1, 'Title is required').max(300),
  description: z.string().trim().max(4000).optional(),
  assigneeIds: z.array(objectId).max(8, 'At most 8 assignees').default([]),
  priority: taskPriorityEnum.default('medium'),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/, 'Due date must be YYYY-MM-DD')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  labelIds: z.array(objectId).max(12).default([]),
  checklist: z.array(checklistItemSchema).max(50).default([]),
  idempotencyKey,
})

export const taskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(4000).optional(),
  assigneeIds: z.array(objectId).max(8).optional(),
  priority: taskPriorityEnum.optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/)
    .optional()
    .or(z.literal('').transform(() => undefined))
    .nullable()
    .optional(),
  labelIds: z.array(objectId).max(12).optional(),
  checklist: z.array(checklistItemSchema).max(50).optional(),
  /** Required on every PATCH; server bumps to `version + 1` on success. */
  version: z.number().int().min(1),
})

/**
 * Move within or across columns. `afterTaskId` null = move to top of column.
 * Same rule as reorder in finance: never mutate anything but position/column.
 */
export const taskMoveSchema = z.object({
  toColumnId: objectId,
  /** Card this one should sit after, or null/undefined for the column head. */
  afterTaskId: objectId.nullable().optional(),
  version: z.number().int().min(1),
})

export const taskArchiveSchema = z.object({
  isArchived: z.boolean(),
  version: z.number().int().min(1),
})

/* -------------------------------- comments -------------------------------- */

export const taskCommentCreateSchema = z.object({
  body: z.string().trim().min(1, 'Comment cannot be empty').max(4000, 'Comment too long'),
})

export const taskCommentUpdateSchema = z.object({
  body: z.string().trim().min(1).max(4000).optional(),
  /** Setting `true` soft-deletes; body is redacted on read. */
  isDeleted: z.boolean().optional(),
})

/* --------------------------------- labels --------------------------------- */

export const taskLabelCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: brandHex,
})

export const taskLabelUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  color: brandHex.optional(),
  isActive: z.boolean().optional(),
})

/* ------------------------------ list filters ------------------------------ */

/**
 * Shared GET /api/tasks query. Kept in the schemas module so list + CSV +
 * weekly-summary routes all agree on what a filter means.
 */
export const taskListQuerySchema = z.object({
  boardId: objectId.optional(),
  columnId: objectId.optional(),
  assigneeId: objectId.optional(),
  /** Special value `me` is resolved server-side from the session. */
  assignee: z.string().trim().max(60).optional(),
  priority: taskPriorityEnum.optional(),
  labelId: objectId.optional(),
  /** YYYY-MM-DD (Karachi day boundaries). */
  dueFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().trim().max(120).optional(),
  /** When true, only overdue (past due, not in done column, Karachi today). */
  overdue: z.enum(['true', 'false']).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

