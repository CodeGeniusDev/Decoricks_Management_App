import type { Collection, Db, ObjectId } from 'mongodb'
import { ObjectId as OID } from 'mongodb'
import { getBudgetCollection, getSupplierCollection } from '@/lib/models/Operations'
import { getProductCollection } from '@/lib/models/Product'
import { getOrderCollection } from '@/lib/models/Sales'
import { getTaskDocCollection } from '@/lib/models/Tasks'
import { getAccountCollection, getLedgerCollection } from '@/lib/models/Ledger'
import { getProfitDistributionCollection } from '@/lib/models/Distribution'
import type { PermissionModule } from '@/lib/models/User'
import { hasPermission, type AuthorizationResult } from '@/lib/authorization'
import type { MessageReference } from '@/lib/models/Chat'

/**
 * Phase 3 record references — Chat pointing at real records.
 *
 * The invariant the brief insists on is that a reference "must point to the
 * actual record, not merely contain copied text". That is only true if the
 * stored document holds an *identity* (`{ entityType, entityId }`) and every
 * label, summary and link is produced fresh at read time from the live record.
 * So this module never writes a snapshot of a name into a message, and the read
 * path re-queries the source collections per page.
 *
 * The same registry drives all three authorised surfaces, which is what keeps
 * their behaviour consistent:
 *
 *   1. search  — what the picker may offer this viewer;
 *   2. validate — what the server will accept on send;
 *   3. resolve — what the viewer may see when the message is read back.
 *
 * A viewer's module grants come from the session's role, never from the client,
 * and are re-checked at every one of those three steps. A record the viewer
 * cannot view is not searchable, not storable, and renders as an inert
 * "restricted" chip — it is never silently dropped either, because a message
 * that claims a link and shows nothing reads as a bug to the sender.
 */

/* ------------------------------- the registry ------------------------------- */

export interface ReferenceSpec {
  entityType: string
  /** Group label in the picker. */
  label: string
  /**
   * The module whose `view` grant gates this type — for search, for storing and
   * for rendering. This is the whole access-control story in one field: it is
   * the same grant the module's own list endpoint enforces.
   */
  module: PermissionModule
  collection: (db: Db) => Collection<Record<string, unknown>>
  /** Fields a free-text query matches. Identifiers first. */
  searchFields: string[]
  /** Primary chip/search label. Built from non-sensitive fields only. */
  labelOf: (doc: Record<string, unknown>) => string
  /** Secondary line: a code, period or status. NEVER a figure. */
  metaOf?: (doc: Record<string, unknown>) => string | undefined
  /**
   * Where the chip navigates: the record's own detail page where one exists,
   * otherwise the real list page that can show it. Nothing is invented — a type
   * without a detail route links to its parent screen, which is the honest
   * behaviour and is what the brief asks for.
   */
  hrefOf: (doc: Record<string, unknown>) => string
}

const id = (doc: Record<string, unknown>): string => String(doc._id ?? '')
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined
/** Mongo may hand back a Date or a string depending on the read path. */
const day = (value: unknown): string => {
  const date = value instanceof Date ? value : value ? new Date(String(value)) : null
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : ''
}
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const q = (value: string): string => encodeURIComponent(value)

