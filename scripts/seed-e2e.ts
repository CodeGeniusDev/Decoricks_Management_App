import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { getEnv } from '../src/lib/env'
import {
  looksLikeTestDatabase,
  resolveDatabase,
  assertScriptDatabaseConsent,
} from '../src/lib/db-name'
import { SPEC_ROLES, LAHORE_STOCK_ROLES, SCOPED_LAHORE_STOCK_PERMISSION } from '../src/lib/roles'
import { hashPassword } from '../src/lib/auth/password'
import { karachiMidnight } from '../src/lib/finance'
import { ensureAuthIndexes, type Role, type User } from '../src/lib/models/User'
import {
  ensureLedgerIndexes,
  getAccountCollection,
  getBusinessSettingsCollection,
  getFinanceCategoryCollection,
  type Account,
  type BusinessSettings,
  type FinanceCategory,
} from '../src/lib/models/Ledger'
import {
  SPEC_DEFAULT_BUDGET_THRESHOLDS,
  SPEC_DEFAULT_CHARITY_PERCENTAGE,
  SPEC_DEFAULT_PARTNER_PERCENTAGE,
  SPEC_DEFAULT_PARTNERS,
} from '../src/lib/business-policy'
import {
  ensureNotificationIndexes,
  getNotificationCollection,
} from '../src/lib/models/Notifications'

/**
 * E2E bootstrap for the isolated test database (`decoricks_test` by default).
 *
 * The Playwright suite must never write into the application database — every
 * suite run creates orders, ledger entries, budgets and users through the real
 * UI. This script provisions the test database with exactly the records the
 * specs assume: the four SPEC roles, the Founder and Afnan accounts the auth
 * setup signs in as, and the Phase 3/4 finance configuration.
 *
 * Safety: the database name defaults to the same value the test server is given
 * through `MONGODB_TEST_DB` (so the seeded database and the database under test
 * cannot diverge), and must still pass two independent checks before a single
 * write is issued — it has to look like a test database, and it must not be the
 * database the application itself resolves to.
 *
 * This matters because the script upserts the Founder and Partner accounts with
 * `passwordHash`, `isActive: true` and `mustChangePassword: false` in the `$set`.
 * Pointed at the application database, that is not a seed — it is a credential
 * reset on real accounts, silently, with an unvalidated name.
 *
 * SPEC list contents mirror `scripts/seed.ts` (kept standalone because seed.ts
 * executes `main()` on import; if a list changes there, change it here too).
 */

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

const E2E_DB = process.env.E2E_DB ?? process.env.MONGODB_TEST_DB ?? 'decoricks_test'
const FOUNDER_EMAIL = (process.env.E2E_FOUNDER_EMAIL ?? '').toLowerCase()
const AFNAN_EMAIL = (process.env.E2E_AFNAN_EMAIL ?? 'afnan@decoricks.com').toLowerCase()
const E2E_PASSWORD = process.env.E2E_PASSWORD ?? ''

