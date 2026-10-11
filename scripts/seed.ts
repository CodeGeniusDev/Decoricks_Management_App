import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { getEnv } from '../src/lib/env';
import { SPEC_ROLES, LAHORE_STOCK_ROLES, SCOPED_LAHORE_STOCK_PERMISSION } from '../src/lib/roles';
import { hashPassword } from '../src/lib/auth/password';
import { karachiMidnight } from '../src/lib/finance';
import {
  SPEC_DEFAULT_BUDGET_THRESHOLDS,
  SPEC_DEFAULT_CHARITY_PERCENTAGE,
  SPEC_DEFAULT_PARTNER_PERCENTAGE,
  SPEC_DEFAULT_PARTNERS,
} from '../src/lib/business-policy';
import {
  ensureLedgerIndexes,
  getAccountCollection,
  getBusinessSettingsCollection,
  getFinanceCategoryCollection,
  type Account,
  type BusinessSettings,
  type FinanceCategory,
} from '../src/lib/models/Ledger';
import type { Role, User } from '../src/lib/models/User';

/**
 * Seeds the things Phase 2 and 3 cannot work without:
 *
 *   1. The four SPEC role documents (founder, partner_hasnat, partner_ali,
 *      partner_afnan) with the §4.2 matrix baked in.
 *   2. The first Founder account, created from environment credentials with
 *      `mustChangePassword: true` so the bootstrap password cannot keep working.
 *   3. The Phase 3 finance configuration: the SPEC Appendix A expense
 *      categories, starter accounts and the business settings singleton
 *      (including the seeded withdrawal lock).
 *
 * Safe to re-run: roles are upserted with `$setOnInsert`, finance
 * configuration is only inserted when the slug/name is absent, and the Founder
 * is only created when no Founder exists. Re-running never overwrites anything
 * a Founder has since edited in the UI.
 *
 * Usage:
 *   npm run seed            # reads FOUNDER_* from .env.local
 *   FOUNDER_EMAIL=... FOUNDER_NAME=... FOUNDER_PASSWORD=... npm run seed
 */

/**
 * Minimal .env.local loader. Next.js reads that file for the app itself, but
 * this script runs under plain tsx, so it has to load it on its own. Uses only
 * Node built-ins (no new dependency) and never overrides variables passed in
 * from the real environment.
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

const FOUNDER_EMAIL = process.env.FOUNDER_EMAIL;
const FOUNDER_NAME = process.env.FOUNDER_NAME;
const FOUNDER_PASSWORD = process.env.FOUNDER_PASSWORD;

/** SPEC Appendix A expense categories — names are the stable slugs. */
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

/** Income categories so the ledger's category validation has an income side. */
const SPEC_INCOME_CATEGORIES: Array<[name: string, label: string]> = [
  ['sales_revenue', 'Sales Revenue'],
  ['other_income', 'Other Income'],
];

/** Starter manual accounts — no bank integration, opening balance is 0. */
const SPEC_ACCOUNTS: Array<[name: string, kind: Account['kind']]> = [
  ['Cash', 'cash'],
  ['Bank Account', 'bank'],
  ['Wallet', 'wallet'],
];

/** SPEC Appendix A: withdrawals are locked until 2027-02-04 (Karachi). */
const WITHDRAWAL_LOCK = karachiMidnight(2027, 2, 4);

