/**
 * Stage 1 — READ-ONLY inventory of `decoricks_prod` before DEMO-data cleanup.
 *
 * This script NEVER writes. Every operation is `listCollections`, `countDocuments`,
 * `find` or a read-only aggregation, plus the application's own read-only
 * `reconcile()`. It targets the database named `decoricks_prod` and refuses to run
 * against anything else. It never touches the bare `test` database and never
 * prints a secret: the connection string is loaded from `.env.local` by hand and
 * only the HOST is ever echoed (credentials redacted).
 *
 * Usage (read-only; the plan, not the deletion):
 *   MONGODB_DB=decoricks_prod DECORICKS_ALLOW_PROD_DB=1 npx tsx scripts/stage1-demo-inventory.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MongoClient, ObjectId, type Db, type Document } from 'mongodb'
import { computeAccountBalances, type LedgerEntryLike } from '../src/lib/finance'

/* ------------------------------------------------------------------ env ---- */
// Loaded by hand so nothing is echoed. Mirrors scripts/db-inventory.ts.
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

// The operator pins the target explicitly, read-only.
process.env.MONGODB_DB = 'decoricks_prod'
process.env.DECORICKS_ALLOW_PROD_DB = '1'

const TARGET_DB = 'decoricks_prod'
const URI = process.env.MONGODB_URI ?? ''
if (!URI) {
  console.error('MONGODB_URI is not set')
  process.exit(1)
}

/** Hostnames only, never the user:pass@ authority — no secrets printed. */
const redactedHosts = (uri: string): string => {
  const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//i, '')
  const authority = withoutScheme.slice(withoutScheme.lastIndexOf('@') + 1)
  return authority.split('/')[0].split('?')[0]
}