const SPEC_EXPENSE_CATEGORIES: Array<[name: string, label: string]> = [
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

const SPEC_INCOME_CATEGORIES: Array<[name: string, label: string]> = [
  ['sales_revenue', 'Sales Revenue'],
  ['other_income', 'Other Income'],
]

const SPEC_ACCOUNTS: Array<[name: string, kind: Account['kind']]> = [
  ['Cash', 'cash'],
  ['Bank Account', 'bank'],
  ['Wallet', 'wallet'],
]

const WITHDRAWAL_LOCK = karachiMidnight(2027, 2, 4)

const upsertRoles = async (db: Db): Promise<number> => {
  const now = new Date()
  for (const spec of SPEC_ROLES) {
    const permissions = {
      ...spec.permissions,
      [SCOPED_LAHORE_STOCK_PERMISSION]: {
        view: LAHORE_STOCK_ROLES[spec.name] === true,
        create: LAHORE_STOCK_ROLES[spec.name] === true,
        edit: false,
        delete: false,
      },
    }
    await db.collection<Role>('roles').updateOne(
      { name: spec.name },
      {
        $setOnInsert: {
          name: spec.name,
          displayName: spec.displayName,
          permissions,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true }
    )
  }
  return SPEC_ROLES.length
}

/**
 * Idempotent user provisioning. Unlike the production seed, the password hash
 * is always re-applied — this is a dedicated test database, and doing so keeps
 * the suite working after any manual password edit in it. `mustChangePassword`
 * is false so `auth.setup.ts` lands on the dashboard instead of the forced
 * change-password screen.
 */
const upsertE2EUser = async (
  db: Db,
  email: string,
  name: string,
  role: User['role'],
  passwordHash: string
): Promise<User['_id']> => {
  const now = new Date()
  const existing = await db.collection<User>('users').findOne({ email })
  if (existing) {
    await db
      .collection<User>('users')
      .updateOne(
        { _id: existing._id },
        { $set: { passwordHash, isActive: true, mustChangePassword: false, role, updatedAt: now } }
      )
    return existing._id!
  }
  const doc: User = {
    email,
    passwordHash,
    name,
    role,
    isActive: true,
    mustChangePassword: false,
    createdAt: now,
    updatedAt: now,
    sessionVersion: 1,
  }
  const result = await db.collection<User>('users').insertOne(doc)
  return result.insertedId
}

const seedFinance = async (db: Db, founderId: User['_id']): Promise<void> => {
  const now = new Date()

  const categories = getFinanceCategoryCollection(db)
  for (const [type, list] of [
    ['expense', SPEC_EXPENSE_CATEGORIES],
    ['income', SPEC_INCOME_CATEGORIES],
  ] as const) {
    for (const [name, label] of list) {
      const doc: FinanceCategory = {
        name,
        label,
        type,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        createdBy: founderId as never,
      }
      await categories.updateOne({ name }, { $setOnInsert: doc }, { upsert: true })
    }
  }

  const accounts = getAccountCollection(db)
  for (const [name, kind] of SPEC_ACCOUNTS) {
    const doc: Account = {
      name,
      kind,
      openingBalance: 0,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: founderId as never,
    }
    await accounts.updateOne({ name }, { $setOnInsert: doc }, { upsert: true })
  }

  const settings = getBusinessSettingsCollection(db)
  const settingsDoc: BusinessSettings = {
    key: 'business',
    withdrawalLockedUntil: WITHDRAWAL_LOCK,
    createdAt: now,
    updatedAt: now,
  }
  await settings.updateOne({ key: 'business' }, { $setOnInsert: settingsDoc }, { upsert: true })

  const phase4Defaults = {
    profitSharing: {
      partners: SPEC_DEFAULT_PARTNERS.map((p) => ({
        name: p.name,
        percentage: SPEC_DEFAULT_PARTNER_PERCENTAGE,
        reinvestPercentage: 0,
      })),
      charityPercentage: SPEC_DEFAULT_CHARITY_PERCENTAGE,
    },
    budgetThresholds: SPEC_DEFAULT_BUDGET_THRESHOLDS,
  }
  await settings.updateOne(
    { key: 'business', profitSharing: { $exists: false } },
    { $set: { ...phase4Defaults, updatedAt: now } }
  )

  await ensureLedgerIndexes(db)
}

/**
 * A single, idempotent notification for the Founder so the bell always has a
 * stable unread item to render, regardless of what the parallel write specs
 * happen to trigger. Keyed on `{ userId, dedupeKey }` (the production dedupe
 * index), so re-running the seed never stacks duplicates.
 *
 * The row is also re-stamped on every seed. The bell renders the newest page
 * only (`PAGE_LIMIT = 20` in `src/hooks/useNotifications.ts`), and a long suite
 * raises budget/stock/ledger notifications continuously, so a row that kept its
 * original `createdAt` slowly sank past page one and `phase9-notifications` began
 * failing on a perfectly healthy product — it reported "element(s) not found"
 * once the Founder held 22 notifications and the seeded one sat at rank 21.
 * Refreshing `createdAt` keeps the guaranteed row at the top of the list the
 * assertion reads, and refreshing `isRead` keeps the unread badge non-zero.
 */
const seedNotifications = async (db: Db, founderId: User['_id']): Promise<void> => {
  await ensureNotificationIndexes(db)
  const dedupeKey = 'e2e:bell-seed'
  await getNotificationCollection(db).updateOne(
    { userId: founderId as ObjectId, dedupeKey },
    {
      $set: { createdAt: new Date(), isRead: false },
      $setOnInsert: {
        userId: founderId as ObjectId,
        type: 'low_stock',
        dedupeKey,
        title: 'E2E bell notification',
        message: 'Seeded so the notification unread badge is non-zero and stable.',
        data: { entityType: 'product', entityId: 'e2e-product', link: '/inventory' },
      },
    },
    { upsert: true }
  )
}

/**
 * Refuses to write a single document unless the target is unambiguously a test
 * database. Two independent checks, because the failure mode is silent: a name
 * that happens to match the application's database would upsert e2e passwords
 * onto real accounts and print "ready" afterwards.
 *
 *   1. The name must match the project's test-database shapes. A bare `test`
 *      deliberately fails this check — in this deployment `test` is where the
 *      genuine records live (see scripts/db-inventory.ts).
 *   2. The name must differ from the database the application resolves to once
 *      `MONGODB_TEST_DB` is taken out of the picture, which catches a test-shaped
 *      name that was also configured as the application database.
 */
const assertTestTarget = (client: MongoClient, env: ReturnType<typeof getEnv>): void => {
  if (!looksLikeTestDatabase(E2E_DB)) {
    throw new Error(
      `Refusing to seed "${E2E_DB}": an e2e database must be named "decoricks_test" or "test_…". ` +
        'This script resets account passwords for the users it provisions, so it cannot run against the application database.'
    )
  }

  const appDatabase = resolveDatabase({ ...env, MONGODB_TEST_DB: undefined })
  const appName = client.db(appDatabase.dbName).databaseName
  if (appName === E2E_DB) {
    throw new Error(
      `Refusing to seed "${E2E_DB}": the application resolves to the same database (source: ${appDatabase.source}). Point E2E_DB at a separate test database.`
    )
  }
}

/**
 * Refuses to provision accounts from an empty environment.
 *
 * Both variables used to default to `''` and the script happily wrote the hash
 * of that empty string. The result is an account that cannot sign in anywhere:
 * `/api/auth/login` validates `password` with `.min(1)`, so the form rejects the
 * empty credential before it is ever hashed, while the database now holds a
 * bcrypt hash of it. Observed consequence: `auth.setup` later fails with
 * "Invalid email or password" for whichever account this touched, and because
 * the Founder and the Partner were seeded on different runs, the two accounts
 * ended up disagreeing about what the shared `E2E_PASSWORD` is — which reads like
 * a flaky suite and is really a destroyed credential. An unconfigured run must
 * stop here instead.
 */
const assertProvisioningCredentials = (): void => {
  const missing = [
    ...(FOUNDER_EMAIL ? [] : ['E2E_FOUNDER_EMAIL']),
    ...(E2E_PASSWORD ? [] : ['E2E_PASSWORD']),
  ]
  if (missing.length === 0) return
  throw new Error(
    `Refusing to seed: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
      'This script overwrites the password hashes of the accounts it provisions, so an empty value ' +
      'would lock them out of the login form. See docs/E2E_RUNBOOK.md for the export lines.'
  )
}

const main = async () => {
  const env = getEnv()
  const client = new MongoClient(env.MONGODB_URI)
  try {
    await client.connect()
    assertTestTarget(client, env)
    assertProvisioningCredentials()
    // Explicit database name — never the URI default, never the app database.
    const db = client.db(E2E_DB)

    // Defense-in-depth: this script only targets a test-shaped database, so the
    // consent guard passes by construction; if E2E_DB were ever pointed at a real
    // database it would refuse here without DECORICKS_ALLOW_PROD_DB=1.
    assertScriptDatabaseConsent(db.databaseName, { script: 'scripts/seed-e2e.ts' })

    await ensureAuthIndexes(db)
    const roleCount = await upsertRoles(db)
    const passwordHash = await hashPassword(E2E_PASSWORD)
    const founderId = await upsertE2EUser(db, FOUNDER_EMAIL, 'E2E Founder', 'founder', passwordHash)
    await upsertE2EUser(db, AFNAN_EMAIL, 'E2E Afnan', 'partner_afnan', passwordHash)
    await seedFinance(db, founderId)
    await seedNotifications(db, founderId)

    console.log(
      `E2E database "${E2E_DB}" ready: ${roleCount} roles, founder ${FOUNDER_EMAIL}, partner ${AFNAN_EMAIL}, finance configuration.`
    )
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error('E2E seed failed:', error)
  process.exit(1)
})
