import { type AnyBulkWriteOperation, type Db, ObjectId } from 'mongodb'
import {
  ensureLedgerIndexes,
  getAccountCollection,
  getFinanceCategoryCollection,
  type Account,
  type FinanceCategory,
} from '@/lib/models/Ledger'
import { timeStage } from '@/lib/timing'

/**
 * Runtime finance defaults.
 *
 * The SPEC Appendix A expense/income categories and the starter accounts used
 * to live only in `scripts/seed.ts`, which is not part of a Netlify deploy. On a
 * database that was never seeded, `GET /api/finance/categories` returned an
 * empty list and the transaction form's category dropdown rendered blank — the
 * ledger itself was fine, there was simply nothing to pick.
 *
 * This mirrors the pattern Chat already uses (`ensureChatCollections`): an
 * idempotent, once-per-process backfill that runs on the read path so a fresh
 * deployment self-heals without a manual step. Every write is a `$setOnInsert`
 * upsert keyed on the stable `name`, so:
 *   - repeated requests and re-deploys never create duplicates (a second, unique
 *     index on `name` created by `ensureLedgerIndexes` is the backstop);
 *   - a Founder's renames, deactivations and hand-added categories survive.
 *
 * The lists are the single source of truth: `scripts/seed.ts` imports them so
 * the seed and the runtime can never drift.
 */

/** SPEC Appendix A expense categories — names are the stable slugs. */
export const SPEC_EXPENSE_CATEGORIES: Array<[name: string, label: string]> = [
  ['meta_ads', 'Meta Ads'],
  ['shopify_subscription', 'Shopify Subscription'],
  ['flyers_printing', 'Flyers Printing'],
  ['product_purchasing', 'Product Purchasing'],
  ['shipping_courier', 'Shipping & Courier'],
  ['packaging', 'Packaging'],
  ['refunds_return_costs', 'Refunds & Return Costs'],
  ['platform_fees', 'Platform Fees'],
  ['content_production', 'Content Production'],
  ['miscellaneous', 'Miscellaneous'],
]

/** Income categories so the ledger's category validation has an income side. */
export const SPEC_INCOME_CATEGORIES: Array<[name: string, label: string]> = [
  ['sales_revenue', 'Sales Revenue'],
  ['other_income', 'Other Income'],
]

/** Starter manual accounts — no bank integration, opening balance is 0. */
export const SPEC_ACCOUNTS: Array<[name: string, kind: Account['kind']]> = [
  ['Cash', 'cash'],
  ['Bank Account', 'bank'],
  ['Wallet', 'wallet'],
]

let financeDefaultsPromise: Promise<void> | null = null

/**
 * Ensure the ledger indexes exist and backfill the SPEC default categories and
 * accounts when they are absent. Memoised per process; on a transient failure
 * (for example an Atlas cold start) the promise is reset so the next request
 * retries rather than permanently skipping the backfill.
 *
 * `actorId` stamps `createdBy` on rows this backfill inserts. It is only ever
 * used for a document that does not yet exist, so it never rewrites the author
 * of a category the Founder created themselves.
 */
export function ensureFinanceDefaults(db: Db, actorId?: ObjectId): Promise<void> {
  if (!financeDefaultsPromise) {
    financeDefaultsPromise = (async () => {
      try {
        await timeStage('q:financeDefaults', async () => {
          const now = new Date()
          const createdBy = actorId ?? new ObjectId()

          /*
           * ONE round trip per collection, not one per document.
           *
           * This used to be fifteen sequential `updateOne(..., { upsert: true })`
           * calls — twelve categories plus three accounts — issued one after
           * another. Against this cluster a single indexed write costs ~65ms of
           * network (Phase 4 §1, `scripts/db-probe.ts`), so the cold path paid
           * ~1.8s of pure round-trip latency before the read it was blocking on
           * could even start: the first `GET /api/finance/categories` after a
           * boot measured 1970ms cold versus 197ms warm, and the gap was entirely
           * these serial upserts. `bulkWrite` keeps the exact `$setOnInsert`
           * semantics (repeated calls and re-deploys never duplicate, a Founder's
           * renames survive) while collapsing the fifteen writes into two.
           */
          const categoryOps: AnyBulkWriteOperation<FinanceCategory>[] = (
            [
              ['expense', SPEC_EXPENSE_CATEGORIES],
              ['income', SPEC_INCOME_CATEGORIES],
            ] as const
          ).flatMap(([type, list]) =>
            list.map(([name, label]) => ({
              updateOne: {
                filter: { name },
                update: {
                  $setOnInsert: {
                    name,
                    label,
                    type,
                    isActive: true,
                    createdAt: now,
                    updatedAt: now,
                    createdBy,
                  } satisfies Omit<FinanceCategory, '_id'>,
                },
                upsert: true,
              },
            }))
          )

          const accountOps: AnyBulkWriteOperation<Account>[] = SPEC_ACCOUNTS.map(([name, kind]) => ({
            updateOne: {
              filter: { name },
              update: {
                $setOnInsert: {
                  name,
                  kind,
                  openingBalance: 0,
                  isActive: true,
                  createdAt: now,
                  updatedAt: now,
                  createdBy,
                } satisfies Omit<Account, '_id'>,
              },
              upsert: true,
            },
          }))

          /*
           * Index creation and the backfill run CONCURRENTLY, not index-then-write.
           *
           * `ensureLedgerIndexes` builds fourteen indexes across four collections;
           * awaiting it first serialised two cold pools' worth of round trips
           * (~65ms each on this cluster) ahead of the writes that were already
           * independent of it, which measured as ~946ms of the cold categories
           * request. The two are independent because the upsert is idempotent by
           * its OWN `{ name }` filter: the unique `financeCategories_name_unique`
           * index is a concurrency backstop, not the thing that makes a repeated
           * call safe. On a single warm process the backfill is a no-op anyway, so
           * the index build is the only work and it now overlaps it.
           */
          await Promise.all([
            ensureLedgerIndexes(db),
            getFinanceCategoryCollection(db).bulkWrite(categoryOps, { ordered: false }),
            getAccountCollection(db).bulkWrite(accountOps, { ordered: false }),
          ])
        })
      } catch (error) {
        financeDefaultsPromise = null
        console.error('ensureFinanceDefaults failed:', error)
      }
    })()
  }
  return financeDefaultsPromise
}