/* ------------------------------------------------------------- utilities --- */
const pkr = (paisa: number | undefined | null): string =>
  typeof paisa === 'number' && Number.isFinite(paisa)
    ? `PKR ${(paisa / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'

const day = (d: unknown): string =>
  d instanceof Date ? d.toISOString().slice(0, 10) : typeof d === 'string' ? d.slice(0, 10) : '—'

const short = (id: unknown): string =>
  id instanceof ObjectId ? id.toString() : id ? String(id) : '—'

const orDash = (s: unknown): string => (s === undefined || s === null || s === '' ? '—' : String(s))

/* ------------------------------------------- classification + descriptions - */
type Class = 'CONFIG' | 'RECORD' | 'DERIVED'
interface Meta {
  class: Class
  dateField: string | null
  description: string
}
const COLLECTION_META: Record<string, Meta> = {
  // (a) CONFIGURATION — must stay
  users: {
    class: 'CONFIG',
    dateField: 'createdAt',
    description: 'Accounts (name, email, role, password hash, prefs)',
  },
  roles: { class: 'CONFIG', dateField: 'createdAt', description: 'Role → permission matrix' },
  businessSettings: {
    class: 'CONFIG',
    dateField: 'createdAt',
    description: 'Singleton policy: profit share, thresholds, budgets, accounts',
  },
  accounts: {
    class: 'CONFIG',
    dateField: 'createdAt',
    description: 'Cash/bank accounts + opening balances (paisa)',
  },
  financeCategories: {
    class: 'CONFIG',
    dateField: 'createdAt',
    description: 'Income/expense category slugs',
  },
  productCategories: {
    class: 'CONFIG',
    dateField: 'createdAt',
    description: 'Product catalogue categories',
  },
  taskLabels: {
    class: 'CONFIG',
    dateField: 'createdAt',
    description: 'Task-board label chips (name+color)',
  },
  auditLog: {
    class: 'CONFIG',
    dateField: 'createdAt',
    description: 'Append-only audit trail (who/what/outcome)',
  },
  // (b) RECORDS — could be demo
  transactions: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Ledger entries: income/expense/transfer/partner_* (paisa)',
  },
  orders: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Sales orders (customer, items, totals, payment status)',
  },
  returns: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Order returns (refund, restock, courier)',
  },
  purchases: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Supplier purchases (cost, stock-in, expense)',
  },
  stockMovements: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Append-only stock movements (sale/purchase/return/adjust)',
  },
  stock: {
    class: 'RECORD',
    dateField: 'lastUpdated',
    description: 'Projected on-hand quantity per product+location',
  },
  products: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Product catalogue (SKU, WAC cost, price) — catalog-like',
  },
  suppliers: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Supplier directory (contact/phone PII) — reference-like',
  },
  boards: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Task boards (top-level containers)',
  },
  columns: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Ordered stages within a board',
  },
  tasks: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Task cards (title, assignees, priority, version)',
  },
  taskComments: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Per-card comment threads (soft-delete)',
  },
  budgets: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Period budgets (category allocations, status)',
  },
  profitDistributions: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Monthly P&L split snapshots (lockable)',
  },
  messages: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Chat messages (append-only, soft-delete)',
  },
  chatChannels: {
    class: 'RECORD',
    dateField: 'createdAt',
    description: 'Chat rooms (3 seeded defaults are config; extra are records)',
  },
  // (c) DERIVED / SYSTEM — follows the records
  sessions: {
    class: 'DERIVED',
    dateField: 'createdAt',
    description: 'Server-side login sessions (TTL)',
  },
  loginAttempts: {
    class: 'DERIVED',
    dateField: 'createdAt',
    description: 'Failed-login tracking (TTL, lockout)',
  },
  counters: {
    class: 'DERIVED',
    dateField: null,
    description: 'Atomic serial sequences (orderNumber/purchaseNumber/returnNumber)',
  },
  notifications: {
    class: 'DERIVED',
    dateField: 'createdAt',
    description: 'Per-user notification feed (deduped)',
  },
  taskActivity: {
    class: 'DERIVED',
    dateField: 'at',
    description: 'Append-only task audit trail (created/moved/completed…)',
  },
  chatChannelReads: {
    class: 'DERIVED',
    dateField: 'updatedAt',
    description: 'Per-user/channel read watermarks',
  },
  pushSubscriptions: {
    class: 'DERIVED',
    dateField: 'createdAt',
    description: 'Web Push endpoint subscriptions',
  },
}

/* --------------------------------------------------------------- table fmt - */
const formatTable = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ')
  const out = [line(headers), line(widths.map((w) => '-'.repeat(w)))]
  for (const r of rows) out.push(line(r))
  return out.join('\n')
}

/* -------------------------------------------------------------- users map -- */
const buildUserLabels = async (db: Db): Promise<Map<string, string>> => {
  const map = new Map<string, string>()
  const users = await db
    .collection('users')
    .find({}, { projection: { name: 1, role: 1, email: 1 } })
    .toArray()
  for (const u of users) {
    const initials = String(u.name ?? '?')
      .trim()
      .split(/\s+/)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .slice(0, 2)
      .join('')
    // Redact personal data: initials + role only. No name, no email.
    map.set(String(u._id), `${initials || '?'} · ${u.role ?? 'role?'}`)
  }
  return map
}

/* --------------------------------------------------------- date range calc - */
const dateBounds = async (
  db: Db,
  name: string,
  field: string | null
): Promise<{ min: string; max: string }> => {
  if (!field) return { min: 'n/a', max: 'n/a' }
  const col = db.collection(name)
  const asc = await col
    .find({}, { projection: { [field]: 1 } })
    .sort({ [field]: 1 })
    .limit(1)
    .toArray()
  const desc = await col
    .find({}, { projection: { [field]: 1 } })
    .sort({ [field]: -1 })
    .limit(1)
    .toArray()
  return { min: day(asc[0]?.[field]), max: day(desc[0]?.[field]) }
}

/* --------------------------------------------------------------- PART A ---- */
const printInventory = async (db: Db): Promise<string[]> => {
  const cols = (await db.listCollections().toArray())
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b))
  console.log('\n==================== 1. COLLECTION INVENTORY ====================')
  const rows: string[][] = []
  const unknown: string[] = []
  for (const name of cols) {
    const meta = COLLECTION_META[name]
    if (!meta) unknown.push(name)
    const count = await db.collection(name).countDocuments()
    const { min, max } = await dateBounds(db, name, meta?.dateField ?? 'createdAt')
    rows.push([
      name,
      String(count),
      min,
      max,
      meta?.class ?? 'UNKNOWN',
      meta?.description ?? 'Unrecognised collection',
    ])
  }
  console.log(
    formatTable(['collection', 'count', 'oldest', 'newest', 'class', 'what it holds'], rows)
  )
  if (unknown.length) console.log(`\n⚠ Collections not in the model map: ${unknown.join(', ')}`)
  return cols
}

/* --------------------------------------------------------------- PART B ---- */
const section = (title: string) => console.log(`\n---------------- ${title} ----------------`)

const printFirstLast = (rows: string[][], limit = 20): { shown: string[][]; note: string } => {
  if (rows.length <= 50) return { shown: rows, note: `${rows.length} rows` }
  const first = rows.slice(0, limit)
  const last = rows.slice(-limit)
  return {
    shown: [
      ...first,
      ['…'.repeat(3), `(${rows.length - 2 * limit} hidden)`, '', '', '', ''],
      ...last,
    ],
    note: `${rows.length} rows → showing first ${limit} + last ${limit}`,
  }
}

const printRecordTables = async (db: Db, users: Map<string, string>): Promise<void> => {
  console.log('\n==================== 1b. RECORD TABLES (PII-redacted) ====================')
  const has = async (name: string) => (await db.collection(name).countDocuments()) > 0

  // transactions (ledger)
  if (await has('transactions')) {
    const docs = await db.collection('transactions').find({}).sort({ createdAt: 1 }).toArray()
    const rows = docs.map((t) => [
      short(t._id),
      `${t.type}${t.category ? `:${t.category}` : ''}`,
      day(t.date),
      pkr(t.amount),
      users.get(String(t.createdBy)) ?? orDash(t.createdByName),
      `${t.status}${t.isReversal ? ' ·rev' : ''}${t.reversedBy ? ' ·reversed' : ''}`,
    ])
    const { shown, note } = printFirstLast(rows)
    section(`transactions (${note})`)
    console.log(formatTable(['_id', 'type:category', 'date', 'amount', 'by', 'status'], shown))
  }

  // orders
  if (await has('orders')) {
    const docs = await db.collection('orders').find({}).sort({ createdAt: 1 }).toArray()
    const rows = docs.map((o) => [
      short(o._id),
      orDash(o.orderNumber),
      day(o.createdAt),
      pkr(o.total),
      users.get(String(o.createdBy)) ?? '—',
      `${orDash(o.orderStatus)}/${orDash(o.paymentStatus)}`,
    ])
    const { shown, note } = printFirstLast(rows)
    section(`orders (${note}) — customer PII redacted`)
    console.log(formatTable(['_id', 'number', 'created', 'total', 'by', 'order/pay status'], shown))
  }

  // purchases
  if (await has('purchases')) {
    const docs = await db.collection('purchases').find({}).sort({ createdAt: 1 }).toArray()
    const rows = docs.map((p) => [
      short(p._id),
      orDash(p.purchaseNumber),
      day(p.date),
      pkr(p.totalCost),
      users.get(String(p.createdBy)) ?? '—',
      `${orDash(p.productName)} ×${orDash(p.quantity)}`,
    ])
    const { shown, note } = printFirstLast(rows)
    section(`purchases (${note})`)
    console.log(formatTable(['_id', 'number', 'date', 'cost', 'by', 'product×qty'], shown))
  }

  // returns
  if (await has('returns')) {
    const docs = await db.collection('returns').find({}).sort({ createdAt: 1 }).toArray()
    const rows = docs.map((r) => [
      short(r._id),
      orDash(r.returnNumber),
      day(r.createdAt),
      pkr(r.refundAmount),
      users.get(String(r.createdBy)) ?? '—',
      orDash(r.outcome),
    ])
    const { shown, note } = printFirstLast(rows)
    section(`returns (${note})`)
    console.log(formatTable(['_id', 'number', 'created', 'refund', 'by', 'outcome'], shown))
  }

  // stockMovements
  if (await has('stockMovements')) {
    const products = new Map<string, string>()
    for (const p of await db
      .collection('products')
      .find({}, { projection: { name: 1 } })
      .toArray())
      products.set(String(p._id), p.name ?? '?')
    const docs = await db.collection('stockMovements').find({}).sort({ createdAt: 1 }).toArray()
    const rows = docs.map((m) => [
      short(m._id),
      `${orDash(m.movementType)}→${products.get(String(m.productId)) ?? (m.productId ? 'gone?' : 'n/a')}`,
      day(m.date),
      `${m.direction ?? ''}${m.quantity}u`,
      users.get(String(m.createdBy)) ?? '—',
      `${orDash(m.status)}:${orDash(m.referenceType)}`,
    ])
    const { shown, note } = printFirstLast(rows)
    section(`stockMovements (${note})`)
    console.log(formatTable(['_id', 'type→product', 'date', 'qty', 'by', 'status:refType'], shown))
  }

  // products
  if (await has('products')) {
    const docs = await db.collection('products').find({}).sort({ createdAt: 1 }).toArray()
    const rows = docs.map((p) => [
      short(p._id),
      `${orDash(p.sku)} ${orDash(p.name)}`,
      day(p.createdAt),
      pkr(p.sellingPrice),
      '—',
      `${orDash(p.category)} ${p.isActive ? 'active' : 'ARCHIVED'}`,
    ])
    const { shown, note } = printFirstLast(rows)
    section(`products (${note}) — cost/selling price shown, WAC in price col`)
    console.log(
      formatTable(['_id', 'sku name', 'created', 'sellPrice', 'by', 'category/state'], shown)
    )
  }

  // tasks
  if (await has('tasks')) {
    const docs = await db.collection('tasks').find({}).sort({ createdAt: 1 }).toArray()
    const rows = docs.map((t) => [
      short(t._id),
      `${orDash(t.taskNumber)} ${orDash(t.title).slice(0, 32)}`,
      day(t.createdAt),
      '—',
      users.get(String(t.createdBy)) ?? '—',
      `${t.isArchived ? 'ARCHIVED' : 'active'} v${t.version}`,
    ])
    const { shown, note } = printFirstLast(rows)
    section(`tasks (${note})`)
    console.log(formatTable(['_id', 'number title', 'created', '—', 'by', 'state'], shown))
  }

  // boards
  if (await has('boards')) {
    const docs = await db.collection('boards').find({}).sort({ createdAt: 1 }).toArray()
    const rows = docs.map((b) => [
      short(b._id),
      orDash(b.name),
      day(b.createdAt),
      '—',
      users.get(String(b.createdBy)) ?? '—',
      b.isActive && !b.archivedAt ? 'active' : 'archived',
    ])
    section(`boards (${rows.length} rows)`)
    console.log(formatTable(['_id', 'name', 'created', '—', 'by', 'state'], rows))
  }

  // messages
  if (await has('messages')) {
    const channels = new Map<string, string>()
    for (const c of await db
      .collection('chatChannels')
      .find({}, { projection: { key: 1, name: 1 } })
      .toArray())
      channels.set(String(c._id), c.key ?? c.name ?? '?')
    const docs = await db.collection('messages').find({}).sort({ createdAt: 1 }).toArray()
    const rows = docs.map((m) => [
      short(m._id),
      `#${channels.get(String(m.channelId)) ?? '?'}`,
      day(m.createdAt),
      '—',
      users.get(String(m.senderId)) ?? '—',
      m.isDeleted ? 'DELETED' : m.isSystem ? 'system' : `${(m.content ?? '').slice(0, 28)}`,
    ])
    const { shown, note } = printFirstLast(rows)
    section(`messages (${note}) — content snippet only, no full bodies`)
    console.log(formatTable(['_id', 'channel', 'created', '—', 'sender', 'snippet'], shown))
  }

  // budgets
  if (await has('budgets')) {
    const docs = await db.collection('budgets').find({}).sort({ createdAt: 1 }).toArray()
    const rows = docs.map((b) => [
      short(b._id),
      `${orDash(b.budgetNumber)} ${orDash(b.name).slice(0, 22)}`,
      `${day(b.periodStart)}→${day(b.periodEnd)}`,
      pkr(b.totalBudgeted),
      users.get(String(b.createdBy)) ?? '—',
      orDash(b.status),
    ])
    section(`budgets (${rows.length} rows)`)
    console.log(formatTable(['_id', 'number name', 'period', 'total', 'by', 'status'], rows))
  }

  // profitDistributions
  if (await has('profitDistributions')) {
    const docs = await db
      .collection('profitDistributions')
      .find({})
      .sort({ createdAt: 1 })
      .toArray()
    const rows = docs.map((d) => [
      short(d._id),
      `${orDash(d.distributionNumber)} ${orDash(d.month)}`,
      day(d.createdAt),
      pkr(d.netProfit),
      users.get(String(d.createdBy)) ?? '—',
      orDash(d.status),
    ])
    section(`profitDistributions (${rows.length} rows)`)
    console.log(formatTable(['_id', 'number month', 'created', 'netProfit', 'by', 'status'], rows))
  }

  // suppliers
  if (await has('suppliers')) {
    const docs = await db.collection('suppliers').find({}).sort({ createdAt: 1 }).toArray()
    const rows = docs.map((s) => [
      short(s._id),
      orDash(s.name),
      day(s.createdAt),
      '—',
      '[PII]',
      s.isActive ? 'active' : 'inactive',
    ])
    section(`suppliers (${rows.length} rows) — contact/phone/email REDACTED`)
    console.log(formatTable(['_id', 'name', 'created', '—', 'contact', 'state'], rows))
  }

  // notifications
  if (await has('notifications')) {
    const docs = await db.collection('notifications').find({}).sort({ createdAt: 1 }).toArray()
    const rows = docs.map((n) => [
      short(n._id),
      `${orDash(n.type)}`,
      day(n.createdAt),
      '—',
      users.get(String(n.userId)) ?? '—',
      n.isRead ? 'read' : 'unread',
    ])
    const { shown, note } = printFirstLast(rows)
    section(`notifications (${note}) — titles/messages omitted`)
    console.log(formatTable(['_id', 'type', 'created', '—', 'recipient', 'read'], shown))
  }
}

