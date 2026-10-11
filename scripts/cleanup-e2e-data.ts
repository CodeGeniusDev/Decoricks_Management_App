import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Collection, Db, MongoClient, ObjectId } from 'mongodb';
import { getEnv } from '../src/lib/env';

/**
 * Removes Playwright (E2E) leftover records from the application database.
 *
 * Before the Playwright suite was isolated to `decoricks_test`, every e2e run
 * wrote real documents into the app database through the UI. Those runs are
 * identifiable by the unique markers the specs always apply:
 *
 *   - ledger entries: note starts with "e2e"/"E2E" (or is a reversal of such
 *     an entry — linked via `reversesId`, or note "Reversal: e2e-reason-…")
 *   - budgets: name starts with "E2E "
 *   - profit distributions: month is one of the spec's placeholder months
 *     (2032-01/02/03) or an adjustment reason starts with "E2E"
 *   - legacy Phase 1 collections + tasks/orders/products/suppliers/chat:
 *     name/note/description fields starting with "e2e" (removed only if found)
 *
 * Anything not matching these patterns is left untouched — genuine business
 * records, users, roles, finance configuration and the audit log are NEVER
 * deleted (the audit trail is append-only by design; the deletions themselves
 * are recorded there as `e2e_cleanup`).
 *
 * Usage:
 *   npx tsx scripts/cleanup-e2e-data.ts            # dry run (default, safe)
 *   npx tsx scripts/cleanup-e2e-data.ts --apply    # actually delete
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

const APPLY = process.argv.includes('--apply');

/** Months the phase-4 distribution spec calculates against (never real). */
const E2E_DISTRIBUTION_MONTHS = ['2032-01', '2032-02', '2032-03'];

const E2E_NOTE = /^e2e/i;
const E2E_REVERSAL_NOTE = /^reversal:\s*e2e/i;

const preview = (docs: Array<Record<string, unknown>>, limit = 5): string =>
  docs
    .slice(0, limit)
    .map((d) => {
      const label =
        (d.note as string) ?? (d.name as string) ?? (d.month as string) ?? (d.title as string) ?? '';
      return `    ${d._id}  ${JSON.stringify(label).slice(0, 80)}`;
    })
    .join('\n');

const deleteAndReport = async (
  col: Collection<Document>,
  filter: Record<string, unknown>,
  label: string
): Promise<number> => {
  const docs = (await col.find(filter).limit(200).toArray()) as Array<Record<string, unknown>>;
  if (docs.length === 0) {
    console.log(`  ${label}: none`);
    return 0;
  }
  console.log(`  ${label}: ${docs.length}${docs.length >= 200 ? '+' : ''} record(s)`);
  console.log(preview(docs));
  if (APPLY) {
    const res = await col.deleteMany(filter);
    console.log(`    → deleted ${res.deletedCount}`);
    return res.deletedCount ?? 0;
  }
  return docs.length;
};

type Document = { [key: string]: unknown };

const main = async () => {
  const env = getEnv();
  const client = new MongoClient(env.MONGODB_URI);
  try {
    await client.connect();
    // Same resolution the app uses (URI default database) — this script's
    // whole purpose is cleaning the application database.
    const db: Db = client.db();
    const dbName = db.databaseName;

    console.log(`${APPLY ? 'APPLYING' : 'DRY RUN — nothing will be deleted'}`);
    console.log(`Target database: "${dbName}"\n`);

    let total = 0;

    // 1. Ledger entries -----------------------------------------------------
    const transactions = db.collection('transactions');
    const e2eHeads = await transactions
      .find({ $or: [{ note: E2E_NOTE }, { note: E2E_REVERSAL_NOTE }] } as never)
      .project<{ _id: ObjectId }>({ _id: 1 })
      .toArray();
    const e2eIds = e2eHeads.map((d) => d._id);

    // Reversals of those entries carry note "Reversal of <id>" — catch them by
    // their explicit link, never by the generic prefix (a real entry may have
    // been reversed too).
    const linkedReversals = e2eIds.length
      ? await transactions.find({ reversesId: { $in: e2eIds } } as never).project({ _id: 1 }).toArray()
      : [];
    const allE2eTxIds = [
      ...new Set([...e2eIds, ...linkedReversals.map((d) => (d as { _id: ObjectId })._id.toString())]),
    ].map((id) => (id instanceof ObjectId ? id : new ObjectId(id)));

    total += await deleteAndReport(
      transactions,
      { _id: { $in: allE2eTxIds } } as never,
      'transactions (e2e entries + their linked reversals)'
    );

    // 2. Budgets -------------------------------------------------------------
    total += await deleteAndReport(
      db.collection('budgets'),
      { name: { $regex: '^E2E ' } } as never,
      'budgets (name "E2E …")'
    );

    // 3. Profit distributions -------------------------------------------------
    total += await deleteAndReport(
      db.collection('profitDistributions'),
      {
        $or: [
          { month: { $in: E2E_DISTRIBUTION_MONTHS } },
          { 'adjustments.reason': { $regex: '^E2E', $options: 'i' } },
        ],
      } as never,
      'profitDistributions (e2e months / adjustment reasons)'
    );

    // 4. Legacy + operational collections (inventory; delete only clear hits) --
    const textSweeps: Array<[string, string[]]> = [
      ['income', ['note', 'description']],
      ['expenses', ['note', 'description', 'vendor']],
      ['transfers', ['note', 'description']],
      ['tasks', ['title', 'description']],
      ['orders', ['customerName', 'notes']],
      ['products', ['name', 'description', 'sku']],
      ['suppliers', ['name', 'notes']],
      ['chatMessages', ['text']],
    ];
    for (const [name, fields] of textSweeps) {
      const col = db.collection(name);
      const or = fields.map((f) => ({ [f]: E2E_NOTE }));
      total += await deleteAndReport(col, { $or: or } as never, `${name} (e2e-prefixed text)`);
    }

    console.log(`\nTotal ${APPLY ? 'deleted' : 'matched'}: ${total}`);
    if (!APPLY && total > 0) {
      console.log('Re-run with --apply to delete these records.');
    }
    if (APPLY && total > 0) {
      // Record the cleanup itself in the append-only audit trail.
      await db.collection('auditLog').insertOne({
        userId: null,
        userEmail: 'system',
        action: 'e2e_cleanup',
        entityType: 'database',
        entityId: null,
        oldValue: undefined,
        newValue: undefined,
        details: `Removed ${total} E2E-marked test record(s) from "${dbName}" via scripts/cleanup-e2e-data.ts`,
        outcome: 'success',
        createdAt: new Date(),
      });
      console.log('Audit entry recorded (action: e2e_cleanup).');
    }
  } finally {
    await client.close();
  }
};

main().catch((error) => {
  console.error('E2E cleanup failed:', error);
  process.exit(1);
});
