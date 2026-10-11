import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import { getEnv } from '../src/lib/env';
import {
  SPEC_ROLES,
  LAHORE_STOCK_ROLES,
  SCOPED_LAHORE_STOCK_PERMISSION,
} from '../src/lib/roles';
import { hashPassword } from '../src/lib/auth/password';
import { karachiMidnight } from '../src/lib/finance';
import { ensureAuthIndexes, type Role, type User } from '../src/lib/models/User';
import {
  ensureLedgerIndexes,
  getAccountCollection,
  getBusinessSettingsCollection,
  getFinanceCategoryCollection,
  type Account,
  type BusinessSettings,
  type FinanceCategory,
} from '../src/lib/models/Ledger';
import {
  SPEC_DEFAULT_BUDGET_THRESHOLDS,
  SPEC_DEFAULT_CHARITY_PERCENTAGE,
  SPEC_DEFAULT_PARTNER_PERCENTAGE,
  SPEC_DEFAULT_PARTNERS,
} from '../src/lib/business-policy';

/**
 * E2E bootstrap for the isolated test database (`decoricks_test` by default).
 *
 * The Playwright suite must never write into the application database — every
 * suite run creates orders, ledger entries, budgets and users through the real
 * UI. This script provisions the test database with exactly the records the
 * specs assume: the four SPEC roles, the Founder and Afnan accounts the auth
 * setup signs in as, and the Phase 3/4 finance configuration.
 *
 * Safety: the database name is taken from `E2E_DB` (default `decoricks_test`)
 * and passed explicitly to `client.db(...)` — it can only ever touch a database
 * named for testing. Credentials are the same defaults as `src/e2e/helpers.ts`.
 *
 * SPEC list contents mirror `scripts/seed.ts` (kept standalone because seed.ts
 * executes `main()` on import; if a list changes there, change it here too).
 */

const loadEnvLocal = (): void => {
  const file = path.join(process.cwd(), '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
};
loadEnvLocal();

const E2E_DB = process.env.E2E_DB ?? 'decoricks_test';
const FOUNDER_EMAIL = (process.env.E2E_FOUNDER_EMAIL ?? 'abdullah@decoricks.com').toLowerCase();
const AFNAN_EMAIL = (process.env.E2E_AFNAN_EMAIL ?? 'afnan@decoricks.com').toLowerCase();
const E2E_PASSWORD = process.env.E2E_PASSWORD ?? 'Decoricks2026';

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
];

const SPEC_INCOME_CATEGORIES: Array<[name: string, label: string]> = [
  ['sales_revenue', 'Sales Revenue'],
  ['other_income', 'Other Income'],
];

const SPEC_ACCOUNTS: Array<[name: string, kind: Account['kind']]> = [
  ['Cash', 'cash'],
  ['Bank Account', 'bank'],
  ['Wallet', 'wallet'],
];

const WITHDRAWAL_LOCK = karachiMidnight(2027, 2, 4);

const upsertRoles = async (db: Db): Promise<number> => {
  const now = new Date();
  for (const spec of SPEC_ROLES) {
    const permissions = {
      ...spec.permissions,
      [SCOPED_LAHORE_STOCK_PERMISSION]: {
        view: LAHORE_STOCK_ROLES[spec.name] === true,
        create: LAHORE_STOCK_ROLES[spec.name] === true,
        edit: false,
        delete: false,
      },
    };
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
    );
  }
  return SPEC_ROLES.length;
};

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
  const now = new Date();
  const existing = await db.collection<User>('users').findOne({ email });
  if (existing) {
    await db
      .collection<User>('users')
      .updateOne(
        { _id: existing._id },
        { $set: { passwordHash, isActive: true, mustChangePassword: false, role, updatedAt: now } }
      );
    return existing._id!;
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
  };
  const result = await db.collection<User>('users').insertOne(doc);
  return result.insertedId;
};

const seedFinance = async (db: Db, founderId: User['_id']): Promise<void> => {
  const now = new Date();

  const categories = getFinanceCategoryCollection(db);
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
      };
      await categories.updateOne({ name }, { $setOnInsert: doc }, { upsert: true });
    }
  }

  const accounts = getAccountCollection(db);
  for (const [name, kind] of SPEC_ACCOUNTS) {
    const doc: Account = {
      name,
      kind,
      openingBalance: 0,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: founderId as never,
    };
    await accounts.updateOne({ name }, { $setOnInsert: doc }, { upsert: true });
  }

  const settings = getBusinessSettingsCollection(db);
  const settingsDoc: BusinessSettings = {
    key: 'business',
    withdrawalLockedUntil: WITHDRAWAL_LOCK,
    createdAt: now,
    updatedAt: now,
  };
  await settings.updateOne({ key: 'business' }, { $setOnInsert: settingsDoc }, { upsert: true });

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
  };
  await settings.updateOne(
    { key: 'business', profitSharing: { $exists: false } },
    { $set: { ...phase4Defaults, updatedAt: now } }
  );

  await ensureLedgerIndexes(db);
};

const main = async () => {
  const env = getEnv();
  const client = new MongoClient(env.MONGODB_URI);
  try {
    await client.connect();
    // Explicit database name — never the URI default, never the app database.
    const db = client.db(E2E_DB);

    await ensureAuthIndexes(db);
    const roleCount = await upsertRoles(db);
    const passwordHash = await hashPassword(E2E_PASSWORD);
    const founderId = await upsertE2EUser(db, FOUNDER_EMAIL, 'E2E Founder', 'founder', passwordHash);
    await upsertE2EUser(db, AFNAN_EMAIL, 'E2E Afnan', 'partner_afnan', passwordHash);
    await seedFinance(db, founderId);

    console.log(
      `E2E database "${E2E_DB}" ready: ${roleCount} roles, founder ${FOUNDER_EMAIL}, partner ${AFNAN_EMAIL}, finance configuration.`
    );
  } finally {
    await client.close();
  }
};

main().catch((error) => {
  console.error('E2E seed failed:', error);
  process.exit(1);
});