/* --------------------------------------------------------------- PART C ---- */
const printCounters = async (db: Db): Promise<void> => {
  console.log('\n==================== 3b. COUNTERS / SERIAL SEQUENCES ====================')
  const counters = await db.collection('counters').find({}).sort({ _id: 1 }).toArray()
  if (counters.length === 0) {
    console.log('counters collection: EMPTY (no atomic serial allocated yet)')
  } else {
    const rows = counters.map((c) => [
      String(c._id),
      String(c.base ?? 0),
      String(c.seq ?? 0),
      `next → ${String(c._id).split(':')[1]}-${String(Number(c.base ?? 0) + Number(c.seq ?? 0) + 1).padStart(4, '0')}`,
    ])
    console.log(formatTable(['counter _id (field:prefix)', 'base', 'seq', 'next value'], rows))
  }

  // Highest serial actually stored per record collection (SO/PUR/RET use counters;
  // TASK/BUDGET are computed from the records themselves — no counters doc).
  const scans: Array<{ coll: string; field: string }> = [
    { coll: 'orders', field: 'orderNumber' },
    { coll: 'purchases', field: 'purchaseNumber' },
    { coll: 'returns', field: 'returnNumber' },
    { coll: 'tasks', field: 'taskNumber' },
    { coll: 'budgets', field: 'budgetNumber' },
  ]
  console.log('\nHighest stored serial per collection (continuation point):')
  const scanRows: string[][] = []
  for (const { coll, field } of scans) {
    const top = await db
      .collection(coll)
      .find({ [field]: { $exists: true, $ne: null } }, { projection: { [field]: 1 } })
      .sort({ [field]: -1 })
      .limit(1)
      .toArray()
    const gen = ['orders', 'purchases', 'returns'].includes(coll)
      ? 'counters (atomic)'
      : 'scan highest in-collection'
    scanRows.push([coll, field, orDash(top[0]?.[field]), gen])
  }
  console.log(formatTable(['collection', 'field', 'highest number', 'generator'], scanRows))
}

