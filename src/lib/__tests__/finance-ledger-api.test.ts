/**
 * Phase 3 API tests — the security and integrity checks the brief requires:
 *   • 401/403 on every finance route
 *   • validation errors on malformed entries
 *   • duplicate idempotency keys replay the original (200), never a second row
 *   • Partners without `finance.approve` cannot write withdrawals
 *   • withdrawals are rejected (409 WITHDRAWALS_LOCKED) while locked
 *   • a reversal cannot be reversed, and cannot be applied twice
 *
 * The handlers run against in-memory mock collections. `@/lib/authorization`
 * is mocked globally (see src/test/setup.ts) to a permissive Founder; each
 * denial test overrides the next call with the real error classes so
 * `handleRouteError` maps them to production statuses exactly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { authorize, AuthenticationError, AuthorizationError } from '@/lib/authorization';

/* ----------------------------- mock collections ---------------------------- */

const makeCollection = () => ({
  find: vi.fn(),
  findOne: vi.fn(),
  insertOne: vi.fn(),
  updateOne: vi.fn(),
  deleteOne: vi.fn(),
  countDocuments: vi.fn(),
  createIndex: vi.fn(),
  aggregate: vi.fn(() => ({ toArray: async () => [] })),
});

const transactionsCollection = makeCollection();
const accountsCollection = makeCollection();
const categoriesCollection = makeCollection();
const businessSettingsCollection = makeCollection();
const auditCollection = makeCollection();
const usersCollection = makeCollection();

const collections: Record<string, unknown> = {
  transactions: transactionsCollection,
  accounts: accountsCollection,
  financeCategories: categoriesCollection,
  businessSettings: businessSettingsCollection,
  auditLog: auditCollection,
  users: usersCollection,
};

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => ({ collection: (name: string) => collections[name] })),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@/lib/models/Ledger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/models/Ledger')>('@/lib/models/Ledger');
  return { ...actual, ensureLedgerIndexes: vi.fn(async () => undefined) };
});

/* ------------------------------- fixtures --------------------------------- */

const CASH_ID = new ObjectId('507f1f77bcf86cd799439011');
const BANK_ID = new ObjectId('507f1f77bcf86cd799439012');
const ORIG_ID = new ObjectId('507f1f77bcf86cd799439020');

