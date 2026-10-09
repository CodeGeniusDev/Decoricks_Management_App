import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { getDatabase } from '@/lib/mongodb'
import { ensureOperationsIndexes, getTaskCollection, taskToJSON, type Task } from '@/lib/models/Operations'
import { taskSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { getActor } from '@/lib/current-user'
import { errorResponse, successResponse, validationError } from '@/lib/api-response'

const isDuplicateKeyError = (e: unknown) => (e as { code?: number })?.code === 11000

/** Builds `TASK-YYYYMM-NNNN` from the highest existing number in the month. */
async function nextTaskNumber(col: ReturnType<typeof getTaskCollection>): Promise<string> {
  const now = getKarachiDate()
  const prefix = `TASK-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`

  for (let attempt = 0; attempt < 5; attempt++) {
    const highest = await col
      .find({ taskNumber: { $regex: `^${prefix}-` } })
      .sort({ taskNumber: -1 })
      .limit(1)
      .toArray()
    const last = highest[0]?.taskNumber
    const seq = last ? parseInt(last.slice(prefix.length + 1), 10) + 1 : 1
    const candidate = `${prefix}-${String(seq).padStart(4, '0')}`
    if (!(await col.findOne({ taskNumber: candidate }))) return candidate
  }

  throw new Error('Could not allocate a unique task number')
}

/**
 * GET /api/tasks
 *
 * Query params: status, priority, assignee, search. The page's summary counts
 * (todo/in progress/done) are computed from these stored documents rather than
 * hardcoded.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('tasks', 'view')

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')?.trim()
    const priority = searchParams.get('priority')?.trim()
    const assignee = searchParams.get('assignee')?.trim()
    const search = searchParams.get('search')?.trim()

    const db = await getDatabase()
    const col = getTaskCollection(db)

    const filter: Record<string, unknown> = {}
    if (status) filter.status = status
    if (priority) filter.priority = priority
    if (assignee) filter.assigneeName = assignee
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      filter.$or = [{ title: { $regex: safe, $options: 'i' } }, { taskNumber: { $regex: safe, $options: 'i' } }]
    }

    const docs = await col.find(filter).sort({ createdAt: -1 }).toArray()

    return successResponse({
      tasks: docs.map(taskToJSON),
      summary: {
        total: docs.length,
        todo: docs.filter((t) => t.status === 'todo').length,
        inProgress: docs.filter((t) => t.status === 'in_progress').length,
        review: docs.filter((t) => t.status === 'review').length,
        done: docs.filter((t) => t.status === 'done').length,
        overdue: docs.filter(
          (t) => t.status !== 'done' && t.dueDate && t.dueDate.getTime() < getKarachiDate().getTime()
        ).length,
      },
    })
  } catch (error) {
    console.error('GET /api/tasks failed:', error)
    return handleRouteError(error)
  }
}

/** POST /api/tasks */
async function __POST(request: NextRequest) {
  try {
    await authorize('tasks', 'create')

    const body = await request.json()
    const parsed = taskSchema.safeParse(body)
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    const col = getTaskCollection(db)
    await ensureOperationsIndexes(db)
    const now = getKarachiDate()
    const actor = await getActor()

    const base = {
      title: parsed.data.title,
      description: parsed.data.description || undefined,
      status: parsed.data.status,
      priority: parsed.data.priority,
      assigneeName: parsed.data.assigneeName || undefined,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.id,
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const taskNumber = await nextTaskNumber(col)
      try {
        const result = await col.insertOne({ ...base, taskNumber } as never)
        return successResponse(taskToJSON({ ...(base as Task), _id: result.insertedId, taskNumber }), 201)
      } catch (error) {
        if (isDuplicateKeyError(error) && attempt === 0) continue
        throw error
      }
    }

    throw new Error('Task creation failed after retry')
  } catch (error) {
    console.error('POST /api/tasks failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
