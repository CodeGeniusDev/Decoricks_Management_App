import { Db, Collection, ObjectId } from 'mongodb'

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

export const getSupplierCollection = (db: Db): Collection<Supplier> => db.collection<Supplier>('suppliers')

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

export interface Budget {
  _id?: ObjectId
  budgetNumber?: string
  name: string
  periodStart: Date
  periodEnd: Date
  status: 'draft' | 'active' | 'archived'
  categories: BudgetCategory[]
  totalBudgeted: number // paisa
  approvedBy?: string
  approvedAt?: Date
  createdAt: Date
  updatedAt: Date
  createdBy: ObjectId
}

export const getBudgetCollection = (db: Db): Collection<Budget> => db.collection<Budget>('budgets')

/**
 * Guarantees the uniqueness constraints the task/budget write paths rely on.
 * Memoized per process; failures are logged rather than thrown so a
 * permissions-restricted deployment still serves reads.
 */
let operationsIndexesPromise: Promise<void> | null = null

export function ensureOperationsIndexes(db: Db): Promise<void> {
  if (!operationsIndexesPromise) {
    operationsIndexesPromise = (async () => {
      try {
        await Promise.all([
          getTaskCollection(db).createIndex({ taskNumber: 1 }, { unique: true, sparse: true }),
          getTaskCollection(db).createIndex({ status: 1, createdAt: -1 }),
          getSupplierCollection(db).createIndex({ name: 1 }, { unique: true }),
          getSupplierCollection(db).createIndex({ createdAt: -1 }),
          getBudgetCollection(db).createIndex({ budgetNumber: 1 }, { unique: true, sparse: true }),
          getBudgetCollection(db).createIndex({ status: 1, periodStart: -1 }),
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
  periodStart: b.periodStart,
  periodEnd: b.periodEnd,
  status: b.status,
  categories: b.categories,
  totalBudgeted: b.totalBudgeted,
  approvedBy: b.approvedBy,
  approvedAt: b.approvedAt,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
})