const ALL_ACCOUNTS = () => [
  {
    _id: CASH_ID,
    name: 'Cash',
    kind: 'cash',
    openingBalance: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: BANK_ID,
    name: 'Bank',
    kind: 'bank',
    openingBalance: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const ALL_CATEGORIES = () => [
  {
    _id: new ObjectId(),
    name: 'sales_revenue',
    label: 'Sales Revenue',
    type: 'income',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: new ObjectId(),
    name: 'miscellaneous',
    label: 'Miscellaneous',
    type: 'expense',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const cursor = (docs: unknown[]) => ({
  sort: () => cursor(docs),
  skip: () => cursor(docs),
  limit: () => cursor(docs),
  toArray: async () => docs,
});

/** In-memory ledger; insertOne enforces the unique idempotency key like the index. */
let ledgerStore: Map<string, Record<string, unknown>>;

const findByKey = (key: string) =>
  [...ledgerStore.values()].find((d) => d.idempotencyKey === key) ?? null;

const ledgerFindOne = async (query: Record<string, unknown> = {}) => {
  if (query.idempotencyKey) return findByKey(String(query.idempotencyKey));
  if (query._id) return ledgerStore.get(String(query._id)) ?? null;
  return null;
};

const ledgerInsertOne = async (doc: Record<string, unknown>) => {
  if (
    doc.idempotencyKey &&
    [...ledgerStore.values()].some((d) => d.idempotencyKey === doc.idempotencyKey)
  ) {
    throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
  }
  const _id = doc._id instanceof ObjectId ? doc._id : new ObjectId();
  const stored = { ...doc, _id };
  ledgerStore.set(_id.toString(), stored as Record<string, unknown>);
  return { insertedId: _id };
};

const ledgerUpdateOne = async (
  query: Record<string, unknown>,
  update: { $set?: Record<string, unknown> }
) => {
  const doc = query._id ? ledgerStore.get(String(query._id)) : null;
  if (doc && update.$set) Object.assign(doc, update.$set);
  return { acknowledged: true, modifiedCount: doc ? 1 : 0 };
};

beforeEach(() => {
  vi.clearAllMocks();
  ledgerStore = new Map();

  transactionsCollection.findOne.mockImplementation(ledgerFindOne);
  transactionsCollection.insertOne.mockImplementation(ledgerInsertOne);
  transactionsCollection.updateOne.mockImplementation(ledgerUpdateOne);
  transactionsCollection.find.mockImplementation(() => cursor([]));
  transactionsCollection.countDocuments.mockResolvedValue(0);

  accountsCollection.find.mockImplementation((query: Record<string, unknown> = {}) => {
    const inList = (query._id as { $in?: ObjectId[] })?.$in;
    const docs = ALL_ACCOUNTS();
    return cursor(inList ? docs.filter((a) => inList.some((id) => id.equals(a._id))) : docs);
  });
  accountsCollection.findOne.mockImplementation(async (query: Record<string, unknown> = {}) => {
    if (query.name) return ALL_ACCOUNTS().find((a) => a.name === query.name) ?? null;
    if (query._id) return ALL_ACCOUNTS().find((a) => a._id.equals(query._id as ObjectId)) ?? null;
    return null;
  });
  accountsCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });

  categoriesCollection.find.mockImplementation(() => cursor(ALL_CATEGORIES()));
  categoriesCollection.findOne.mockImplementation(async (query: Record<string, unknown> = {}) => {
    if (query.name) return ALL_CATEGORIES().find((c) => c.name === query.name) ?? null;
    return null;
  });
  categoriesCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });

  businessSettingsCollection.findOne.mockResolvedValue(null);
  businessSettingsCollection.updateOne.mockResolvedValue({ acknowledged: true });

  auditCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });

  usersCollection.find.mockImplementation(() =>
    cursor([{ _id: CASH_ID, name: 'Hasnat', role: 'partner_hasnat' }])
  );
});

/* -------------------------------- helpers --------------------------------- */

const makeRequest = (url: string, init?: RequestInit) => new Request(url, init) as never;
const json = (body: unknown) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});

let keySeq = 0;
const freshKey = () => `test-idem-key-${++keySeq}`;

const incomeBody = (overrides: Record<string, unknown> = {}) => ({
  type: 'income',
  amount: 1500000,
  date: '2026-03-10',
  accountId: CASH_ID.toString(),
  category: 'sales_revenue',
  note: 'Order #123 COD received',
  idempotencyKey: freshKey(),
  ...overrides,
});

const withdrawalBody = (overrides: Record<string, unknown> = {}) => ({
  type: 'partner_withdrawal',
  amount: 500000,
  date: '2026-03-10',
  accountId: CASH_ID.toString(),
  partnerName: 'Hasnat',
  idempotencyKey: freshKey(),
  ...overrides,
});

/* ------------------------------ route imports ------------------------------ */

import * as transactionsRoute from '@/app/api/finance/transactions/route';
import * as reverseRoute from '@/app/api/finance/transactions/[id]/reverse/route';
import * as overviewRoute from '@/app/api/finance/overview/route';
import * as exportRoute from '@/app/api/finance/export/route';
import * as summaryRoute from '@/app/api/finance/summary/route';
import * as accountsRoute from '@/app/api/finance/accounts/route';
import * as accountByIdRoute from '@/app/api/finance/accounts/[id]/route';
import * as categoriesRoute from '@/app/api/finance/categories/route';
import * as categoryByIdRoute from '@/app/api/finance/categories/[id]/route';
import * as partnersRoute from '@/app/api/finance/partners/route';
import * as settingsRoute from '@/app/api/finance/settings/route';

const routeContext = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

/**
 * Several read handlers take no request argument; going through `invoke` keeps
 * the 401/403 matrix uniform without per-route signatures.
 */
const invoke = (handler: unknown, ...args: unknown[]): Promise<Response> =>
  (handler as (...a: unknown[]) => Promise<Response>)(...args);

