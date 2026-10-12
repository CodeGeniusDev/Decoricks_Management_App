import { ObjectId, type ClientSession, type Db, type Filter } from 'mongodb'
import { HttpError } from '@/lib/http'
import { recordAuditEntry } from '@/lib/audit'
import {
  getAccountCollection,
  getBusinessSettingsCollection,
  getFinanceCategoryCollection,
  getLedgerCollection,
  type Account,
  type FinanceCategory,
  type LedgerTransaction,
} from '@/lib/models/Ledger'
import {
  computeAverages,
  computeAccountBalances,
  karachiDateInputRange,
  periodTotals,
  summarize,
  type DateRange,
  type LedgerEntryLike,
  type LedgerEntryType,
  isLedgerEntryType,
} from '@/lib/finance'
import { formatPaisa } from '@/lib/money'
import { formatKarachiDate } from '@/lib/date'

/**
 * Server-side ledger helpers shared by the finance routes.
 *
 * Kept out of the route files so `/api/finance`, `/api/finance/transactions`,
 * `/api/finance/overview` and `/api/finance/export` all read the same filter,
 * the same normalisation and the same serialization. The arithmetic itself lives
 * in the isomorphic `@/lib/finance`.
 */

export interface LedgerQueryInput {
  page: number
  limit: number
  type?: string
  accountId?: string
  category?: string
  partnerId?: string
  search?: string
  startDate?: string
  endDate?: string
}

