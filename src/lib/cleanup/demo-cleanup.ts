import { ObjectId, type ClientSession, type Db, type Document } from 'mongodb'

/**
 * Stage 2 — DEMO-data cleanup primitives for `decoricks_prod`.
 *
 * The frozen id set below comes from the Stage 1 READ-ONLY inventory
 * (`scripts/stage1-demo-inventory.ts`, run 2026-10-25) and the explicit ids the
 * operator approved. The operator confirmed **every** record in those
 * collections is demo/testing data — nothing real — so the whole live count of
 * each of these collections is expected to equal the id list. That equality is
 * the drift gate: `verifyNoDrift` aborts if a collection holds more documents
 * than the manifest (a surprise real record appeared) or fewer (a listed id is
 * gone), so the deletion never runs against a shape it did not freeze.
 *
 * Deletion is always `deleteMany({ _id: { $in: [<explicit ids>] } })` — never
 * `deleteMany({})`, never a regex/prefix sweep. CONFIG (users, roles,
 * businessSettings, accounts + opening balances, financeCategories, taskLabels,
 * auditLog, the three seeded chatChannels, the live session) and the legacy empty
 * income/expenses/transfers are out of scope and untouched.
 */

export interface DemoManifestEntry {
  collection: string
  ids: string[]
}

/** Configuration counts that MUST be intact before and after the cleanup (prod baseline). */
export const CONFIG_BASELINE_PROD: Record<string, number> = {
  users: 4,
  roles: 4,
  businessSettings: 1,
  accounts: 3,
  financeCategories: 13,
  taskLabels: 0,
  chatChannels: 3,
}

/** The 56 demo records, by explicit `_id`, grouped by collection. */
export const DEMO_MANIFEST: DemoManifestEntry[] = [
  {
    collection: 'transactions',
    ids: ['6ad3e0739cd860a3309f5cd7', '6adcbda77f242a6a5bb28430'],
  },
  { collection: 'boards', ids: ['6addd126e494d8026fe0f6d5'] },
  {
    collection: 'columns',
    ids: [
      '6addd126e494d8026fe0f6d6',
      '6addd126e494d8026fe0f6d7',
      '6addd126e494d8026fe0f6d8',
      '6addd126e494d8026fe0f6d9',
      '6addd147e494d8026fe0f6db',
    ],
  },
  {
    collection: 'tasks',
    ids: ['6addd16fe494d8026fe0f6dd', '6addd372e494d8026fe0f6f1'],
  },
  {
    collection: 'taskActivity',
    ids: [
      '6addd16fe494d8026fe0f6de',
      '6addd173e494d8026fe0f6e0',
      '6addd179e494d8026fe0f6e2',
      '6addd179e494d8026fe0f6e3',
      '6addd19fe494d8026fe0f6e5',
      '6addd19fe494d8026fe0f6e6',
      '6addd1a3e494d8026fe0f6e8',
      '6addd1a5e494d8026fe0f6ea',
      '6addd1a9e494d8026fe0f6ec',
      '6addd1ace494d8026fe0f6ee',
      '6addd372e494d8026fe0f6f2',
      '6addd37be494d8026fe0f6f4',
      '6addd37ce494d8026fe0f6f6',
      '6addd387e494d8026fe0f6f8',
      '6addd38ae494d8026fe0f6fa',
    ],
  },
  {
    collection: 'messages',
    ids: [
      '6ac2a55ea6c654876a1aba5a',
      '6ac91d790055d24f3ddbf8de',
      '6ac91e5e0055d24f3ddbf8e6',
      '6acd28ff82b25cd2f2e5c15b',
      '6acfcbf2b6548d24c7cf58c4',
      '6acfcc47b6548d24c7cf58c7',
      '6acfcc50b6548d24c7cf58c8',
      '6acfcca7b6548d24c7cf58cb',
      '6ad3a9a09eaa1db9f019d55b',
      '6ad3a9c549d4ed6628465986',
      '6ad3a9d69eaa1db9f019d55e',
      '6ad3a9d649d4ed6628465987',
      '6ad3a9ee9eaa1db9f019d55f',
      '6ad4ddc174310beb5d6d67e8',
      '6adcc0597f242a6a5bb28434',
      '6adcc05c7f242a6a5bb28436',
      '6adcc05c7f242a6a5bb28435',
      '6adcc05d7f242a6a5bb28438',
      '6adcc05d7f242a6a5bb28437',
      '6adcc05e7f242a6a5bb28439',
      '6adcc07f7f242a6a5bb2843a',
      '6addd3bde494d8026fe0f6fc',
    ],
  },
  {
    collection: 'chatChannelReads',
    ids: [
      '6acfcbd95e5b16efe47d7d3b',
      '6acfcbdc5e5b16efe47d7d3e',
      '6acfcbdf5e5b16efe47d7d3f',
      '6acfcc2a5e5b16efe47d7d52',
      '6acfcc2d5e5b16efe47d7d53',
    ],
  },
  { collection: 'budgets', ids: ['6ad3dece263ec32c2353706e'] },
  { collection: 'profitDistributions', ids: ['6ad63ec71e84915aea9059ea'] },
  { collection: 'notifications', ids: ['6ad63ec71e84915aea9059ec', '6adcc07f7f242a6a5bb2843b'] },
]