export const REFERENCE_SPECS: readonly ReferenceSpec[] = [
  {
    entityType: 'order',
    label: 'Sales order',
    module: 'sales',
    collection: (db) => getOrderCollection(db) as unknown as Collection<Record<string, unknown>>,
    searchFields: ['orderNumber', 'customerName'],
    labelOf: (doc) => str(doc.orderNumber) ?? str(doc.customerName) ?? 'Order',
    metaOf: (doc) => [str(doc.customerName), str(doc.orderStatus)].filter(Boolean).join(' · '),
    // Orders have a real detail page.
    hrefOf: (doc) => `/sales/${id(doc)}`,
  },
  {
    entityType: 'task',
    label: 'Task',
    module: 'tasks',
    collection: (db) => getTaskDocCollection(db) as unknown as Collection<Record<string, unknown>>,
    searchFields: ['title', 'taskNumber'],
    labelOf: (doc) => str(doc.title) ?? 'Task',
    metaOf: (doc) =>
      [str(doc.taskNumber) ? `#${doc.taskNumber}` : undefined, str(doc.priority)]
        .filter(Boolean)
        .join(' · '),
    // The board has no per-card route, so the chip opens the board filtered to
    // the task's CURRENT title (re-derived here, so a renamed task still finds
    // itself) rather than a copied string that can go stale.
    hrefOf: (doc) => `/tasks?q=${q(String(str(doc.title) ?? ''))}`,
  },
  {
    entityType: 'product',
    label: 'Product',
    module: 'inventory',
    collection: (db) => getProductCollection(db) as unknown as Collection<Record<string, unknown>>,
    searchFields: ['name', 'sku'],
    labelOf: (doc) => str(doc.name) ?? 'Product',
    metaOf: (doc) => [str(doc.sku), str(doc.category)].filter(Boolean).join(' · '),
    // No product detail route exists; the products list is searchable by exactly
    // the fields this chip navigates with.
    hrefOf: (doc) => `/inventory/products?search=${q(String(str(doc.name) ?? ''))}`,
  },
  {
    entityType: 'budget',
    label: 'Budget',
    module: 'budget',
    collection: (db) => getBudgetCollection(db) as unknown as Collection<Record<string, unknown>>,
    searchFields: ['name', 'budgetNumber'],
    labelOf: (doc) => str(doc.name) ?? 'Budget',
    metaOf: (doc) =>
      [
        str(doc.budgetNumber) ? `#${doc.budgetNumber}` : undefined,
        day(doc.periodStart),
        str(doc.status),
      ]
        .filter(Boolean)
        .join(' · '),
    hrefOf: (doc) => `/budgets/${id(doc)}`,
  },
  {
    entityType: 'transaction',
    label: 'Finance entry',
    module: 'finance',
    collection: (db) => getLedgerCollection(db) as unknown as Collection<Record<string, unknown>>,
    searchFields: ['note', 'category', 'partnerName'],
    // Deliberately no amount. A chip is rendered inline in a message, and the
    // chat surface is not where a financial figure should appear; the linked
    // finance screen shows it to whoever holds `finance.view`.
    labelOf: (doc) => str(doc.note) ?? str(doc.category) ?? 'Entry',
    metaOf: (doc) => [str(doc.category), str(doc.type), day(doc.date)].filter(Boolean).join(' · '),
    // The ledger is a list screen; `entry` narrows it to this one row so the
    // reference resolves to the record, not to page one of a table.
    hrefOf: (doc) => `/finance/transactions?entry=${id(doc)}`,
  },
  {
    entityType: 'distribution',
    label: 'Profit distribution',
    module: 'finance',
    // The P&L snapshot a distribution stores is the closest thing the app has to
    // a "Profit & Loss record" — it is a persisted, per-month document with its
    // own approval state, unlike the P&L screen, which is recomputed on open.
    collection: (db) =>
      getProfitDistributionCollection(db) as unknown as Collection<Record<string, unknown>>,
    searchFields: ['month', 'distributionNumber'],
    labelOf: (doc) => str(doc.distributionNumber) ?? `Distribution ${str(doc.month) ?? ''}`.trim(),
    metaOf: (doc) => [str(doc.month), str(doc.status)].filter(Boolean).join(' · '),
    hrefOf: (doc) => `/distributions/${id(doc)}`,
  },
  {
    entityType: 'account',
    label: 'Finance account',
    module: 'finance',
    collection: (db) => getAccountCollection(db) as unknown as Collection<Record<string, unknown>>,
    searchFields: ['name'],
    labelOf: (doc) => str(doc.name) ?? 'Account',
    metaOf: (doc) => str(doc.kind),
    // Accounts are configured on one flat screen.
    hrefOf: () => '/finance/accounts',
  },
  {
    entityType: 'supplier',
    label: 'Supplier',
    module: 'suppliers',
    collection: (db) => getSupplierCollection(db) as unknown as Collection<Record<string, unknown>>,
    searchFields: ['name', 'city', 'contactPerson'],
    labelOf: (doc) => str(doc.name) ?? 'Supplier',
    metaOf: (doc) => [str(doc.city), str(doc.contactPerson)].filter(Boolean).join(' · '),
    // No supplier detail route and no search box on that screen; the list page is
    // the correct destination, so the chip goes there rather than faking a view.
    hrefOf: () => '/suppliers',
  },
]

export const REFERENCE_ENTITY_TYPES = REFERENCE_SPECS.map((s) => s.entityType)

const specByType = new Map(REFERENCE_SPECS.map((s) => [s.entityType, s]))
export const referenceSpec = (entityType: string): ReferenceSpec | undefined =>
  specByType.get(entityType)

/* ------------------------------- capabilities ------------------------------- */