/** Every Phase 3 finance endpoint and its default gate. */
const ALL_ROUTES: Array<{ name: string; call: () => Promise<Response> }> = [
  {
    name: 'GET /api/finance/transactions',
    call: () =>
      invoke(transactionsRoute.GET, makeRequest('http://localhost/api/finance/transactions')),
  },
  {
    name: 'POST /api/finance/transactions',
    call: () =>
      invoke(
        transactionsRoute.POST,
        makeRequest('http://localhost/api/finance/transactions', json(incomeBody()))
      ),
  },
  {
    name: 'POST /api/finance/transactions/[id]/reverse',
    call: () =>
      invoke(
        reverseRoute.POST,
        makeRequest('http://localhost/api/finance/transactions/x/reverse', json({})),
        routeContext(ORIG_ID.toString())
      ),
  },
  {
    name: 'GET /api/finance/overview',
    call: () => invoke(overviewRoute.GET, makeRequest('http://localhost/api/finance/overview')),
  },
  {
    name: 'GET /api/finance/export',
    call: () => invoke(exportRoute.GET, makeRequest('http://localhost/api/finance/export')),
  },
  {
    name: 'GET /api/finance/summary',
    call: () => invoke(summaryRoute.GET, makeRequest('http://localhost/api/finance/summary')),
  },
  {
    name: 'GET /api/finance/accounts',
    call: () => invoke(accountsRoute.GET, makeRequest('http://localhost/api/finance/accounts')),
  },
  {
    name: 'POST /api/finance/accounts',
    call: () =>
      invoke(
        accountsRoute.POST,
        makeRequest(
          'http://localhost/api/finance/accounts',
          json({ name: 'Wallet', kind: 'wallet', openingBalance: 100000 })
        )
      ),
  },
  {
    name: 'PATCH /api/finance/accounts/[id]',
    call: () =>
      invoke(
        accountByIdRoute.PATCH,
        makeRequest('http://localhost/api/finance/accounts/x', json({ isActive: false })),
        routeContext(CASH_ID.toString())
      ),
  },
  {
    name: 'GET /api/finance/categories',
    call: () => invoke(categoriesRoute.GET, makeRequest('http://localhost/api/finance/categories')),
  },
  {
    name: 'POST /api/finance/categories',
    call: () =>
      invoke(
        categoriesRoute.POST,
        makeRequest(
          'http://localhost/api/finance/categories',
          json({ name: 'new_cat', label: 'New Cat', type: 'expense' })
        )
      ),
  },
  {
    name: 'PATCH /api/finance/categories/[id]',
    call: () =>
      invoke(
        categoryByIdRoute.PATCH,
        makeRequest('http://localhost/api/finance/categories/x', json({ label: 'Renamed' })),
        routeContext('507f1f77bcf86cd799439030')
      ),
  },
  {
    name: 'GET /api/finance/partners',
    call: () => invoke(partnersRoute.GET, makeRequest('http://localhost/api/finance/partners')),
  },
  {
    name: 'GET /api/finance/settings',
    call: () => invoke(settingsRoute.GET, makeRequest('http://localhost/api/finance/settings')),
  },
  {
    name: 'PATCH /api/finance/settings',
    call: () =>
      invoke(
        settingsRoute.PATCH,
        makeRequest('http://localhost/api/finance/settings', json({ withdrawalLockedUntil: null }))
      ),
  },
];

/* --------------------------------- tests ---------------------------------- */

describe('401/403 on every finance route (BUILD #6)', () => {
  it.each(ALL_ROUTES.map((r) => [r.name, r.call] as const))(
    '%s returns 401 without a session',
    async (_name, call) => {
      vi.mocked(authorize).mockRejectedValueOnce(new AuthenticationError());
      const res = await call();
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
    }
  );

  it.each(ALL_ROUTES.map((r) => [r.name, r.call] as const))(
    '%s returns 403 when the role lacks the permission',
    async (_name, call) => {
      vi.mocked(authorize).mockRejectedValueOnce(new AuthorizationError('finance', 'write'));
      const res = await call();
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.success).toBe(false);
    }
  );
});

