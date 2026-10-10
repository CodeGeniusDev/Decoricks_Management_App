import { Collection, Db, ObjectId } from 'mongodb'
import type { AccountKind, LedgerEntryStatus, LedgerEntryType } from '@/lib/finance'

/**
 * Phase 3 finance core.
 *
 * A single append-only `transactions` ledger replaces the Phase 1
 * `income`/`expenses`/`transfers` split so that account balances and cash-flow
 * reporting have one source of truth. `accounts` and `financeCategories` are
 * the manual configuration the ledger draws on.
 *
 * SPEC §3.1.18 originally carried `expenseCategories` on `businessSettings`;
 * categories are promoted to their own collection so a Founder can add, rename
 * and deactivate them without editing a settings blob. The seeded names still
 * match Appendix A exactly.
 */

export interface Account {
  _id?: ObjectId
  /** Human label shown wherever the account is referenced. */
  name: string
  kind: AccountKind
  /** Integer paisa; may be negative for an overdrawn account. */
  openingBalance: number
  isActive: boolean
  note?: string
  createdAt: Date
  updatedAt: Date
  createdBy: ObjectId
}

export interface FinanceCategory {
  _id?: ObjectId
  /** Stable slug stored on transactions (e.g. `meta_ads`). */
  name: string
  label: string
  type: 'expense' | 'income'
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  createdBy: ObjectId
}

export interface LedgerTransaction {
  _id?: ObjectId
  type: LedgerEntryType
  /** Integer paisa, always positive; direction is expressed by `type`. */
  amount: number
  date: Date
  /** Single-account entry types. */
  accountId?: ObjectId
  /** Transfer legs. */
  fromAccountId?: ObjectId
  toAccountId?: ObjectId
  category?: string
  partnerId?: ObjectId
  partnerName?: string
  paymentMethod?: string
  note?: string
  /** True when this row is a reversal of another row. */
  isReversal: boolean
  /** The entry this row reverses (set on the reversal row). */
  reversesId?: ObjectId
  /** The reversal that cancelled this row, if any. */
  reversedBy?: ObjectId
  status: LedgerEntryStatus
  /** Client-generated idempotency key; unique across the ledger when present. */
  idempotencyKey?: string
  createdBy: ObjectId
  createdByName?: string
  createdAt: Date
  updatedAt: Date
}

/**
 * Singleton business configuration. Only the fields Phase 3 needs are
 * modelled; the settings module keeps owning the rest of SPEC §3.1.18.
 */
export interface BusinessSettings {
  _id?: ObjectId
  /** Always `'singleton'`; the unique index makes this structurally enforced. */
  key: 'business'
  /** Withdrawals are refused before this instant (Karachi wall-clock). */
  withdrawalLockedUntil?: Date
  createdAt: Date
  updatedAt: Date
  updatedBy?: ObjectId
}

export const getAccountCollection = (db: Db): Collection<Account> =>
  db.collection<Account>('accounts')

export const getFinanceCategoryCollection = (db: Db): Collection<FinanceCategory> =>
  db.collection<FinanceCategory>('financeCategories')

export const getLedgerCollection = (db: Db): Collection<LedgerTransaction> =>
  db.collection<LedgerTransaction>('transactions')

export const getBusinessSettingsCollection = (db: Db): Collection<BusinessSettings> =>
  db.collection<BusinessSettings>('businessSettings')

let ledgerIndexPromise: Promise<unknown> | null = null

/**
 * Indexes for the ledger. The unique sparse `idempotencyKey` index is what makes
 * idempotent creates atomic: a replayed request that races the original is
 * rejected by MongoDB rather than writing a duplicate.
 *
 * Memoised per process and failures logged rather than thrown, so a provisioning
 * hiccup never blocks the module.
 */
export function ensureLedgerIndexes(db: Db): Promise<unknown> {
  if (!ledgerIndexPromise) {
    ledgerIndexPromise = Promise.all([
      getAccountCollection(db).createIndex(
        { name: 1 },
        { unique: true, name: 'accounts_name_unique' }
      ),
      getAccountCollection(db).createIndex({ isActive: 1 }, { name: 'accounts_isActive' }),

      getFinanceCategoryCollection(db).createIndex(
        { name: 1 },
        { unique: true, name: 'financeCategories_name_unique' }
      ),
      getFinanceCategoryCollection(db).createIndex(
        { type: 1, isActive: 1 },
        { name: 'financeCategories_type_active' }
      ),

      getLedgerCollection(db).createIndex(
        { idempotencyKey: 1 },
        { unique: true, sparse: true, name: 'transactions_idempotency_unique' }
      ),
      getLedgerCollection(db).createIndex({ date: -1, createdAt: -1 }, { name: 'transactions_date' }),
      getLedgerCollection(db).createIndex({ type: 1, date: -1 }, { name: 'transactions_type_date' }),
      getLedgerCollection(db).createIndex({ accountId: 1, date: -1 }, { name: 'transactions_account' }),
      getLedgerCollection(db).createIndex({ fromAccountId: 1 }, { name: 'transactions_fromAccount' }),
      getLedgerCollection(db).createIndex({ toAccountId: 1 }, { name: 'transactions_toAccount' }),
      getLedgerCollection(db).createIndex({ category: 1 }, { name: 'transactions_category' }),
      getLedgerCollection(db).createIndex({ partnerId: 1 }, { name: 'transactions_partner' }),
      getLedgerCollection(db).createIndex({ reversesId: 1 }, { name: 'transactions_reverses' }),
      getLedgerCollection(db).createIndex({ status: 1 }, { name: 'transactions_status' }),

      getBusinessSettingsCollection(db).createIndex(
        { key: 1 },
        { unique: true, name: 'businessSettings_key_unique' }
      ),
    ]).catch((error) => {
      ledgerIndexPromise = null
      console.error('Failed to ensure ledger indexes:', error)
    })
  }
  return ledgerIndexPromise
}
