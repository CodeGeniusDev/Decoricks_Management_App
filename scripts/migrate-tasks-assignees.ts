import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { getEnv } from '../src/lib/env'

/**
 * Phase 6 assignee migration (SPEC §3.1.15.3).
 *
 * Before Phase 6 a task carried `assigneeName`: a role slug such as
 * `founder` or `partner_hasnat` selected from the fixed team-role dropdown
 * (see `lib/roles.TEAM_ROLES`). The board model replaces that with
 * `assigneeIds: ObjectId[]` referencing actual user documents so multi-
 * assignee work, "My tasks" filtering and per-user activity all become
 * possible.
 *
 * This script is one-time, idempotent and non-destructive:
 *
 *   1. It never removes `assigneeName` — the field stays as read-only legacy
 *      evidence of how the task was originally assigned.
 *   2. It only touches a task whose `assigneeIds` array is either missing or
 *      empty, so re-running after partial success is safe and a task that was
 *      later edited in the UI is not overwritten.
 *   3. It maps by role only when exactly one *active* user holds that role.
 *      Ambiguity (0 or >1 matches) is reported and the task is left with an
 *      empty `assigneeIds` so a Founder can reassign it manually.
 *   4. It backfills `version: 1` on any task without one, so subsequent
 *      Phase 6 writes can use the optimistic-concurrency guard from
 *      `lib/task-service.ts` without a second migration pass.
 *   5. It initialises `assigneeIds: []` on tasks that have neither field so
 *      the model invariant (array always present) holds after the run.
 *
 * Usage:
 *   npm run migrate:task-assignees          # dry-run summary only
 *   DRY_RUN=false npm run migrate:task-assignees   # actually writes
 *
 * Refuses to run against a test database (MONGODB_TEST_DB set), mirroring
 * `scripts/seed.ts`.
 */

const loadEnvLocal = (): void => {
  const file = path.join(process.cwd(), '.env.local')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    const value = match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    if (process.env[match[1]] === undefined) process.env[match[1]] = value
  }
}
loadEnvLocal()

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false'

type LegacyTask = {
  _id: ObjectId
  assigneeName?: string
  assigneeIds?: ObjectId[]
  version?: number
  status?: 'todo' | 'in_progress' | 'review' | 'done'
  boardId?: ObjectId
  columnId?: ObjectId
  position?: number
  createdBy?: ObjectId
  createdAt?: Date
  title?: string
}

type UserRow = { _id: ObjectId; role: string; isActive: boolean; name: string }

const collectionNames = async (db: Db) =>
  new Set((await db.listCollections().toArray()).map((c) => c.name))

