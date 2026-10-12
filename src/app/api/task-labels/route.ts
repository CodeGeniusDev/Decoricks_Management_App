import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize, requireFounder } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import {
  getTaskLabelCollection,
  taskLabelToJSON,
  type TaskLabel,
} from '@/lib/models/Tasks'
import { taskLabelCreateSchema } from '@/lib/schemas/tasks'
import { getActor } from '@/lib/current-user'
import { recordAuditEntry } from '@/lib/audit'
import { successResponse, validationError } from '@/lib/api-response'

async function __GET() {
  try {
    await authorize('tasks', 'view')
    const db = await getDatabase()
    const labels = await getTaskLabelCollection(db)
      .find({ isActive: true } as never)
      .sort({ name: 1 })
      .toArray()
    return successResponse({ labels: labels.map(taskLabelToJSON) })
  } catch (error) {
    console.error('GET /api/task-labels failed:', error)
    return handleRouteError(error)
  }
}

async function __POST(request: NextRequest) {
  try {
    const auth = await requireFounder()
    const parsed = taskLabelCreateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }

    const db = await getDatabase()
    const actor = await getActor()
    const now = new Date()
    const doc: Omit<TaskLabel, '_id'> = {
      name: parsed.data.name,
      color: parsed.data.color,
      isActive: true,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    }
    const result = await getTaskLabelCollection(db).insertOne(doc as never)

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'task_label_created',
      entityType: 'taskLabel',
      entityId: result.insertedId,
      newValue: { name: doc.name, color: doc.color },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(taskLabelToJSON({ ...doc, _id: result.insertedId } as never), 201)
  } catch (error) {
    console.error('POST /api/task-labels failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
