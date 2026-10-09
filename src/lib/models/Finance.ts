import { Db, Collection, ObjectId } from 'mongodb'

export interface Income {
  _id?: ObjectId
  incomeNumber: string
  amount: number // paisa
  category: string
  source: string
  description?: string
  referenceId?: ObjectId
  referenceType?: string
  date: Date
  createdAt: Date
  updatedAt: Date
  createdBy: ObjectId
  /** Client-generated idempotency key; unique per collection when present. */
  clientRequestId?: string
}

export interface Expense {
  _id?: ObjectId
  expenseNumber: string
  amount: number // paisa
  category: string
  vendorId?: ObjectId
  description?: string
  referenceId?: ObjectId
  referenceType?: string
  date: Date
  createdAt: Date
  updatedAt: Date
  createdBy: ObjectId
  /** Client-generated idempotency key; unique per collection when present. */
  clientRequestId?: string
}

export interface Transfer {
  _id?: ObjectId
  transferNumber: string
  fromAccount: string
  toAccount: string
  amount: number // paisa
  description?: string
  date: Date
  createdAt: Date
  updatedAt: Date
  createdBy: ObjectId
  /** Client-generated idempotency key; unique per collection when present. */
  clientRequestId?: string
}

export const getIncomeCollection = (db: Db): Collection<Income> => {
  return db.collection<Income>('income')
}

export const getExpenseCollection = (db: Db): Collection<Expense> => {
  return db.collection<Expense>('expenses')
}

export const getTransferCollection = (db: Db): Collection<Transfer> => {
  return db.collection<Transfer>('transfers')
}

let financeIndexPromise: Promise<unknown> | null = null

/**
 * Creates the unique sparse index that makes `clientRequestId` idempotency
 * atomic: two concurrent identical submissions can no longer both insert,
 * because the database rejects the second write.
 *
 * Memoised per process — MongoDB is asked once, not on every request — and
 * failures are logged rather than thrown so provisioning problems never block
 * writes. `sparse` keeps documents without the field out of the index, so
 * existing rows are unaffected.
 */
export function ensureFinanceIndexes(db: Db): Promise<unknown> {
  if (!financeIndexPromise) {
    financeIndexPromise = Promise.all([
      getIncomeCollection(db).createIndex({ clientRequestId: 1 }, { unique: true, sparse: true }),
      getExpenseCollection(db).createIndex({ clientRequestId: 1 }, { unique: true, sparse: true }),
      getTransferCollection(db).createIndex({ clientRequestId: 1 }, { unique: true, sparse: true }),
    ]).catch((error) => {
      financeIndexPromise = null
      console.error('Failed to ensure finance indexes:', error)
    })
  }
  return financeIndexPromise
}

export interface FinancialEntry {
  type: 'income' | 'expense' | 'transfer'
  _id: string
  amount: number
  date: Date
  category: string
  source: string
  description?: string
  createdAt: Date
  createdBy: { _id: string; name: string }
}

export interface FinancialSummary {
  totalIncome: number
  totalExpenses: number
  totalTransfers: number
  netCashFlow: number
  totalRevenue: number
  grossProfit: number
  netProfit: number
}
