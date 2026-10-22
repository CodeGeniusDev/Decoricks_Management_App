import { Db, Collection, ObjectId } from 'mongodb'
import { createIndexTolerant } from './indexes'

/* ---------------------------------- tasks ---------------------------------- */

export interface Task {
  _id?: ObjectId
  taskNumber?: string
  title: string
  description?: string
  status: 'todo' | 'in_progress' | 'review' | 'done'
  priority: 'low' | 'medium' | 'high'
  /** Role label (see User model roles) rather than a fabricated user record. */
  assigneeName?: string
  dueDate?: Date
  createdAt: Date
  updatedAt: Date
  createdBy: ObjectId
}

export const getTaskCollection = (db: Db): Collection<Task> => db.collection<Task>('tasks')

export const taskToJSON = (t: Task) => ({
  _id: t._id?.toString(),
  taskNumber: t.taskNumber,
  title: t.title,
  description: t.description,
  status: t.status,
  priority: t.priority,
  assigneeName: t.assigneeName,
  dueDate: t.dueDate,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
})

/* -------------------------------- suppliers -------------------------------- */

export interface Supplier {
  _id?: ObjectId
  name: string
  contactPerson?: string
  phone?: string
  email?: string
  city: string
  address?: string
  productsSupplied: string[]
  notes?: string
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  createdBy: ObjectId
}

export const getSupplierCollection = (db: Db): Collection<Supplier> =>
  db.collection<Supplier>('suppliers')

export const supplierToJSON = (s: Supplier) => ({
  _id: s._id?.toString(),
  name: s.name,
  contactPerson: s.contactPerson,
  phone: s.phone,
  email: s.email,
  city: s.city,
  address: s.address,
  productsSupplied: s.productsSupplied,
  notes: s.notes,
  isActive: s.isActive,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
})

/* --------------------------------- budgets --------------------------------- */

export interface BudgetCategory {
  category: string
  budgeted: number // paisa
}

/**
 * One immutable snapshot of a budget taken before an edit, so changes keep
 * history (Phase 4 brief: no silent edits, no hard deletes). The newest
 * revision sits at the end of the array.
 */
export interface BudgetRevision {
  revisedAt: Date
  revisedBy: ObjectId
  revisedByName?: string
  /** Human-readable summary of what changed, e.g. "meta_ads 200000 -> 250000". */
  changes: string[]
  /** The full pre-edit document (minus its own revision history). */
  previous: {
    name: string
    periodStart: Date
    periodEnd: Date
    status: Budget['status']
    categories: BudgetCategory[]
    totalBudgeted: number
  }
}

export interface Budget {
  _id?: ObjectId
  budgetNumber?: string
  name: string
  /**
   * Derived from the dates at create time; drives list grouping. Optional on
   * the document because Phase 1–2 budgets predate it — readers derive it from
   * the period when absent.
   */
  periodKind?: 'weekly' | 'monthly' | 'custom'
  periodStart: Date
  periodEnd: Date
  status: 'draft' | 'active' | 'archived'
  categories: BudgetCategory[]
  totalBudgeted: number // paisa
  approvedBy?: string
  approvedAt?: Date
  /** Client-generated; unique when present, so retries cannot double-create. */
  idempotencyKey?: string
  revisions?: BudgetRevision[]
  createdAt: Date
  updatedAt: Date
  createdBy: ObjectId
}

export const getBudgetCollection = (db: Db): Collection<Budget> => db.collection<Budget>('budgets')

/**
 * Guarantees the uniqueness constraints the task/budget write paths rely on.
 * Memoized per process; failures are logged rather than thrown so a
 * permissions-restricted deployment still serves reads, and each entry is
 * individually tolerant so one already-registered index cannot reject the batch
 * and bury the real failures (Phase 5 §5/§6).
 *
 * Every spec here must be the ONE spec for that index. `{ taskNumber: 1 }`
 * unique+sparse is also declared in `Tasks.ts` as `tasks_number_unique`, and
 * MongoDB treats the same key pattern under two names as a conflict: with the
 * default `taskNumber_1` name here, a database seeded through the board path
 * answered every supplier/budget write with
 * `ensureOperationsIndexes failed: MongoServerError: Index already exists with a
 * different name: tasks_number_unique` (code 85) — observed in the Phase 5
 * production-build Playwright run. One name, one spec, per index.
 */
let operationsIndexesPromise: Promise<void> | null = null

export function ensureOperationsIndexes(db: Db): Promise<void> {
  if (!operationsIndexesPromise) {
    operationsIndexesPromise = (async () => {
      try {
        await Promise.all([
          createIndexTolerant(
            getTaskCollection(db).createIndex(
              { taskNumber: 1 },
              { unique: true, sparse: true, name: 'tasks_number_unique' }
            )
          ),
          createIndexTolerant(getTaskCollection(db).createIndex({ status: 1, createdAt: -1 })),
          createIndexTolerant(getSupplierCollection(db).createIndex({ name: 1 }, { unique: true })),
          createIndexTolerant(getSupplierCollection(db).createIndex({ createdAt: -1 })),
          createIndexTolerant(
            getBudgetCollection(db).createIndex({ budgetNumber: 1 }, { unique: true, sparse: true })
          ),
          createIndexTolerant(getBudgetCollection(db).createIndex({ status: 1, periodStart: -1 })),
          createIndexTolerant(
            getBudgetCollection(db).createIndex(
              { idempotencyKey: 1 },
              { unique: true, sparse: true, name: 'budgets_idempotency_unique' }
            )
          ),
        ])
      } catch (error) {
        console.error('ensureOperationsIndexes failed:', error)
      }
    })()
  }
  return operationsIndexesPromise
}

export const budgetToJSON = (b: Budget) => ({
  _id: b._id?.toString(),
  budgetNumber: b.budgetNumber,
  name: b.name,
  periodKind: b.periodKind,
  periodStart: b.periodStart,
  periodEnd: b.periodEnd,
  status: b.status,
  categories: b.categories,
  totalBudgeted: b.totalBudgeted,
  approvedBy: b.approvedBy,
  approvedAt: b.approvedAt,
  revisionCount: b.revisions?.length ?? 0,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
})
