import { type Db, ObjectId } from 'mongodb'
import {
  ensureLedgerIndexes,
  getAccountCollection,
  getFinanceCategoryCollection,
  type Account,
  type FinanceCategory,
} from '@/lib/models/Ledger'

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
        await ensureLedgerIndexes(db)

        const now = new Date()
        const createdBy = actorId ?? new ObjectId()

        const categories = getFinanceCategoryCollection(db)
        for (const [type, list] of [
          ['expense', SPEC_EXPENSE_CATEGORIES],
          ['income', SPEC_INCOME_CATEGORIES],
        ] as const) {
          for (const [name, label] of list) {
            const doc: Omit<FinanceCategory, '_id'> = {
              name,
              label,
              type,
              isActive: true,
              createdAt: now,
              updatedAt: now,
              createdBy,
            }
            await categories.updateOne({ name }, { $setOnInsert: doc }, { upsert: true })
          }
        }

        const accounts = getAccountCollection(db)
        for (const [name, kind] of SPEC_ACCOUNTS) {
          const doc: Omit<Account, '_id'> = {
            name,
            kind,
            openingBalance: 0,
            isActive: true,
            createdAt: now,
            updatedAt: now,
            createdBy,
          }
          await accounts.updateOne({ name }, { $setOnInsert: doc }, { upsert: true })
        }
      } catch (error) {
        financeDefaultsPromise = null
        console.error('ensureFinanceDefaults failed:', error)
      }
    })()
  }
  return financeDefaultsPromise
}