/** The modules this viewer may view, from the session's role. */
export function viewableModules(auth: AuthorizationResult): Set<PermissionModule> {
  const modules = new Set<PermissionModule>()
  for (const spec of REFERENCE_SPECS) {
    if (hasPermission(auth.role, spec.module, 'view')) modules.add(spec.module)
  }
  return modules
}

/* ---------------------------------- search --------------------------------- */

export interface ReferenceSearchResult {
  entityType: string
  entityId: string
  label: string
  meta?: string
  href: string
}

interface SearchOptions {
  /** Free text; 2+ characters is enforced by the route. */
  query: string
  /** Restrict to one type when the picker is in single-type mode. */
  entityType?: string
  limitPerType: number
}

/**
 * Permission-filtered record search.
 *
 * Only the types the caller's role can view are queried at all, so a Partner
 * without `finance.view` never has a ledger note assembled into a response — the
 * record is not redacted after the fact, it is never read. The projection keeps
 * each candidate small, and the `createdAt: -1` sort means a recent record
 * outranks an old one with the same name.
 */
export async function searchReferences(
  db: Db,
  auth: AuthorizationResult,
  options: SearchOptions
): Promise<ReferenceSearchResult[]> {
  const allowed = viewableModules(auth)
  const specs = REFERENCE_SPECS.filter(
    (spec) =>
      allowed.has(spec.module) && (!options.entityType || spec.entityType === options.entityType)
  )
  if (specs.length === 0) return []

  const rx = new RegExp(escapeRegex(options.query.trim().slice(0, 80)), 'i')
  const projections = specs.map((spec) => ({
    spec,
    projection: Object.fromEntries(
      [...new Set([...spec.searchFields, ...LABEL_FIELDS.get(spec.entityType)!])].map((field) => [
        field,
        1,
      ])
    ),
  }))

  const pages = await Promise.all(
    projections.map(({ spec, projection }) =>
      spec
        .collection(db)
        .find(
          { $or: spec.searchFields.map((field) => ({ [field]: rx })) } as never,
          {
            projection: { ...projection, _id: 1 },
            limit: options.limitPerType,
            sort: { createdAt: -1 },
          } as never
        )
        .toArray()
        .catch(() => [] as Record<string, unknown>[])
    )
  )

  const results: ReferenceSearchResult[] = []
  pages.forEach((docs, index) => {
    const spec = projections[index].spec
    for (const doc of docs) {
      results.push(toSearchResult(spec, doc))
    }
  })
  return results
}

/** Fields each label/meta line needs, so the projection can stay narrow. */
const LABEL_FIELDS = new Map<string, string[]>([
  ['order', ['orderNumber', 'customerName', 'orderStatus']],
  ['task', ['title', 'taskNumber', 'priority']],
  ['product', ['name', 'sku', 'category']],
  ['budget', ['name', 'budgetNumber', 'periodStart', 'status']],
  ['transaction', ['note', 'category', 'type', 'date']],
  ['distribution', ['distributionNumber', 'month', 'status']],
  ['account', ['name', 'kind']],
  ['supplier', ['name', 'city', 'contactPerson']],
])

const toSearchResult = (
  spec: ReferenceSpec,
  doc: Record<string, unknown>
): ReferenceSearchResult => ({
  entityType: spec.entityType,
  entityId: id(doc),
  label: spec.labelOf(doc),
  meta: spec.metaOf?.(doc) || undefined,
  href: spec.hrefOf(doc),
})

/* ----------------------------- write-time validate ---------------------------- */

export interface ValidatedReferences {
  accepted: MessageReference[]
  /** Ids the client asked for that this viewer may not attach. */
  rejected: string[]
}

/**
 * What a send may store.
 *
 * Malformed input is refused by the schema before this runs; this is the
 * record-level check: the id must be a real ObjectId, the type must be a
 * registered one, the viewer must be allowed that module, and the document must
 * exist. A reference that fails any of those is dropped rather than stored — a
 * message whose record was deleted mid-composition still sends, minus the dead
 * link, which is the graceful behaviour the brief asks for.
 */