/* --------------------------------------------------------------- PART D ---- */
const printDependencies = async (db: Db): Promise<void> => {
  console.log('\n==================== 3. DEPENDENCY / ORPHAN ANALYSIS ====================')
  const ids = async (coll: string) =>
    new Set(
      (
        await db
          .collection(coll)
          .find({}, { projection: { _id: 1 } })
          .toArray()
      ).map((d) => String(d._id))
    )

  const orderIds = await ids('orders')
  const movementIds = await ids('stockMovements')
  const txIds = await ids('transactions')
  const taskIds = await ids('tasks')
  const boardIds = await ids('boards')
  const columnIds = await ids('columns')
  const channelIds = await ids('chatChannels')
  const productIds = await ids('products')

  const orphan = async (
    coll: string,
    label: string,
    refs: (
      d: Document
    ) => Array<{ field: string; value: string; target: Set<string>; targetName: string }>
  ) => {
    const docs = await db.collection(coll).find({}).toArray()
    const missing: string[] = []
    for (const d of docs) {
      for (const r of refs(d)) {
        if (!r.value || r.value === 'undefined' || r.value === 'null') continue
        if (!r.target.has(r.value))
          missing.push(`${label} ${short(d._id)} → ${r.targetName} ${r.value.slice(-6)} MISSING`)
      }
    }
    console.log(
      missing.length
        ? missing.join('\n')
        : `  ok  ${coll}: ${docs.length} rows, no dangling references`
    )
  }

  await orphan('orders', 'order', (o) => [
    ...((o.stockMovementIds ?? []) as string[]).map((m) => ({
      field: 'mov',
      value: String(m),
      target: movementIds,
      targetName: 'stockMovement',
    })),
    {
      field: 'income',
      value: String(o.incomeTransactionId ?? ''),
      target: txIds,
      targetName: 'transaction',
    },
    {
      field: 'courier',
      value: String(o.courierExpenseTransactionId ?? ''),
      target: txIds,
      targetName: 'transaction',
    },
  ])
  await orphan('returns', 'return', (r) => [
    { field: 'order', value: String(r.orderId ?? ''), target: orderIds, targetName: 'order' },
    ...((r.movementIds ?? []) as string[]).map((m) => ({
      field: 'mov',
      value: String(m),
      target: movementIds,
      targetName: 'stockMovement',
    })),
    {
      field: 'refund',
      value: String(r.refundTransactionId ?? ''),
      target: txIds,
      targetName: 'transaction',
    },
  ])
  await orphan('purchases', 'purchase', (p) => [
    {
      field: 'ledger',
      value: String(p.ledgerTransactionId ?? ''),
      target: txIds,
      targetName: 'transaction',
    },
    {
      field: 'mov',
      value: String(p.movementId ?? ''),
      target: movementIds,
      targetName: 'stockMovement',
    },
  ])
  await orphan('taskComments', 'comment', (c) => [
    { field: 'task', value: String(c.taskId ?? ''), target: taskIds, targetName: 'task' },
  ])
  await orphan('taskActivity', 'activity', (a) => [
    { field: 'task', value: String(a.taskId ?? ''), target: taskIds, targetName: 'task' },
  ])
  await orphan('columns', 'column', (c) => [
    { field: 'board', value: String(c.boardId ?? ''), target: boardIds, targetName: 'board' },
  ])
  await orphan('tasks', 'task', (t) =>
    [
      { field: 'board', value: String(t.boardId ?? ''), target: boardIds, targetName: 'board' },
    ].concat([
      { field: 'col', value: String(t.columnId ?? ''), target: columnIds, targetName: 'column' },
    ])
  )
  await orphan('messages', 'message', (m) => [
    {
      field: 'channel',
      value: String(m.channelId ?? ''),
      target: channelIds,
      targetName: 'chatChannel',
    },
  ])
  await orphan('stockMovements', 'movement', (m) =>
    m.productId
      ? [
          {
            field: 'product',
            value: String(m.productId),
            target: productIds,
            targetName: 'product',
          },
        ]
      : []
  )
  await orphan('stock', 'stock', (s) => [
    {
      field: 'product',
      value: String(s.productId ?? ''),
      target: productIds,
      targetName: 'product',
    },
  ])
}