describe('Validation errors (TESTS: API)', () => {
  it('rejects a missing amount with field details', async () => {
    const body = incomeBody();
    delete (body as { amount?: number }).amount;
    const res = await transactionsRoute.POST(
      makeRequest('http://localhost/api/finance/transactions', json(body))
    );
    expect(res.status).toBe(400);
    const jsonBody = await res.json();
    expect(jsonBody.error.code).toBe('VALIDATION_ERROR');
    expect(jsonBody.error.details.map((d: { path: string }) => d.path)).toContain('amount');
  });

  it('rejects a float amount — money is integer paisa', async () => {
    const res = await transactionsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/transactions',
        json(incomeBody({ amount: 15000.5 }))
      )
    );
    expect(res.status).toBe(400);
  });

  it('rejects a zero or negative amount', async () => {
    for (const amount of [0, -100]) {
      const res = await transactionsRoute.POST(
        makeRequest('http://localhost/api/finance/transactions', json(incomeBody({ amount })))
      );
      expect(res.status).toBe(400);
    }
  });

  it('rejects a malformed accountId', async () => {
    const res = await transactionsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/transactions',
        json(incomeBody({ accountId: 'not-an-id' }))
      )
    );
    expect(res.status).toBe(400);
  });

  it('rejects an unknown account id', async () => {
    const res = await transactionsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/transactions',
        json(incomeBody({ accountId: new ObjectId().toString(), category: 'sales_revenue' }))
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an income entry charged to an expense category', async () => {
    const res = await transactionsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/transactions',
        json(incomeBody({ category: 'miscellaneous' }))
      )
    );
    expect(res.status).toBe(400);
  });

  it('rejects a transfer between the same account', async () => {
    const res = await transactionsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/transactions',
        json({
          type: 'transfer',
          amount: 250000,
          date: '2026-03-10',
          fromAccountId: CASH_ID.toString(),
          toAccountId: CASH_ID.toString(),
          idempotencyKey: freshKey(),
        })
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-JSON body', async () => {
    const res = await transactionsRoute.POST(
      makeRequest('http://localhost/api/finance/transactions', { method: 'POST', body: 'oops' })
    );
    expect(res.status).toBe(400);
  });
});

describe('Idempotency (BUILD #5)', () => {
  it('first POST creates the entry with 201 and audits it', async () => {
    const key = freshKey();
    const res = await transactionsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/transactions',
        json(incomeBody({ idempotencyKey: key }))
      )
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.amountDisplay).toContain('15000');
    expect(ledgerStore.size).toBe(1);
    expect(auditCollection.insertOne).toHaveBeenCalledTimes(1);
  });

  it('replaying the same key returns the original with 200 and no duplicate', async () => {
    const key = freshKey();
    const first = await transactionsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/transactions',
        json(incomeBody({ idempotencyKey: key }))
      )
    );
    const firstBody = await first.json();

    const second = await transactionsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/transactions',
        json(incomeBody({ idempotencyKey: key }))
      )
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data._id).toBe(firstBody.data._id);

    expect(ledgerStore.size).toBe(1); // the retry created nothing
    expect(transactionsCollection.insertOne).toHaveBeenCalledTimes(1);
  });

  it('a concurrent replay that slips past the lookup is caught by the unique index', async () => {
    const key = freshKey();
    await transactionsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/transactions',
        json(incomeBody({ idempotencyKey: key }))
      )
    );

    // Simulate the race: the pre-lookup misses (stale read), the insert hits the
    // unique index, and the route must fall back to the stored original.
    transactionsCollection.findOne.mockImplementationOnce(async () => null);
    const res = await transactionsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/transactions',
        json(incomeBody({ idempotencyKey: key }))
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(ledgerStore.size).toBe(1);
    expect(body.data._id).toBe(String([...ledgerStore.values()][0]._id));
  });

  it('an entry without an idempotency key is simply created', async () => {
    const body = incomeBody();
    delete (body as { idempotencyKey?: string }).idempotencyKey;
    const res = await transactionsRoute.POST(
      makeRequest('http://localhost/api/finance/transactions', json(body))
    );
    expect(res.status).toBe(201);
  });
});