const run = async () => {
  const env = getEnv()
  if (env.MONGODB_TEST_DB) {
    console.error('MONGODB_TEST_DB is set; refusing to run the migration against a test database.')
    process.exit(1)
  }

  const client = new MongoClient(env.MONGODB_URI)
  try {
    await client.connect()
    const db = client.db()
    const names = await collectionNames(db)
    if (!names.has('tasks')) {
      console.log('No `tasks` collection — nothing to migrate.')
      return
    }
    if (!names.has('users')) {
      console.error('No `users` collection — run `npm run seed` first.')
      process.exit(1)
    }

    const tasks = db.collection<LegacyTask>('tasks')
    const users = db.collection<UserRow>('users')

    // Cache role → active user id (or null when ambiguous). Only one lookup
    // per distinct role label; typical deployments have 4 roles.
    const roleIndex = new Map<string, ObjectId | null>()
    const resolveRole = async (role: string): Promise<ObjectId | null> => {
      if (roleIndex.has(role)) return roleIndex.get(role) ?? null
      const matches = await users
        .find({ role, isActive: true })
        .project<UserRow>({ _id: 1, role: 1, isActive: 1, name: 1 })
        .toArray()
      if (matches.length === 1) {
        roleIndex.set(role, matches[0]._id)
        return matches[0]._id
      }
      roleIndex.set(role, null)
      console.warn(
        `Role "${role}" matched ${matches.length} active users — tasks with this assignee will be left unassigned.`
      )
      return null
    }

    // Snapshot counts before we start so the summary is reproducible.
    const totalTasks = await tasks.countDocuments({})
    const withLegacyName = await tasks.countDocuments({
      assigneeName: { $exists: true, $nin: ['', null] },
    } as never)
    const alreadyMigrated = await tasks.countDocuments({
      assigneeIds: { $exists: true, $not: { $size: 0 } },
    } as never)
    const missingVersion = await tasks.countDocuments({ version: { $exists: false } } as never)

    console.log(
      `Found ${totalTasks} tasks (${withLegacyName} with legacy assigneeName, ` +
        `${alreadyMigrated} already migrated, ${missingVersion} missing version).`
    )

    /* --------------------------------------------------------------------- \
     | Step 1 — board onboarding                                            |
     |                                                                      |
     | Ensure a single "Team Board" with the four default columns exists,   |
     | then stamp every task that does not yet belong to a board with       |
     | `boardId` + `columnId` + a starting `position` ordered by            |
     | `createdAt`. Existing (already-onboarded) documents are left alone   |
     | so re-runs are safe.                                                 |
     \ -------------------------------------------------------------------- */
    const boards = db.collection<{
      _id: ObjectId
      name: string
      isActive: boolean
      archivedAt?: Date | null
      createdBy?: ObjectId
      createdAt?: Date
      updatedAt?: Date
      description?: string
    }>('boards')
    const columns = db.collection<{
      _id: ObjectId
      boardId: ObjectId
      name: string
      position: number
      isDoneColumn: boolean
      isArchived: boolean
      createdBy: ObjectId
      createdAt: Date
      updatedAt: Date
    }>('columns')

    // Need a founder id to stamp createdBy. Use whichever user holds the
    // founder role; if none exists, fall back to the earliest user (an
    // internal tool always has at least one).
    const founder = await users.findOne({ role: 'founder', isActive: true } as never)
    const fallbackUser = founder ?? (await users.findOne({ isActive: true } as never))
    if (!fallbackUser) {
      console.error('No active users to attribute the seed board to. Run `npm run seed` first.')
      process.exit(1)
    }
    const boardCreatorId = fallbackUser._id

    let boardId: ObjectId
    const foundBoard = await boards.findOne({ name: 'Team Board', isActive: true } as never)
    if (foundBoard) {
      boardId = foundBoard._id
    } else if (DRY_RUN) {
      console.log('DRY RUN: would create default "Team Board".')
      boardId = new ObjectId()
    } else {
      const now = new Date()
      const inserted = await boards.insertOne({
        name: 'Team Board',
        description: 'Default board created by the Phase 6 assignee migration.',
        isActive: true,
        archivedAt: null,
        createdBy: boardCreatorId,
        createdAt: now,
        updatedAt: now,
      } as never)
      boardId = inserted.insertedId
      console.log('Created default "Team Board".')
    }

    const DEFAULT_COLUMNS: Array<[name: string, done: boolean]> = [
      ['To Do', false],
      ['In Progress', false],
      ['Review', false],
      ['Done', true],
    ]
    const columnByName = new Map<string, ObjectId>()
    for (const [idx, [name, isDone]] of DEFAULT_COLUMNS.entries()) {
      const existing = await columns.findOne({ boardId, name } as never)
      if (existing) {
        columnByName.set(name, existing._id)
        continue
      }
      if (DRY_RUN) {
        columnByName.set(name, new ObjectId())
        continue
      }
      const now = new Date()
      const inserted = await columns.insertOne({
        boardId,
        name,
        position: (idx + 1) * 1024,
        isDoneColumn: isDone,
        isArchived: false,
        createdBy: boardCreatorId,
        createdAt: now,
        updatedAt: now,
      } as never)
      columnByName.set(name, inserted.insertedId)
    }

    // Legacy `status` field → column name.
    const STATUS_TO_COLUMN: Record<NonNullable<LegacyTask['status']>, string> = {
      todo: 'To Do',
      in_progress: 'In Progress',
      review: 'Review',
      done: 'Done',
    }

    const unboarded = await tasks
      .find<LegacyTask>({
        $or: [{ boardId: { $exists: false } }, { columnId: { $exists: false } }],
      } as never)
      .sort({ createdAt: 1 })
      .toArray()

    const perColumnCounter = new Map<string, number>()
    for (const id of columnByName.values()) perColumnCounter.set(id.toString(), 0)

    let onboarded = 0
    for (const t of unboarded) {
      const columnName = STATUS_TO_COLUMN[t.status ?? 'todo'] ?? 'To Do'
      const columnId = columnByName.get(columnName) ?? [...columnByName.values()][0]
      const nextIdx = (perColumnCounter.get(columnId.toString()) ?? 0) + 1
      perColumnCounter.set(columnId.toString(), nextIdx)
      const position = nextIdx * 1024
      if (!DRY_RUN) {
        await tasks.updateOne(
          { _id: t._id } as never,
          {
            $set: {
              boardId,
              columnId,
              position,
              // Phase 6 model expects these; safe defaults for legacy rows.
              isArchived: false,
              archivedAt: null,
              assigneeIds: t.assigneeIds ?? [],
              labelIds: [],
              checklist: [],
            },
          } as never
        )
      }
      onboarded += 1
    }
    console.log(
      DRY_RUN
        ? `DRY RUN: would onboard ${onboarded} task(s) onto "Team Board" and its default columns.`
        : `Onboarded ${onboarded} task(s) onto "Team Board".`
    )

    /* --------------------------------------------------------------------- \
     | Step 2 — assignee mapping                                            |
     \ -------------------------------------------------------------------- */

    // Walk tasks that have legacy data AND have not been assigned through
    // the board UI yet. Empty assigneeIds array counts as "not assigned".
    const cursor = tasks.find<LegacyTask>({
      assigneeName: { $exists: true, $nin: ['', null] },
      $or: [{ assigneeIds: { $exists: false } }, { assigneeIds: { $size: 0 } }],
    } as never)

    let mapped = 0
    let skippedAmbiguous = 0
    let skippedUnknownRole = 0
    const knownRoles = new Set(['founder', 'partner_hasnat', 'partner_ali', 'partner_afnan'])
    const ambiguous: string[] = []

    for await (const task of cursor) {
      const legacy = (task.assigneeName ?? '').trim()
      if (!legacy) continue
      if (!knownRoles.has(legacy)) {
        skippedUnknownRole += 1
        ambiguous.push(`${task._id.toString()} → unknown role "${legacy}"`)
        continue
      }
      const userId = await resolveRole(legacy)
      if (!userId) {
        skippedAmbiguous += 1
        ambiguous.push(`${task._id.toString()} → ambiguous role "${legacy}"`)
        continue
      }
      if (!DRY_RUN) {
        // Dot-filter guards against overwriting a task that was assigned
        // through the board UI between the find and this update.
        await tasks.updateOne(
          {
            _id: task._id,
            $or: [{ assigneeIds: { $exists: false } }, { assigneeIds: { $size: 0 } }],
          },
          { $set: { assigneeIds: [userId] } }
        )
      }
      mapped += 1
    }

    // Backfill `version: 1` on any remaining task so the API's optimistic
    // concurrency guard has something to compare against. Also initialise an
    // empty assigneeIds array where neither field exists, so the model
    // invariant (array always present) holds for reads.
    let versioned = 0
    let initialised = 0
    if (!DRY_RUN) {
      const vRes = await tasks.updateMany({ version: { $exists: false } }, { $set: { version: 1 } })
      versioned = vRes.modifiedCount
      const iRes = await tasks.updateMany(
        { assigneeIds: { $exists: false } },
        { $set: { assigneeIds: [] } }
      )
      initialised = iRes.modifiedCount
    } else {
      versioned = missingVersion
      initialised = await tasks.countDocuments({ assigneeIds: { $exists: false } })
    }

    console.log('--------------------------------------------------')
    console.log(DRY_RUN ? 'DRY RUN — no writes performed.' : 'Migration applied.')
    console.log(`  assigneeName mapped to a user   : ${mapped}`)
    console.log(`  skipped (ambiguous role match)  : ${skippedAmbiguous}`)
    console.log(`  skipped (unrecognised role name): ${skippedUnknownRole}`)
    console.log(`  tasks given version=1            : ${versioned}`)
    console.log(`  tasks given assigneeIds=[]       : ${initialised}`)
    if (ambiguous.length > 0) {
      console.log('  Task ids needing manual reassignment:')
      for (const line of ambiguous.slice(0, 20)) console.log(`    ${line}`)
      if (ambiguous.length > 20) console.log(`    …and ${ambiguous.length - 20} more`)
    }
    if (DRY_RUN && (mapped > 0 || versioned > 0 || initialised > 0)) {
      console.log('')
      console.log('Re-run with DRY_RUN=false to apply.')
    }
  } finally {
    await client.close()
  }
}

run().catch((error) => {
  console.error('Migration failed:', error)
  process.exit(1)
})