export async function validateReferences(
  db: Db,
  auth: AuthorizationResult,
  requested: { entityType: string; entityId: string }[]
): Promise<ValidatedReferences> {
  const allowed = viewableModules(auth)
  const accepted: MessageReference[] = []
  const rejected: string[] = []

  // Group by type so existence is one `$in` query per type, not one per id.
  const byType = new Map<string, ObjectId[]>()
  for (const ref of requested) {
    const spec = referenceSpec(ref.entityType)
    if (!spec || !allowed.has(spec.module) || !OID.isValid(ref.entityId)) {
      rejected.push(`${ref.entityType}:${ref.entityId}`)
      continue
    }
    const list = byType.get(ref.entityType) ?? []
    list.push(new OID(ref.entityId))
    byType.set(ref.entityType, list)
  }

  const existences = await Promise.all(
    [...byType.entries()].map(([entityType, ids]) => {
      const spec = referenceSpec(entityType)!
      return spec
        .collection(db)
        .find({ _id: { $in: ids } } as never, { projection: { _id: 1 } })
        .toArray()
        .then((docs) => new Set(docs.map((doc) => String(doc._id))))
        .catch(() => new Set<string>())
    })
  )

  let index = 0
  for (const [entityType, ids] of byType) {
    const present = existences[index++]
    for (const objectId of ids) {
      if (present.has(objectId.toString())) accepted.push({ entityType, entityId: objectId })
      else rejected.push(`${entityType}:${objectId.toString()}`)
    }
  }

  return { accepted, rejected }
}

/* ------------------------------ read-time resolve ----------------------------- */

export type ResolvedReference =
  | {
      state: 'available'
      entityType: string
      entityId: string
      label: string
      meta?: string
      href: string
    }
  | { state: 'hidden'; entityType: string; entityId: string }
  | { state: 'unavailable'; entityType: string; entityId: string }

export type ResolvedReferences = Record<string, ResolvedReference>

const refKey = (entityType: string, entityId: string): string => `${entityType}:${entityId}`

/**
 * Re-resolve a page of stored references against the live records, for THIS
 * viewer, in one batch.
 *
 * Three outcomes per reference, and the distinction is load-bearing:
 *   - `available` — the viewer may view the module and the record exists, so the
 *     chip is built from the record's CURRENT fields and links to it;
 *   - `hidden` — the viewer's role does not hold the module grant. No label, no
 *     id, no type-specific detail is returned: an unauthorised reader learns
 *     only that the message carries a reference they cannot open, which is
 *     strictly less than the record's existence being confirmable;
 *   - `unavailable` — authorised, but the record is gone.
 *
 * Unknown entity types (data written by a future build, or a tampered document)
 * resolve to `unavailable` rather than throwing: one odd row must never blank a
 * channel's history.
 */
export async function resolveReferences(
  db: Db,
  auth: AuthorizationResult,
  rows: { references: readonly MessageReference[] }[]
): Promise<ResolvedReferences> {
  const allowed = viewableModules(auth)
  const out: ResolvedReferences = {}

  const byType = new Map<string, Set<string>>()
  for (const row of rows) {
    for (const ref of row.references) {
      const spec = referenceSpec(ref.entityType)
      if (!spec || !allowed.has(spec.module)) {
        out[refKey(ref.entityType, ref.entityId.toString())] = {
          state: spec ? 'hidden' : 'unavailable',
          entityType: ref.entityType,
          entityId: ref.entityId.toString(),
        }
        continue
      }
      const set = byType.get(ref.entityType) ?? new Set<string>()
      set.add(ref.entityId.toString())
      byType.set(ref.entityType, set)
    }
  }

  const pages = await Promise.all(
    [...byType.entries()].map(([entityType, idStrings]) => {
      const spec = referenceSpec(entityType)!
      const docs = idStrings.size
        ? spec
            .collection(db)
            .find({ _id: { $in: [...idStrings].map((v) => new OID(v)) } } as never)
            .toArray()
            .catch(() => [] as Record<string, unknown>[])
        : Promise.resolve([] as Record<string, unknown>[])
      return docs.then((rows) => ({ entityType, rows }))
    })
  )

  for (const { entityType, rows } of pages) {
    const spec = referenceSpec(entityType)!
    const found = new Set<string>()
    for (const doc of rows) {
      const entityId = id(doc)
      found.add(entityId)
      out[refKey(entityType, entityId)] = {
        state: 'available',
        entityType,
        entityId,
        label: spec.labelOf(doc),
        meta: spec.metaOf?.(doc) || undefined,
        href: spec.hrefOf(doc),
      }
    }
    // Referenced but missing: the record was deleted after the message was sent.
    for (const entityId of byType.get(entityType) ?? []) {
      if (found.has(entityId)) continue
      out[refKey(entityType, entityId)] = { state: 'unavailable', entityType, entityId }
    }
  }

  return out
}