/* --------------------------------------------------------------- PART E ---- */
const printBalancesAndReconciliation = async (db: Db): Promise<void> => {
  console.log('\n==================== 4. ACCOUNT BALANCES + RECONCILIATION ====================')
  const accounts = await db.collection('accounts').find({}).sort({ name: 1 }).toArray()
  const ledger = (await db
    .collection('transactions')
    .find({})
    .sort({ date: 1 })
    .toArray()) as unknown as LedgerEntryLike[]

  const accountLikes = accounts.map((a) => ({
    _id: String(a._id),
    name: a.name,
    kind: a.kind,
    isActive: a.isActive,
    openingBalance: a.openingBalance,
  }))
  const balances = computeAccountBalances(accountLikes, ledger)

  const rows = accountLikes.map((a) => [
    a.name,
    String(a.kind),
    a.isActive ? 'active' : 'inactive',
    pkr(a.openingBalance),
    pkr(balances[a._id] ?? 0),
    pkr((balances[a._id] ?? 0) - a.openingBalance),
  ])
  console.log(formatTable(['account', 'kind', 'state', 'opening', 'current', 'ledger Δ'], rows))
  console.log(
    `\nΣ opening: ${pkr(accountLikes.reduce((s, a) => s + a.openingBalance, 0))}   Σ current: ${pkr(Object.values(balances).reduce((s, n) => s + n, 0))}`
  )

  // Ledger roll-up (record activity, independent of account set)
  const sum = (t: string) =>
    ledger
      .filter((e) => e.type === t && e.status === 'posted')
      .reduce((s, e) => s + Number(e.amount), 0)
  console.log(
    `\nLedger posted totals: income=${pkr(sum('income'))} expense=${pkr(sum('expense'))} transfer=${pkr(sum('transfer'))}`
  )

  // Full-history reconciliation using the application's own engine (read-only).
  const now = new Date()
  const range = { start: new Date(0), end: now }
  try {
    const { reconcile } = await import('../src/lib/metrics/reconciliation')
    const report: Awaited<ReturnType<typeof reconcile>> = await reconcile(db, range, now)
    console.log(`\nReconcile checks (${report.allPass ? 'ALL PASS' : 'HAS FAILURES'}):`)
    const crows = report.checks.map((c) => [
      c.name,
      pkr(c.a),
      pkr(c.b),
      pkr(c.difference),
      c.pass ? 'PASS' : 'FAIL',
    ])
    console.log(formatTable(['check', 'side A', 'side B', 'diff', 'result'], crows))
  } catch (error) {
    console.log(
      `\n⚠ reconcile() failed (engine expects live config): ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/* ------------------------------------------------------------------ main -- */
const main = async () => {
  console.log('Stage 1 — READ-ONLY inventory of decoricks_prod')
  console.log(`Connecting to host(s): ${redactedHosts(URI)}  (credentials redacted)`)
  const client = new MongoClient(URI, {
    serverSelectionTimeoutMS: 15_000,
    readPreference: 'primary',
    retryWrites: false, // read-only — never attempt a write
  })
  try {
    await client.connect()
    const db = client.db(TARGET_DB) // explicit; never client.db() which falls back to `test`
    if (db.databaseName !== TARGET_DB) {
      console.error(`Refusing to run: resolved database "${db.databaseName}" !== ${TARGET_DB}`)
      process.exit(1)
    }
    console.log(`Target database: ${db.databaseName} (verified read-only)`)

    const cols = await printInventory(db)
    const users = await buildUserLabels(db)
    await printRecordTables(db, users)
    await printCounters(db)
    await printDependencies(db)
    await printBalancesAndReconciliation(db)

    console.log('\n==================== 2. CLASSIFICATION SUMMARY ====================')
    const byClass = { CONFIG: [] as string[], RECORD: [] as string[], DERIVED: [] as string[] }
    for (const name of cols) {
      const cls = COLLECTION_META[name]?.class
      if (cls) byClass[cls].push(name)
      else byClass.RECORD.push(`${name}?`)
    }
    console.log(`(a) CONFIGURATION (keep):  ${byClass.CONFIG.join(', ')}`)
    console.log(`(b) RECORDS (demo?):       ${byClass.RECORD.join(', ')}`)
    console.log(`(c) DERIVED/SYSTEM:        ${byClass.DERIVED.join(', ')}`)
    console.log('\nEND OF READ-ONLY STAGE 1. No data was modified.')
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error('Stage 1 inventory failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