export interface NormalizedEntry extends LedgerEntryLike {
  _id: string
  isReversal: boolean
  status: 'posted' | 'reversed'
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Convert a stored document into the structural shape the pure maths expect. */
export const normalizeEntry = (doc: LedgerTransaction): NormalizedEntry => ({
  _id: doc._id?.toString() ?? '',
  type: doc.type,
  amount: doc.amount,
  date: doc.date,
  accountId: doc.accountId?.toString(),
  fromAccountId: doc.fromAccountId?.toString(),
  toAccountId: doc.toAccountId?.toString(),
  category: doc.category,
  partnerId: doc.partnerId?.toString(),
  partnerName: doc.partnerName,
  isReversal: doc.isReversal,
  status: doc.status,
})

/**
 * Parse an entry date. A `YYYY-MM-DD` value is interpreted as Karachi midnight
 * (the ledger's day boundary); anything with a time component is used verbatim.
 */
export const parseLedgerDate = (value: string): Date => {
  const range = karachiDateInputRange(value)
  if (range) return range.start
  return new Date(value)
}

export interface BuiltFilter {
  filter: Record<string, unknown>
  range: DateRange | null
}

/** Build the Mongo filter for a transaction query, plus the effective range. */
export const buildLedgerFilter = (input: {
  type?: string
  accountId?: string
  category?: string
  partnerId?: string
  search?: string
  startDate?: string
  endDate?: string
}): BuiltFilter => {
  const and: Record<string, unknown>[] = []

  if (input.type && input.type !== 'all') {
    and.push({ type: input.type })
  }

  if (input.accountId) {
    and.push({
      $or: [
        { accountId: new ObjectId(input.accountId) },
        { fromAccountId: new ObjectId(input.accountId) },
        { toAccountId: new ObjectId(input.accountId) },
      ],
    })
  }

  if (input.category) and.push({ category: input.category })
  if (input.partnerId) and.push({ partnerId: new ObjectId(input.partnerId) })

  if (input.search && input.search.trim()) {
    const rx = new RegExp(escapeRegex(input.search.trim()), 'i')
    and.push({
      $or: [{ note: rx }, { category: rx }, { partnerName: rx }, { paymentMethod: rx }],
    })
  }

  let range: DateRange | null = null
  const start = input.startDate ? karachiDateInputRange(input.startDate) : null
  const end = input.endDate ? karachiDateInputRange(input.endDate) : null

  if (start || end) {
    const dateFilter: Record<string, Date> = {}
    if (start) dateFilter.$gte = start.start
    if (end) dateFilter.$lte = end.end
    and.push({ date: dateFilter })
    range = {
      start: start ? start.start : new Date(0),
      end: end ? end.end : new Date(),
    }
  }

  const filter = and.length === 0 ? {} : and.length === 1 ? and[0] : { $and: and }
  return { filter, range }
}

export interface EntrySerialized {
  _id: string
  type: LedgerEntryType
  amount: number
  amountDisplay: string
  date: string
  accountId?: string
  accountName?: string
  fromAccountId?: string
  fromAccountName?: string
  toAccountId?: string
  toAccountName?: string
  category?: string
  categoryLabel?: string
  partnerId?: string
  partnerName?: string
  paymentMethod?: string
  note?: string
  isReversal: boolean
  reversesId?: string
  status: 'posted' | 'reversed'
  createdAt?: string
}

export interface SerializeContext {
  accountNames: Map<string, string>
  categoryLabels: Map<string, string>
}

export const buildSerializeContext = (
  accounts: Account[],
  categories: FinanceCategory[]
): SerializeContext => ({
  accountNames: new Map(accounts.map((a) => [a._id!.toString(), a.name])),
  categoryLabels: new Map(categories.map((c) => [c.name, c.label])),
})

export const serializeEntry = (
  doc: LedgerTransaction,
  ctx: SerializeContext
): EntrySerialized => {
  const accountId = doc.accountId?.toString()
  const fromAccountId = doc.fromAccountId?.toString()
  const toAccountId = doc.toAccountId?.toString()

  return {
    _id: doc._id?.toString() ?? '',
    type: doc.type,
    amount: doc.amount,
    amountDisplay: formatPaisa(doc.isReversal ? -doc.amount : doc.amount),
    date: doc.date instanceof Date ? doc.date.toISOString() : String(doc.date),
    accountId,
    accountName: accountId ? ctx.accountNames.get(accountId) : undefined,
    fromAccountId,
    fromAccountName: fromAccountId ? ctx.accountNames.get(fromAccountId) : undefined,
    toAccountId,
    toAccountName: toAccountId ? ctx.accountNames.get(toAccountId) : undefined,
    category: doc.category,
    categoryLabel: doc.category ? ctx.categoryLabels.get(doc.category) ?? doc.category : undefined,
    partnerId: doc.partnerId?.toString(),
    partnerName: doc.partnerName,
    paymentMethod: doc.paymentMethod,
    note: doc.note,
    isReversal: doc.isReversal,
    reversesId: doc.reversesId?.toString(),
    status: doc.status,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : undefined,
  }
}

export const loadAccounts = async (db: Db): Promise<Account[]> =>
  getAccountCollection(db).find({}).sort({ createdAt: 1 }).toArray()

export const loadCategories = async (db: Db): Promise<FinanceCategory[]> =>
  getFinanceCategoryCollection(db).find({}).sort({ type: 1, label: 1 }).toArray()

/**
 * List transactions with pagination, filters, totals, averages and period
 * totals. The full filtered set is loaded so the totals describe every matching
 * entry rather than just the visible page; this is bounded by the size of a
 * small-business ledger.
 */
export const listLedger = async (db: Db, input: BuiltFilter & { page: number; limit: number }) => {
  const [accounts, categories] = await Promise.all([loadAccounts(db), loadCategories(db)])
  const ctx = buildSerializeContext(accounts, categories)

  const all = await getLedgerCollection(db)
    .find(input.filter as Filter<LedgerTransaction>)
    .sort({ date: -1, createdAt: -1 })
    .toArray()

  const normalized = all.map(normalizeEntry)
  const summary = summarize(normalized)

  const range =
    input.range ??
    (() => {
      if (normalized.length === 0) {
        const now = new Date()
        return { start: now, end: now }
      }
      const times = normalized.map((entry) => new Date(entry.date).getTime())
      return { start: new Date(Math.min(...times)), end: new Date(Math.max(...times)) }
    })()

  const averages = computeAverages(normalized, range)
  const periods = periodTotals(normalized, new Date())

  const total = all.length
  const start = (input.page - 1) * input.limit
  const pageItems = all.slice(start, start + input.limit).map((doc) => serializeEntry(doc, ctx))

  return {
    items: pageItems,
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / input.limit)),
    },
    summary,
    averages,
    periods,
    range,
  }
}

export const getAccountBalances = async (db: Db) => {
  const [accounts, entries] = await Promise.all([
    loadAccounts(db),
    getLedgerCollection(db).find({}).toArray(),
  ])
  const balances = computeAccountBalances(
    accounts.map((a) => ({ _id: a._id!.toString(), openingBalance: a.openingBalance })),
    entries.map(normalizeEntry)
  )
  return { accounts, balances }
}

export const getWithdrawalLock = async (db: Db): Promise<Date | null> => {
  const settings = await getBusinessSettingsCollection(db).findOne({ key: 'business' })
  return settings?.withdrawalLockedUntil ?? null
}

export const formatEntryDate = (date: Date | string): string =>
  formatKarachiDate(date instanceof Date ? date : new Date(date), 'date')

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

export interface ActorContext {
  id: ObjectId
  name: string
  email: string
  ipAddress?: string
  userAgent?: string
}