/** Expected total across the manifest — the operator's frozen figure. */
export const EXPECTED_TOTAL = DEMO_MANIFEST.reduce((s, e) => s + e.ids.length, 0)

export interface DriftReport {
  ok: boolean
  totalExpected: number
  totalPresent: number
  perCollection: Array<{
    collection: string
    expected: number
    live: number
    present: number
    missing: string[]
    extra: number
  }>
  reasons: string[]
}

/**
 * Re-verify the frozen set against the LIVE database. Never deletes.
 *
 * `ok` is true only when, for every manifest entry, the live document count
 * equals the number of ids AND every listed id still exists. Extra live
 * documents (a record that appeared after Stage 1) or a missing listed id both
 * fail: the deletion must never run against a database whose shape differs from
 * the one that was reviewed.
 */
export const verifyNoDrift = async (db: Db): Promise<DriftReport> => {
  const perCollection: DriftReport['perCollection'] = []
  const reasons: string[] = []
  let totalPresent = 0

  for (const entry of DEMO_MANIFEST) {
    const col = db.collection(entry.collection)
    const live = await col.countDocuments()
    const objectIds = entry.ids.map((id) => new ObjectId(id))
    const found = await col.find({ _id: { $in: objectIds } }, { projection: { _id: 1 } }).toArray()
    const presentIds = new Set(found.map((d) => String(d._id)))
    const missing = entry.ids.filter((id) => !presentIds.has(id))
    const present = presentIds.size
    totalPresent += present
    const extra = live - present

    perCollection.push({
      collection: entry.collection,
      expected: entry.ids.length,
      live,
      present,
      missing,
      extra,
    })

    if (missing.length > 0)
      reasons.push(
        `${entry.collection}: ${missing.length} frozen id(s) not present (${missing.join(', ')})`
      )
    if (extra > 0)
      reasons.push(
        `${entry.collection}: ${extra} unexpected live document(s) beyond the frozen set — refusing to assume they are demo`
      )
  }

  return {
    ok: reasons.length === 0,
    totalExpected: EXPECTED_TOTAL,
    totalPresent,
    perCollection,
    reasons,
  }
}

export interface DeleteResult {
  perCollection: Array<{ collection: string; expected: number; deleted: number }>
  totalDeleted: number
}

/**
 * Delete exactly the frozen ids, `deleteMany({ _id: { $in: [...] } })` per
 * collection — never a bare `deleteMany({})`. Pass `session` to run the caller's
 * deletions inside one transaction.
 */