describe('Withdrawals: approval gate and lock (BUILD #3)', () => {
  it('requires finance.approve, not just finance.create', async () => {
    const res = await transactionsRoute.POST(
      makeRequest('http://localhost/api/finance/transactions', json(withdrawalBody()))
    );
    expect(res.status).toBe(201);
    expect(vi.mocked(authorize)).toHaveBeenCalledWith('finance', 'approve');
  });

  it('a Partner without finance.approve gets 403 and no row is written', async () => {
    vi.mocked(authorize).mockRejectedValueOnce(new AuthorizationError('finance', 'approve'));
    const res = await transactionsRoute.POST(
      makeRequest('http://localhost/api/finance/transactions', json(withdrawalBody()))
    );
    expect(res.status).toBe(403);
    expect(ledgerStore.size).toBe(0);
  });

  it('is rejected with 409 WITHDRAWALS_LOCKED while locked', async () => {
    businessSettingsCollection.findOne.mockResolvedValue({
      key: 'business',
      withdrawalLockedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const res = await transactionsRoute.POST(
      makeRequest('http://localhost/api/finance/transactions', json(withdrawalBody()))
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('WITHDRAWALS_LOCKED');
    expect(ledgerStore.size).toBe(0);
  });

  it('is allowed once the lock has passed', async () => {
    businessSettingsCollection.findOne.mockResolvedValue({
      key: 'business',
      withdrawalLockedUntil: new Date(Date.now() - 60 * 1000),
    });
    const res = await transactionsRoute.POST(
      makeRequest('http://localhost/api/finance/transactions', json(withdrawalBody()))
    );
    expect(res.status).toBe(201);
  });

  it('does not lock ordinary income entries', async () => {
    businessSettingsCollection.findOne.mockResolvedValue({
      key: 'business',
      withdrawalLockedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const res = await transactionsRoute.POST(
      makeRequest('http://localhost/api/finance/transactions', json(incomeBody()))
    );
    expect(res.status).toBe(201);
  });
});

describe('Reversals (BUILD #4)', () => {
  const seedOriginal = () => {
    const original = {
      _id: ORIG_ID,
      type: 'expense',
      amount: 250000,
      date: new Date('2026-03-10T12:00:00.000Z'),
      accountId: CASH_ID,
      category: 'miscellaneous',
      isReversal: false,
      status: 'posted',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    ledgerStore.set(ORIG_ID.toString(), original as Record<string, unknown>);
    return original;
  };

  it('posts a mirror entry, marks the original reversed, and audits', async () => {
    const original = seedOriginal();
    const res = await reverseRoute.POST(
      makeRequest(
        'http://localhost/api/finance/transactions/x/reverse',
        json({ reason: 'Entered wrong amount' })
      ),
      routeContext(ORIG_ID.toString())
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.isReversal).toBe(true);
    expect(body.data.amountDisplay).toContain('-');

    const reversal = [...ledgerStore.values()].find((d) => d.isReversal === true);
    expect(reversal).toBeTruthy();
    expect(reversal!.amount).toBe(original.amount); // same amount, effect negated by isReversal
    expect((reversal as { reversesId?: ObjectId }).reversesId?.toString()).toBe(ORIG_ID.toString());
    expect(original.status).toBe('reversed'); // mutated only via updateOne($set)
    expect(auditCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'transaction_reversed' })
    );
  });

  it('cannot reverse the same transaction twice (409 ALREADY_REVERSED)', async () => {
    seedOriginal();
    const first = await reverseRoute.POST(
      makeRequest('http://localhost/api/finance/transactions/x/reverse', json({})),
      routeContext(ORIG_ID.toString())
    );
    expect(first.status).toBe(201);

    const second = await reverseRoute.POST(
      makeRequest('http://localhost/api/finance/transactions/x/reverse', json({})),
      routeContext(ORIG_ID.toString())
    );
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error.code).toBe('ALREADY_REVERSED');
    expect([...ledgerStore.values()].filter((d) => d.isReversal === true)).toHaveLength(1);
  });

  it('a reversal entry cannot itself be reversed (409)', async () => {
    seedOriginal();
    const first = await reverseRoute.POST(
      makeRequest('http://localhost/api/finance/transactions/x/reverse', json({})),
      routeContext(ORIG_ID.toString())
    );
    const firstBody = await first.json();

    const res = await reverseRoute.POST(
      makeRequest('http://localhost/api/finance/transactions/x/reverse', json({})),
      routeContext(firstBody.data._id)
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ALREADY_REVERSED');
  });

  it('returns 404 for an unknown transaction id', async () => {
    const res = await reverseRoute.POST(
      makeRequest('http://localhost/api/finance/transactions/x/reverse', json({})),
      routeContext(new ObjectId().toString())
    );
    expect(res.status).toBe(404);
  });

  it('rejects a malformed id', async () => {
    const res = await reverseRoute.POST(
      makeRequest('http://localhost/api/finance/transactions/x/reverse', json({})),
      routeContext('not-an-objectid' as never)
    );
    expect(res.status).toBe(400);
  });
});

describe('Withdrawal lock settings (BUILD #3)', () => {
  it('PATCH sets the lock as a Karachi date and audits the change', async () => {
    const res = await settingsRoute.PATCH(
      makeRequest(
        'http://localhost/api/finance/settings',
        json({ withdrawalLockedUntil: '2027-02-04' })
      )
    );
    expect(res.status).toBe(200);
    expect(businessSettingsCollection.updateOne).toHaveBeenCalledWith(
      { key: 'business' },
      expect.objectContaining({
        $set: expect.objectContaining({ withdrawalLockedUntil: expect.any(Date) }),
      }),
      expect.objectContaining({ upsert: true })
    );
    expect(auditCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'business_settings_updated' })
    );
  });

  it('PATCH with null clears the lock', async () => {
    const res = await settingsRoute.PATCH(
      makeRequest('http://localhost/api/finance/settings', json({ withdrawalLockedUntil: null }))
    );
    expect(res.status).toBe(200);
    expect(businessSettingsCollection.updateOne).toHaveBeenCalledWith(
      { key: 'business' },
      expect.objectContaining({
        $set: expect.objectContaining({ withdrawalLockedUntil: undefined }),
      }),
      expect.objectContaining({ upsert: true })
    );
  });

  it('rejects an unparseable date', async () => {
    const res = await settingsRoute.PATCH(
      makeRequest(
        'http://localhost/api/finance/settings',
        json({ withdrawalLockedUntil: 'tomorrow' })
      )
    );
    expect(res.status).toBe(400);
  });
});

describe('Accounts and categories management (BUILD #1, #2)', () => {
  it('creates an account with an opening balance in paisa', async () => {
    const res = await accountsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/accounts',
        json({ name: 'Wallet', kind: 'wallet', openingBalance: 1234567 })
      )
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.openingBalance).toBe(1234567);
    expect(auditCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'account_created' })
    );
  });

  it('rejects a duplicate account name with 409 DUPLICATE', async () => {
    const res = await accountsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/accounts',
        json({ name: 'Cash', kind: 'cash', openingBalance: 0 })
      )
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('DUPLICATE');
  });

  it('rejects an unknown account kind', async () => {
    const res = await accountsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/accounts',
        json({ name: 'Gold', kind: 'vault', openingBalance: 0 })
      )
    );
    expect(res.status).toBe(400);
  });

  it('creates a category with a stored slug', async () => {
    const res = await categoriesRoute.POST(
      makeRequest(
        'http://localhost/api/finance/categories',
        json({ name: 'new_cat', label: 'New Cat', type: 'expense' })
      )
    );
    expect(res.status).toBe(201);
    const doc = (await categoriesCollection.insertOne.mock.calls[0][0]) as Record<string, unknown>;
    expect(doc.name).toBe('new_cat');
  });

  it('rejects an uppercase slug — the API enforces ^[a-z0-9_]+$', async () => {
    const res = await categoriesRoute.POST(
      makeRequest(
        'http://localhost/api/finance/categories',
        json({ name: 'New_Cat', label: 'New Cat', type: 'expense' })
      )
    );
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate category slug with 409', async () => {
    const res = await categoriesRoute.POST(
      makeRequest(
        'http://localhost/api/finance/categories',
        json({ name: 'miscellaneous', label: 'Misc', type: 'expense' })
      )
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('DUPLICATE');
  });
});