export interface LedgerEntryInput {
  type: LedgerEntryType
  amount: number
  date: string
  accountId?: string
  fromAccountId?: string
  toAccountId?: string
  category?: string
  partnerId?: string
  partnerName?: string
  paymentMethod?: string
  note?: string
  idempotencyKey?: string
}

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000

const assertAccountsUsable = async (
  db: Db,
  accountIds: Set<string>,
  session?: ClientSession
): Promise<void> => {
  if (accountIds.size === 0) return
  const accounts = await getAccountCollection(db)
    .find({ _id: { $in: [...accountIds].map((id) => new ObjectId(id)) } }, session ? { session } : {})
    .toArray()
  const found = new Map(accounts.map((account) => [account._id!.toString(), account]))

  for (const id of accountIds) {
    const account = found.get(id)
    if (!account) {
      throw new HttpError('The selected account does not exist', 400, 'VALIDATION_ERROR', [
        { path: 'accountId', message: 'Unknown account' },
      ])
    }
    if (!account.isActive) {
      throw new HttpError('The selected account is inactive', 400, 'VALIDATION_ERROR', [
        { path: 'accountId', message: 'Account is inactive' },
      ])
    }
  }
}

export interface WriteResult {
  doc: LedgerTransaction
  created: boolean
}

export interface LedgerWriteOptions {
  /**
   * Run the write inside the caller's transaction. Required by Phase 5 flows
   * (purchase, delivered income, refund) where the money entry and the stock
   * movement must commit or roll back together.
   */
  session?: ClientSession
  /**
   * Audit the write. Defaults to true OUTSIDE a transaction and false inside
   * one: an audit write without the session would be rejected by MongoDB
   * mid-transaction, so the route audits explicitly after commit instead.
   */
  audit?: boolean
}

/**
 * Insert a ledger entry.
 *
 * Idempotency is enforced twice: an early lookup returns the original for a
 * known key, and the unique sparse index catches a concurrent replay that slips
 * past the lookup. Business rules that must hold regardless of the client are
 * checked here rather than in the route: referenced accounts must exist and be
 * active, income/expense categories must exist and match the entry type, and a
 * partner withdrawal respects the withdrawal lock.
 */
export const createLedgerEntry = async (
  db: Db,
  input: LedgerEntryInput,
  actor: ActorContext,
  opts: LedgerWriteOptions = {}
): Promise<WriteResult> => {
  const collection = getLedgerCollection(db)
  const sessionOpts = opts.session ? { session: opts.session } : {}

  if (input.idempotencyKey) {
    const existing = await collection.findOne({ idempotencyKey: input.idempotencyKey }, sessionOpts)
    if (existing) return { doc: existing, created: false }
  }

  const accountIds = new Set<string>()
  if (input.accountId) accountIds.add(input.accountId)
  if (input.fromAccountId) accountIds.add(input.fromAccountId)
  if (input.toAccountId) accountIds.add(input.toAccountId)
  await assertAccountsUsable(db, accountIds, opts.session)

  if (input.type === 'transfer' && input.fromAccountId === input.toAccountId) {
    throw new HttpError('From and to accounts must be different', 400, 'VALIDATION_ERROR', [
      { path: 'toAccountId', message: 'Must differ from the source account' },
    ])
  }

  if (input.type === 'income' || input.type === 'expense') {
    const expected = input.type
    const category = input.category
      ? await getFinanceCategoryCollection(db).findOne({ name: input.category }, sessionOpts)
      : null
    if (!category || category.type !== expected || !category.isActive) {
      throw new HttpError('The selected category is not available', 400, 'VALIDATION_ERROR', [
        { path: 'category', message: 'Unknown or inactive category' },
      ])
    }
  }

  if (input.type === 'partner_withdrawal') {
    const lock = await getWithdrawalLock(db)
    if (lock && Date.now() < lock.getTime()) {
      throw new HttpError(
        `Withdrawals are locked until ${formatKarachiDate(lock, 'date')}`,
        409,
        'WITHDRAWALS_LOCKED'
      )
    }
  }

  const now = new Date()
  const doc: LedgerTransaction = {
    type: input.type,
    amount: input.amount,
    date: parseLedgerDate(input.date),
    accountId: input.accountId ? new ObjectId(input.accountId) : undefined,
    fromAccountId: input.fromAccountId ? new ObjectId(input.fromAccountId) : undefined,
    toAccountId: input.toAccountId ? new ObjectId(input.toAccountId) : undefined,
    category: input.category,
    partnerId: input.partnerId ? new ObjectId(input.partnerId) : undefined,
    partnerName: input.partnerName,
    paymentMethod: input.paymentMethod,
    note: input.note,
    isReversal: false,
    status: 'posted',
    idempotencyKey: input.idempotencyKey,
    createdBy: actor.id,
    createdByName: actor.name,
    createdAt: now,
    updatedAt: now,
  }

  try {
    const result = await collection.insertOne(doc as never, sessionOpts)
    doc._id = result.insertedId
  } catch (error) {
    if (isDuplicateKeyError(error) && input.idempotencyKey) {
      const existing = await collection.findOne({ idempotencyKey: input.idempotencyKey }, sessionOpts)
      if (existing) return { doc: existing, created: false }
    }
    throw error
  }

  // Inside a transaction the caller audits after commit; an unsessioned audit
  // write would otherwise be rejected mid-transaction.
  if (opts.audit ?? !opts.session) {
    await recordAuditEntry(db, {
      userId: actor.id,
      userEmail: actor.email,
      action: `${input.type}_created`,
      entityType: 'finance',
      entityId: doc._id ?? null,
      newValue: {
        type: input.type,
        amount: input.amount,
        accountId: input.accountId,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        category: input.category,
        note: input.note,
      },
      details: `Created ${input.type} of ${formatPaisa(input.amount)}`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    })
  }

  return { doc, created: true }
}