export const deleteDemoDocs = async (
  db: Db,
  opts: { session?: ClientSession } = {}
): Promise<DeleteResult> => {
  const session = opts.session
  const perCollection: DeleteResult['perCollection'] = []
  let totalDeleted = 0

  for (const entry of DEMO_MANIFEST) {
    const objectIds = entry.ids.map((id) => new ObjectId(id))
    const res = await db
      .collection(entry.collection)
      .deleteMany({ _id: { $in: objectIds } } as never, session ? { session } : {})
    const deleted = res.deletedCount ?? 0
    perCollection.push({ collection: entry.collection, expected: entry.ids.length, deleted })
    totalDeleted += deleted
  }

  return { perCollection, totalDeleted }
}

/**
 * The single append-only audit record for the cleanup. Shaped exactly like every
 * other `auditLog` document (SPEC §3.1.19) — it is inserted, never updated.
 */
export const buildCleanupAuditDoc = (input: {
  database: string
  counts: Record<string, number>
  totalDeleted: number
  backupSha256: string
  operator: string
  mode: 'transaction' | 'ordered-checkpoint'
}): Document => ({
  userId: null,
  userEmail: 'system',
  action: 'demo_data_cleanup',
  entityType: 'database',
  entityId: null,
  oldValue: undefined,
  newValue: {
    database: input.database,
    perCollection: input.counts,
    totalDeleted: input.totalDeleted,
    backupSha256: input.backupSha256,
    operator: input.operator,
    mode: input.mode,
  },
  details: `Removed ${input.totalDeleted} frozen DEMO document(s) from "${input.database}" via scripts/cleanup-demo-data.ts (mode=${input.mode}, backup sha256=${input.backupSha256}).`,
  outcome: 'success',
  createdAt: new Date(),
})

export interface ZeroActivityResult {
  ok: boolean
  details: string[]
}

/**
 * Post-cleanup assertion: the ledger is empty and every account sits at its
 * opening balance, so revenue/expenses/net profit are all zero and there is no
 * inventory value. This is the "zero activity with opening balances intact"
 * target the operator reviewed in Stage 1 — computed directly from the stored
 * documents, independent of the reconcile engine (reconcile is run separately and
 * must also report all-pass).
 */
export const assertZeroActivity = async (db: Db): Promise<ZeroActivityResult> => {
  const details: string[] = []
  let ok = true

  const ledgerCount = await db.collection('transactions').countDocuments()
  if (ledgerCount !== 0) {
    ok = false
    details.push(`FAIL transactions still present: ${ledgerCount} (expected 0)`)
  } else {
    details.push('ok transactions = 0 (no revenue/expense/net activity)')
  }

  const accounts = await db.collection('accounts').find({}).toArray()
  const ledger = (await db.collection('transactions').find({}).toArray()) as Document[]
  for (const a of accounts) {
    // With no ledger rows, the balance must equal the stored opening balance.
    const opening = Number(a.openingBalance ?? 0)
    const delta = ledger.reduce((sum, e) => {
      const ids = [e.accountId, e.fromAccountId, e.toAccountId].filter(
        (x) => x && String(x) === String(a._id)
      )
      if (ids.length === 0) return sum
      const sign =
        e.type === 'expense' || e.type === 'partner_withdrawal'
          ? -1
          : e.type === 'transfer'
            ? e.fromAccountId && String(e.fromAccountId) === String(a._id)
              ? -1
              : 1
            : 1
      const amt = Number(e.amount ?? 0) * (e.isReversal ? -1 : 1)
      return sum + sign * amt
    }, 0)
    const balance = opening + delta
    if (balance !== opening) {
      ok = false
      details.push(`FAIL account "${a.name}" balance ${balance} != opening ${opening}`)
    } else {
      details.push(`ok account "${a.name}" at opening balance ${opening}`)
    }
  }

  const stockCount = await db.collection('stock').countDocuments()
  const productCount = await db.collection('products').countDocuments()
  if (stockCount !== 0 || productCount !== 0) {
    ok = false
    details.push(
      `FAIL inventory not empty: stock=${stockCount} products=${productCount} (expected 0/0)`
    )
  } else {
    details.push('ok inventory value = 0 (no products/stock)')
  }

  return { ok, details }
}