const upsertRoles = async (db: ReturnType<MongoClient['db']>) => {
  const now = new Date();

  for (const spec of SPEC_ROLES) {
    // The Lahore stock exception is stored alongside the matrix so the
    // permissions screen can show and toggle it.
    const permissions = {
      ...spec.permissions,
      [SCOPED_LAHORE_STOCK_PERMISSION]: {
        view: LAHORE_STOCK_ROLES[spec.name] === true,
        create: LAHORE_STOCK_ROLES[spec.name] === true,
        edit: false,
        delete: false,
      },
    };

    // `$setOnInsert` only: a re-run must never clobber permissions a Founder
    // has since customised in the permissions matrix screen.
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

const seedFounder = async (
  db: ReturnType<MongoClient['db']>,
  passwordHash: string
): Promise<import('mongodb').ObjectId> => {
  const existing = await db.collection<User>('users').findOne({ role: 'founder' });
  if (existing) {
    console.log(`Founder already exists (${existing.email}) — left untouched.`);
    return existing._id!;
  }

  const now = new Date();
  const founder: User = {
    email: FOUNDER_EMAIL!.trim().toLowerCase(),
    passwordHash,
    name: FOUNDER_NAME!.trim(),
    role: 'founder',
    isActive: true,
    mustChangePassword: true,
    createdAt: now,
    updatedAt: now,
    sessionVersion: 1,
  };

  const result = await db.collection<User>('users').insertOne(founder);
  console.log(`Created Founder ${FOUNDER_EMAIL} — password change required on first login.`);
  return result.insertedId;
};

/**
 * Phase 3 finance configuration. Insert-if-absent by the unique `name` of each
 * collection, so a Founder's later renames, deactivations and balance edits
 * survive a re-seed.
 */
const seedFinance = async (
  db: ReturnType<MongoClient['db']>,
  founderId: import('mongodb').ObjectId
) => {
  const now = new Date();

  const categories = getFinanceCategoryCollection(db);
  let categoryCount = 0;
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
        createdBy: founderId,
      };
      const result = await categories.updateOne({ name }, { $setOnInsert: doc }, { upsert: true });
      if (result.upsertedCount > 0) categoryCount += 1;
    }
  }

  const accounts = getAccountCollection(db);
  let accountCount = 0;
  for (const [name, kind] of SPEC_ACCOUNTS) {
    const doc: Account = {
      name,
      kind,
      openingBalance: 0,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: founderId,
    };
    const result = await accounts.updateOne({ name }, { $setOnInsert: doc }, { upsert: true });
    if (result.upsertedCount > 0) accountCount += 1;
  }

  const settings = getBusinessSettingsCollection(db);
  const settingsDoc: BusinessSettings = {
    key: 'business',
    withdrawalLockedUntil: WITHDRAWAL_LOCK,
    createdAt: now,
    updatedAt: now,
  };
  const settingsResult = await settings.updateOne(
    { key: 'business' },
    { $setOnInsert: settingsDoc },
    { upsert: true }
  );

  // Phase 4 policy defaults (SPEC Appendix A: 20% to each partner, 20%
  // charity, 80/100 budget thresholds). Applied only where the fields are
  // still absent, so a Founder's saved configuration is never overwritten.
  // Reinvest percentages default to 0 — an offer to configure, not an
  // invented business number.
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
  const policyResult = await settings.updateOne(
    { key: 'business', profitSharing: { $exists: false } },
    { $set: { ...phase4Defaults, updatedAt: now } }
  );

  await ensureLedgerIndexes(db);

  console.log(
    `Seeded finance configuration: ${categoryCount} categories, ${accountCount} accounts, ` +
      `business settings ${settingsResult.upsertedCount > 0 ? 'created' : 'left untouched'}, ` +
      `profit-sharing policy ${policyResult.modifiedCount > 0 ? 'backfilled with SPEC defaults' : 'already configured or absent'}.`
  );
};

const main = async () => {
  const missing = (['FOUNDER_EMAIL', 'FOUNDER_NAME', 'FOUNDER_PASSWORD'] as const).filter(
    (key) => !process.env[key]
  );
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    console.error('Set them in .env.local, e.g.');
    console.error('  FOUNDER_EMAIL=founder@decoricks.pk');
    console.error('  FOUNDER_NAME=Abdullah');
    console.error('  FOUNDER_PASSWORD=<at least 12 chars, upper+lower+number>');
    process.exit(1);
  }

  // Refuse to point the seed at the test database by accident, and vice versa.
  const env = getEnv();
  if (env.MONGODB_TEST_DB) {
    console.error('MONGODB_TEST_DB is set; refusing to run the seed against a test database.');
    process.exit(1);
  }

  const client = new MongoClient(env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db();

    const roleCount = await upsertRoles(db);
    console.log(`Seeded ${roleCount} roles from SPEC.md Appendix A.`);

    const passwordHash = await hashPassword(FOUNDER_PASSWORD!);
    const founderId = await seedFounder(db, passwordHash);
    await seedFinance(db, founderId);
  } finally {
    await client.close();
  }
};

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