/**
 * Post a reversal for an existing entry. The original is never mutated beyond
 * its `status`/`reversedBy` bookkeeping fields and is never removed: SPEC
 * §10.2.3 Test 9 requires that corrections are visible, linked and audited.
 */
export const reverseLedgerEntry = async (
  db: Db,
  id: string,
  reason: string | undefined,
  actor: ActorContext,
  idempotencyKey?: string,
  opts: LedgerWriteOptions = {}
): Promise<WriteResult> => {
  const collection = getLedgerCollection(db)
  const sessionOpts = opts.session ? { session: opts.session } : {}

  if (idempotencyKey) {
    const existing = await collection.findOne({ idempotencyKey }, sessionOpts)
    if (existing) return { doc: existing, created: false }
  }

  if (!/^[0-9a-fA-F]{24}$/.test(id)) {
    throw new HttpError('Invalid transaction id', 400, 'VALIDATION_ERROR', [
      { path: 'id', message: 'Malformed id' },
    ])
  }

  const original = await collection.findOne({ _id: new ObjectId(id) }, sessionOpts)
  if (!original) throw new HttpError('Transaction not found', 404, 'NOT_FOUND')
  if (original.isReversal) {
    throw new HttpError('A reversal entry cannot itself be reversed', 409, 'ALREADY_REVERSED')
  }
  if (original.status === 'reversed' || original.reversedBy) {
    throw new HttpError('This transaction has already been reversed', 409, 'ALREADY_REVERSED')
  }

  const now = new Date()
  const reversal: LedgerTransaction = {
    type: original.type,
    amount: original.amount,
    date: now,
    accountId: original.accountId,
    fromAccountId: original.fromAccountId,
    toAccountId: original.toAccountId,
    category: original.category,
    partnerId: original.partnerId,
    partnerName: original.partnerName,
    paymentMethod: original.paymentMethod,
    note: reason ? `Reversal: ${reason}` : `Reversal of ${original._id?.toString() ?? id}`,
    isReversal: true,
    reversesId: original._id,
    status: 'posted',
    idempotencyKey,
    createdBy: actor.id,
    createdAt: now,
    updatedAt: now,
  }

  try {
    const result = await collection.insertOne(reversal as never, sessionOpts)
    reversal._id = result.insertedId
  } catch (error) {
    if (isDuplicateKeyError(error) && idempotencyKey) {
      const existing = await collection.findOne({ idempotencyKey }, sessionOpts)
      if (existing) return { doc: existing, created: false }
    }
    throw error
  }

  await collection.updateOne(
    { _id: original._id },
    { $set: { status: 'reversed', reversedBy: reversal._id, updatedAt: now } },
    sessionOpts
  )

  if (opts.audit ?? !opts.session) {
    await recordAuditEntry(db, {
      userId: actor.id,
      userEmail: actor.email,
      action: 'transaction_reversed',
      entityType: 'finance',
      entityId: original._id ?? null,
      oldValue: { status: original.status },
      newValue: { status: 'reversed', reversalId: reversal._id?.toString(), reason: reason ?? null },
      details: `Reversed ${original.type} of ${formatPaisa(original.amount)}`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    })
  }

  return { doc: reversal, created: true }
}
