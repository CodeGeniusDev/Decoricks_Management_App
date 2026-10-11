/**
 * Phase 4 API tests — the security and integrity checks the brief requires:
 *   • 401/403 on every Phase 4 route (budgets, P&L, cash flow, distributions,
 *     settings)
 *   • a Partner without the permission cannot write and no row is created
 *   • locked distributions refuse adjustment (409 DISTRIBUTION_LOCKED) and
 *     double-approval (409 INVALID_STATUS)
 *   • validation errors on malformed budgets, months, adjustments and policy
 *   • the SPEC §5 worked example lands on the stored distribution exactly
 *   • no hard deletes: the budget detail route exports no DELETE.
 *
 * Same harness as the Phase 3 suite: handlers run against in-memory mock
 * collections; `@/lib/authorization` is globally mocked to a permissive
 * Founder (src/test/setup.ts) and each denial test overrides the next call
 * with the real error classes so `handleRouteError` maps production statuses.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { authorize, AuthenticationError, AuthorizationError } from '@/lib/authorization';

/* ----------------------------- mock collections ---------------------------- */

interface MockCursor {
  sort: (spec?: Record<string, number>) => MockCursor;
  skip: (n: number) => MockCursor;
  limit: (n: number) => MockCursor;
  project: () => MockCursor;
  toArray: () => Promise<Record<string, unknown>[]>;
}

const toDocs = (docs: Record<string, unknown>[]) => [...docs];

const mockCursor = (docs: Record<string, unknown>[]): MockCursor => {
  const api: MockCursor = {
    sort: (spec = {}) => {
      const key = Object.keys(spec)[0];
      const dir = spec[key] ?? 1;
      const sorted = [...docs].sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        if (av instanceof Date && bv instanceof Date) return av.getTime() - bv.getTime();
        return String(av ?? '').localeCompare(String(bv ?? ''));
      });
      return mockCursor(dir < 0 ? sorted.reverse() : sorted);
    },
    skip: (n) => mockCursor(docs.slice(n)),
    limit: (n) => mockCursor(docs.slice(0, n)),
    project: () => mockCursor(docs),
    toArray: async () => toDocs(docs),
  };
  return api;
};

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
const budgetsCollection = makeCollection();
const distributionsCollection = makeCollection();

const collections: Record<string, unknown> = {
  transactions: transactionsCollection,
  accounts: accountsCollection,
  financeCategories: categoriesCollection,
  businessSettings: businessSettingsCollection,
  auditLog: auditCollection,
  budgets: budgetsCollection,
  profitDistributions: distributionsCollection,
};

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => ({ collection: (name: string) => collections[name] })),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@/lib/models/Operations', async () => {
  const actual = await vi.importActual<typeof import('@/lib/models/Operations')>(
    '@/lib/models/Operations'
  );
  return { ...actual, ensureOperationsIndexes: vi.fn(async () => undefined) };
});

vi.mock('@/lib/models/Distribution', async () => {
  const actual = await vi.importActual<typeof import('@/lib/models/Distribution')>(
    '@/lib/models/Distribution'
  );
  return { ...actual, ensureDistributionIndexes: vi.fn(async () => undefined) };
});

/* --------------------------------- stores ---------------------------------- */

const CASH_ID = new ObjectId('507f1f77bcf86cd799439011');
const BANK_ID = new ObjectId('507f1f77bcf86cd799439012');

const sameDate = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date && a.getTime() === b.getTime();

const eq = (a: unknown, b: unknown) =>
  a instanceof ObjectId && b instanceof ObjectId
    ? a.equals(b)
    : a instanceof Date || b instanceof Date
      ? sameDate(a, b)
      : String(a) === String(b);

/** Generic in-memory collection: equality matches on _id / scalar keys. */
const createStore = () => {
  const store = new Map<string, Record<string, unknown>>();
  const matches = (doc: Record<string, unknown>, query: Record<string, unknown>) =>
    Object.entries(query).every(([key, value]) => {
      if (value && typeof value === 'object' && !(value instanceof ObjectId) && !(value instanceof Date)) {
        const q = value as Record<string, unknown>;
        if ('$gte' in q || '$lte' in q) {
          const d = doc[key] as Date;
          if ('$gte' in q && d.getTime() < (q.$gte as Date).getTime()) return false;
          if ('$lte' in q && d.getTime() > (q.$lte as Date).getTime()) return false;
          return true;
        }
        if (typeof q.$regex === 'string') return new RegExp(q.$regex).test(String(doc[key] ?? ''));
        return false; // unsupported operators: the mock returns everything else
      }
      return eq(doc[key], value);
    });
  return {
    store,
    find: (query: Record<string, unknown> = {}) =>
      mockCursor([...store.values()].filter((d) => matches(d, query))),
    findOne: (query: Record<string, unknown> = {}) =>
      [...store.values()].find((d) => matches(d, query)) ?? null,
    insertOne: (doc: Record<string, unknown>) => {
      const _id = doc._id instanceof ObjectId ? doc._id : new ObjectId();
      const stored = { ...doc, _id };
      store.set(_id.toString(), stored);
      return { insertedId: _id };
    },
    updateOne: (
      query: Record<string, unknown>,
      update: { $set?: Record<string, unknown>; $push?: Record<string, unknown> }
    ) => {
      const doc = [...store.values()].find((d) => matches(d, query));
      if (doc) {
        if (update.$set) Object.assign(doc, update.$set);
        for (const [key, value] of Object.entries(update.$push ?? {})) {
          const list = (doc[key] as unknown[]) ?? [];
          list.push(value);
          (doc as Record<string, unknown>)[key] = list;
        }
      }
      return { acknowledged: true, matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
    },
  };
};

let ledger: ReturnType<typeof createStore>;
let budgets: ReturnType<typeof createStore>;
let distributions: ReturnType<typeof createStore>;

/** Mutable settings document — PATCH writes it, GET/PATCH re-read it. */
let settingsDoc: Record<string, unknown> | null;

/** SPEC §5 September-2026 month: net profit 4,133.36 = 413,336 paisa. */
const SPEC_LEDGER = () => [
  { type: 'income', amount: 500000, category: 'order_sale' },
  { type: 'income', amount: 350000, category: 'order_sale' },
  { type: 'income', amount: 720000, category: 'order_sale' },
  { type: 'expense', amount: 200000, category: 'refunds_return_costs' },
  { type: 'expense', amount: 50000, category: 'refunds_return_costs' },
  { type: 'expense', amount: 426664, category: 'product_purchasing' },
  { type: 'expense', amount: 200000, category: 'meta_ads' },
  { type: 'expense', amount: 50000, category: 'shopify_subscription' },
  { type: 'expense', amount: 150000, category: 'shipping_courier' },
  { type: 'expense', amount: 80000, category: 'packaging' },
].map((doc, i) => ({
  ...doc,
  _id: new ObjectId(),
  accountId: CASH_ID,
  // Noon Karachi on 15 Sep 2026 — safely inside the month from either side.
  date: new Date(`2026-09-${15 + (i > 8 ? 1 : 0)}T07:00:00.000Z`),
  isReversal: false,
  status: 'posted',
  createdAt: new Date(),
  updatedAt: new Date(),
}));

/** The SPEC §3.2 default policy the distribution engines must consume. */
const SPEC_SETTINGS = () => ({
  key: 'business',
  profitSharing: {
    partners: [
      { name: 'Abdullah', percentage: 20, reinvestPercentage: 100 },
      { name: 'Hasnat', percentage: 20, reinvestPercentage: 50 },
      { name: 'Ali', percentage: 20, reinvestPercentage: 100 },
      { name: 'Afnan', percentage: 20, reinvestPercentage: 0 },
    ],
    charityPercentage: 20,
  },
  budgetThresholds: { warning: 80, critical: 100 },
  updatedAt: new Date(),
});

beforeEach(() => {
  vi.clearAllMocks();
  ledger = createStore();
  budgets = createStore();
  distributions = createStore();
  settingsDoc = SPEC_SETTINGS() as never;
  for (const doc of SPEC_LEDGER()) ledger.store.set(String(doc._id), doc as never);

  transactionsCollection.find.mockImplementation(ledger.find);
  transactionsCollection.findOne.mockImplementation(ledger.findOne);
  transactionsCollection.insertOne.mockImplementation(ledger.insertOne);
  transactionsCollection.updateOne.mockImplementation(ledger.updateOne);
  transactionsCollection.countDocuments.mockImplementation(
    async (query: Record<string, unknown> = {}) => ledger.find(query).toArray().then((d) => d.length)
  );

  budgetsCollection.find.mockImplementation(budgets.find);
  budgetsCollection.findOne.mockImplementation(budgets.findOne);
  budgetsCollection.insertOne.mockImplementation(budgets.insertOne);
  budgetsCollection.updateOne.mockImplementation(budgets.updateOne);

  distributionsCollection.find.mockImplementation(distributions.find);
  distributionsCollection.findOne.mockImplementation(distributions.findOne);
  distributionsCollection.insertOne.mockImplementation(distributions.insertOne);
  distributionsCollection.updateOne.mockImplementation(distributions.updateOne);

  accountsCollection.find.mockImplementation(() =>
    mockCursor([
      { _id: CASH_ID, name: 'Cash', kind: 'cash', openingBalance: 5000000, isActive: true, createdAt: new Date() },
      { _id: BANK_ID, name: 'Bank', kind: 'bank', openingBalance: 0, isActive: true, createdAt: new Date() },
    ])
  );
  categoriesCollection.find.mockImplementation(() => mockCursor([]));
  businessSettingsCollection.findOne.mockImplementation(
    async (query: Record<string, unknown> = {}) =>
      settingsDoc && (!query.key || settingsDoc.key === query.key) ? settingsDoc : null
  );
  businessSettingsCollection.updateOne.mockImplementation(
    async (
      _query: Record<string, unknown>,
      update: { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> }
    ) => {
      settingsDoc = {
        key: 'business',
        ...(settingsDoc ?? update.$setOnInsert ?? {}),
        ...(update.$set ?? {}),
      };
      return { acknowledged: true };
    }
  );
  auditCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });
});

/* --------------------------------- helpers --------------------------------- */

const P = (pkr: number) => Math.round(pkr * 100);
const makeRequest = (url: string, init?: RequestInit) => new Request(url, init) as never;
const json = (body: unknown) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});
const routeContext = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const invoke = (handler: unknown, ...args: unknown[]): Promise<Response> =>
  (handler as (...a: unknown[]) => Promise<Response>)(...args);

let keySeq = 0;
const freshKey = () => `p4-test-key-${++keySeq}`;

const budgetBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'September operating budget',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  categories: [{ category: 'meta_ads', budgeted: 500000 }],
  ...overrides,
});

/* ------------------------------ route imports ------------------------------ */

import * as budgetsRoute from '@/app/api/budgets/route';
import * as budgetDetailRoute from '@/app/api/budgets/[id]/route';
import * as budgetActionRoute from '@/app/api/budgets/[id]/action/route';
import * as plRoute from '@/app/api/finance/pl/route';
import * as cashFlowRoute from '@/app/api/finance/cash-flow/route';
import * as distributionsRoute from '@/app/api/finance/distributions/route';
import * as distributionDetailRoute from '@/app/api/finance/distributions/[id]/route';
import * as adjustmentsRoute from '@/app/api/finance/distributions/[id]/adjustments/route';
import * as approveRoute from '@/app/api/finance/distributions/[id]/approve/route';
import * as distributeRoute from '@/app/api/finance/distributions/[id]/distribute/route';
import * as settingsRoute from '@/app/api/finance/settings/route';

const SEP = 'http://localhost/api/finance/pl?period=month&date=2026-09-15';

/** Every Phase 4 endpoint and how to call it. */
const ALL_ROUTES: Array<{ name: string; call: () => Promise<Response> }> = [
  { name: 'GET /api/budgets', call: () => invoke(budgetsRoute.GET, makeRequest('http://localhost/api/budgets')) },
  { name: 'POST /api/budgets', call: () => invoke(budgetsRoute.POST, makeRequest('http://localhost/api/budgets', json(budgetBody()))) },
  {
    name: 'GET /api/budgets/[id]',
    call: () =>
      invoke(budgetDetailRoute.GET, makeRequest('http://localhost/api/budgets/x'), routeContext(CASH_ID.toString())),
  },
  {
    name: 'PUT /api/budgets/[id]',
    call: () =>
      invoke(
        budgetDetailRoute.PUT,
        makeRequest('http://localhost/api/budgets/x', json({ name: 'Renamed' })),
        routeContext(CASH_ID.toString())
      ),
  },
  {
    name: 'POST /api/budgets/[id]/action',
    call: () =>
      invoke(
        budgetActionRoute.POST,
        makeRequest('http://localhost/api/budgets/x/action', json({ action: 'approve' })),
        routeContext(CASH_ID.toString())
      ),
  },
  { name: 'GET /api/finance/pl', call: () => invoke(plRoute.GET, makeRequest(SEP)) },
  {
    name: 'GET /api/finance/cash-flow',
    call: () => invoke(cashFlowRoute.GET, makeRequest('http://localhost/api/finance/cash-flow?period=month&date=2026-09-15')),
  },
  { name: 'GET /api/finance/distributions', call: () => invoke(distributionsRoute.GET) },
  {
    name: 'POST /api/finance/distributions',
    call: () =>
      invoke(distributionsRoute.POST, makeRequest('http://localhost/api/finance/distributions', json({ month: '2026-09' }))),
  },
  {
    name: 'GET /api/finance/distributions/[id]',
    call: () =>
      invoke(distributionDetailRoute.GET, makeRequest('http://localhost/api/finance/distributions/x'), routeContext(CASH_ID.toString())),
  },
  {
    name: 'POST /api/finance/distributions/[id]/adjustments',
    call: () =>
      invoke(
        adjustmentsRoute.POST,
        makeRequest(
          'http://localhost/api/finance/distributions/x/adjustments',
          json({ partnerName: 'Hasnat', amount: -100, reason: 'Test adjustment' })
        ),
        routeContext(CASH_ID.toString())
      ),
  },
  {
    name: 'POST /api/finance/distributions/[id]/approve',
    call: () =>
      invoke(approveRoute.POST, makeRequest('http://localhost/api/finance/distributions/x/approve', json({})), routeContext(CASH_ID.toString())),
  },
  {
    name: 'POST /api/finance/distributions/[id]/distribute',
    call: () =>
      invoke(distributeRoute.POST, makeRequest('http://localhost/api/finance/distributions/x/distribute', json({})), routeContext(CASH_ID.toString())),
  },
  {
    name: 'PATCH /api/finance/settings',
    call: () =>
      invoke(settingsRoute.PATCH, makeRequest('http://localhost/api/finance/settings', json({ withdrawalLockedUntil: null }))),
  },
];

/* --------------------------------- the 401s -------------------------------- */

describe('401 on every Phase 4 route (TESTS: API)', () => {
  it.each(ALL_ROUTES.map((r) => [r.name, r.call] as const))(
    '%s returns 401 without a session',
    async (_name, call) => {
      vi.mocked(authorize).mockRejectedValueOnce(new AuthenticationError());
      const res = await call();
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHENTICATED');
    }
  );
});

/* --------------------------------- the 403s -------------------------------- */

describe('403 on every Phase 4 route when the permission is missing', () => {
  it.each(ALL_ROUTES.map((r) => [r.name, r.call] as const))(
    '%s returns 403 for a role without the gate',
    async (_name, call) => {
      vi.mocked(authorize).mockRejectedValueOnce(new AuthorizationError('finance', 'approve'));
      const res = await call();
      expect(res.status).toBe(403);
      expect((await res.json()).success).toBe(false);
    }
  );
});

describe('a Partner without permission cannot write (TESTS: API)', () => {
  it('writes nothing when budget creation is denied', async () => {
    vi.mocked(authorize).mockRejectedValueOnce(new AuthorizationError('budget', 'create'));
    const res = await budgetsRoute.POST(
      makeRequest('http://localhost/api/budgets', json(budgetBody()))
    );
    expect(res.status).toBe(403);
    expect(budgets.store.size).toBe(0);
    expect(auditCollection.insertOne).not.toHaveBeenCalled();
  });

  it('writes nothing when a distribution run is denied', async () => {
    vi.mocked(authorize).mockRejectedValueOnce(new AuthorizationError('finance', 'approve'));
    const res = await distributionsRoute.POST(
      makeRequest('http://localhost/api/finance/distributions', json({ month: '2026-09' }))
    );
    expect(res.status).toBe(403);
    expect(distributions.store.size).toBe(0);
  });

  it('still lets a Partner read the numbers (finance.view gates the reads)', async () => {
    // The global permissive mock stands in for a granted authorize; reads that
    // only need finance.view must answer 200, never touch the approve gate.
    vi.mocked(authorize).mockClear();
    const res = await plRoute.GET(makeRequest(SEP));
    expect(res.status).toBe(200);
    expect(vi.mocked(authorize)).toHaveBeenCalledWith('finance', 'view');
  });
});

/* ------------------------------ budget routes ------------------------------ */

describe('Budgets API (BUILD #1, #2)', () => {
  it('creates a budget with a number, computed total and audit entry', async () => {
    const res = await budgetsRoute.POST(
      makeRequest('http://localhost/api/budgets', json(budgetBody()))
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.budgetNumber).toMatch(/^BUDGET-\d{6}-\d{4}$/);
    expect(body.data.totalBudgeted).toBe(500000);
    expect(body.data.status).toBe('draft');
    expect(budgets.store.size).toBe(1);
    expect(auditCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'budget_created' })
    );
  });

  it('replays the original budget for a retried idempotency key', async () => {
    const key = freshKey();
    const first = await budgetsRoute.POST(
      makeRequest('http://localhost/api/budgets', json(budgetBody({ idempotencyKey: key })))
    );
    const firstBody = await first.json();
    const second = await budgetsRoute.POST(
      makeRequest('http://localhost/api/budgets', json(budgetBody({ idempotencyKey: key })))
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data._id).toBe(firstBody.data._id);
    expect(budgets.store.size).toBe(1);
  });

  it('rejects malformed budgets: no categories, float allocations, backwards periods', async () => {
    const cases: Array<Record<string, unknown>> = [
      budgetBody({ categories: [] }),
      budgetBody({ categories: [{ category: 'meta_ads', budgeted: 10.5 }] }),
      budgetBody({ periodStart: '2026-09-30', periodEnd: '2026-09-01' }),
      budgetBody({ periodStart: 'not-a-date' }),
    ];
    for (const body of cases) {
      const res = await budgetsRoute.POST(
        makeRequest('http://localhost/api/budgets', json(body))
      );
      expect(res.status).toBe(400);
    }
    expect(budgets.store.size).toBe(0);
  });

  it('rejects an asserted period kind the dates do not support', async () => {
    const res = await budgetsRoute.POST(
      makeRequest('http://localhost/api/budgets', json(budgetBody({ periodKind: 'weekly' })))
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.details[0].message).toContain('at most 7 days');
  });

  it('rejects duplicate categories', async () => {
    const res = await budgetsRoute.POST(
      makeRequest(
        'http://localhost/api/budgets',
        json(
          budgetBody({
            categories: [
              { category: 'meta_ads', budgeted: 100 },
              { category: 'Meta_Ads', budgeted: 200 },
            ],
          })
        )
      )
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.details[0].message).toContain('Duplicate');
  });

  it('computes actuals live from the ledger on the list — never from storage', async () => {
    await budgetsRoute.POST(
      makeRequest('http://localhost/api/budgets', json(budgetBody()))
    );
    const res = await budgetsRoute.GET(makeRequest('http://localhost/api/budgets'));
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    const budget = body.data[0];
    // SPEC ledger has 2,000.00 of meta_ads spend inside September.
    expect(budget.categories[0].actual).toBe(P(2000));
    expect(budget.categories[0].remaining).toBe(P(3000));
    expect(budget.percentUsed).toBe(40);
    expect(budget.level).toBe('ok');
  });

  it('emits threshold warnings from the configurable settings (notification hook)', async () => {
    await budgetsRoute.POST(
      makeRequest(
        'http://localhost/api/budgets',
        json(budgetBody({ categories: [{ category: 'meta_ads', budgeted: 220000 }] }))
      )
    );
    // 200000/220000 = 91% → past the 80 warning, under the 100 critical.
    const res = await budgetsRoute.GET(makeRequest('http://localhost/api/budgets'));
    const body = await res.json();
    expect(body.data[0].warnings).toEqual([
      { category: 'meta_ads', level: 'warning', percentUsed: 91, threshold: 80 },
    ]);
  });

  it('keeps edit history and audits every change', async () => {
    const created = await budgetsRoute.POST(
      makeRequest('http://localhost/api/budgets', json(budgetBody()))
    );
    const { data } = await created.json();

    const edit = await budgetDetailRoute.PUT(
      makeRequest(
        'http://localhost/api/budgets/x',
        json({ categories: [{ category: 'meta_ads', budgeted: 400000 }] })
      ),
      routeContext(data._id)
    );
    expect(edit.status).toBe(200);
    const edited = await edit.json();
    expect(edited.data.totalBudgeted).toBe(400000);
    expect(edited.data.revisions).toHaveLength(1);
    expect(edited.data.revisions[0].changes.join(' ')).toContain('meta_ads');
    expect(auditCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'budget_updated' })
    );
  });

  it('walks the lifecycle without hard deletes: approve, archive, reopen', async () => {
    const created = await budgetsRoute.POST(
      makeRequest('http://localhost/api/budgets', json(budgetBody()))
    );
    const { data } = await created.json();

    const approve = await budgetActionRoute.POST(
      makeRequest('http://localhost/api/budgets/x/action', json({ action: 'approve', reason: 'Board sign-off' })),
      routeContext(data._id)
    );
    expect(approve.status).toBe(200);
    expect((await approve.json()).data.status).toBe('active');

    const archive = await budgetActionRoute.POST(
      makeRequest('http://localhost/api/budgets/x/action', json({ action: 'archive' })),
      routeContext(data._id)
    );
    expect((await archive.json()).data.status).toBe('archived');
    expect(budgets.store.size).toBe(1); // archived, never deleted

    const reopen = await budgetActionRoute.POST(
      makeRequest('http://localhost/api/budgets/x/action', json({ action: 'reopen' })),
      routeContext(data._id)
    );
    expect((await reopen.json()).data.status).toBe('draft');
  });

  it('refuses impossible transitions and edits to archived budgets', async () => {
    const created = await budgetsRoute.POST(
      makeRequest('http://localhost/api/budgets', json(budgetBody()))
    );
    const { data } = await created.json();

    // active → approve is not a transition (draft only):
    await budgetActionRoute.POST(
      makeRequest('http://localhost/api/budgets/x/action', json({ action: 'approve' })),
      routeContext(data._id)
    );
    const second = await budgetActionRoute.POST(
      makeRequest('http://localhost/api/budgets/x/action', json({ action: 'approve' })),
      routeContext(data._id)
    );
    expect(second.status).toBe(400);

    await budgetActionRoute.POST(
      makeRequest('http://localhost/api/budgets/x/action', json({ action: 'archive' })),
      routeContext(data._id)
    );
    const editArchived = await budgetDetailRoute.PUT(
      makeRequest('http://localhost/api/budgets/x', json({ name: 'Too late' })),
      routeContext(data._id)
    );
    expect(editArchived.status).toBe(400);
  });

  it('exports no DELETE handler anywhere — budgets are never hard-deleted', () => {
    expect(
      (budgetDetailRoute as Record<string, unknown>).DELETE
    ).toBeUndefined();
    expect((budgetsRoute as Record<string, unknown>).DELETE).toBeUndefined();
  });

  it('answers 404 for an unknown budget and 400 for a malformed id', async () => {
    const missing = await budgetDetailRoute.GET(
      makeRequest('http://localhost/api/budgets/x'),
      routeContext(new ObjectId().toString())
    );
    expect(missing.status).toBe(404);
    const malformed = await budgetDetailRoute.GET(
      makeRequest('http://localhost/api/budgets/x'),
      routeContext('not-an-id')
    );
    expect(malformed.status).toBe(400);
  });
});

/* ---------------------------- P&L and cash flow ---------------------------- */

describe('P&L route — SPEC §5 numbers over a Karachi month', () => {
  it('returns the full chain with the provisional COGS label', async () => {
    const res = await plRoute.GET(makeRequest(SEP));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.profitLoss.revenue).toBe(P(15700));
    expect(data.profitLoss.refunds).toBe(P(2500));
    expect(data.profitLoss.netSales).toBe(P(13200));
    expect(data.profitLoss.cogs).toBe(P(4266.64));
    expect(data.profitLoss.cogsProvisional).toBe(true);
    expect(data.formulas.cogs).toContain('PROVISIONAL');
    expect(data.profitLoss.grossProfit).toBe(P(8933.36));
    expect(data.profitLoss.operatingExpenses).toBe(P(4800));
    expect(data.profitLoss.netProfit).toBe(P(4133.36));
    // The monthly trend chart always gets 12 buckets.
    expect(data.monthly).toHaveLength(12);
  });

  it('rejects an unparseable custom range', async () => {
    const res = await plRoute.GET(
      makeRequest('http://localhost/api/finance/pl?period=custom&from=garbage')
    );
    expect(res.status).toBe(400);
  });
});

describe('Cash-flow route — separate from profit, transfers excluded', () => {
  const url = 'http://localhost/api/finance/cash-flow?period=month&date=2026-09-15';

  it('cash in, cash out and balances match the ledger exactly', async () => {
    const res = await cashFlowRoute.GET(makeRequest(url));
    const { data } = await res.json();
    expect(data.cashFlow.cashIn).toBe(P(15700));
    expect(data.cashFlow.cashOut).toBe(P(2500) + P(4266.64) + P(4800));
    expect(data.cashFlow.netCashFlow).toBe(P(4133.36));
    expect(data.cashFlow.totalBalanceStart).toBe(P(50000));
    expect(data.cashFlow.totalBalanceEnd).toBe(P(50000) + P(4133.36));
    expect(data.formulas.netCashFlow).toContain('transfers excluded');
  });

  it('a transfer changes account balances but no business flow', async () => {
    ledger.insertOne({
      _id: new ObjectId(),
      type: 'transfer',
      amount: 250000,
      fromAccountId: CASH_ID,
      toAccountId: BANK_ID,
      accountId: null,
      date: new Date('2026-09-16T07:00:00.000Z'),
      isReversal: false,
      status: 'posted',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await cashFlowRoute.GET(makeRequest(url));
    const { data } = await res.json();
    expect(data.cashFlow.transferCount).toBe(1);
    expect(data.cashFlow.cashIn).toBe(P(15700)); // unchanged by the transfer
    expect(data.cashFlow.cashOut).toBe(P(2500) + P(4266.64) + P(4800));
    expect(data.cashFlow.totalBalanceEnd).toBe(P(50000) + P(4133.36));
    const cash = data.cashFlow.accounts.find((a: { accountId: string }) => a.accountId === CASH_ID.toString());
    expect(cash.balanceEnd).toBe(P(50000) + P(4133.36) - 250000);
  });
});

/* ------------------------------ distributions ------------------------------ */

describe('Distribution API — calculate, adjust, approve, distribute (BUILD #6)', () => {
  const run = async () => {
    const res = await distributionsRoute.POST(
      makeRequest('http://localhost/api/finance/distributions', json({ month: '2026-09' }))
    );
    expect(res.status).toBe(201);
    return res.json();
  };

  it('calculates the SPEC §5.8 split from the ledger and the configured policy', async () => {
    const { data } = await run();
    expect(data.distributionNumber).toBe('DIST-202609');
    expect(data.month).toBe('2026-09');
    expect(data.status).toBe('calculated');
    expect(data.locked).toBe(false);
    expect(data.netProfit).toBe(P(4133.36));
    expect(data.cogsProvisional).toBe(true);
    expect(data.charityShare).toEqual({ percentage: 20, amount: 82668 });
    expect(data.partnerShares.map((s: { shareAmount: number }) => s.shareAmount)).toEqual([
      82667, 82667, 82667, 82667,
    ]);
    expect(data.partnerShares.map((s: { reinvestedAmount: number }) => s.reinvestedAmount)).toEqual([
      82667, 41333, 82667, 0,
    ]);
    expect(data.reinvestmentAmount).toBe(P(2066.67));
    expect(data.retainedEarnings).toBe(0);
    // The grand total closes: charity + all finals + retained = net profit.
    expect(
      data.charityShare.amount +
        data.partnerShares.reduce((s: number, p: { finalAmount: number }) => s + p.finalAmount, 0) +
        data.retainedEarnings
    ).toBe(data.netProfit);
    expect(auditCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'profit_distribution_calculated' })
    );
  });

  it('replays the first record when the same month is run twice', async () => {
    const first = await run();
    const res = await distributionsRoute.POST(
      makeRequest('http://localhost/api/finance/distributions', json({ month: '2026-09' }))
    );
    expect(res.status).toBe(200);
    const second = await res.json();
    expect(second.data._id).toBe(first.data._id);
    expect(distributions.store.size).toBe(1);
  });

  it('rejects malformed months', async () => {
    for (const month of ['2026-13', '202609', 'not-a-month']) {
      const res = await distributionsRoute.POST(
        makeRequest('http://localhost/api/finance/distributions', json({ month }))
      );
      expect(res.status).toBe(400);
    }
    expect(distributions.store.size).toBe(0);
  });

  it('redistributes a deduction pro-rata and stays exactly zero-sum', async () => {
    const { data: plain } = await run();
    const before = plain.partnerShares.reduce((s: number, p: { finalAmount: number }) => s + p.finalAmount, 0);

    const res = await adjustmentsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/distributions/x/adjustments',
        json({ partnerName: 'Hasnat', amount: -7, reason: 'Damaged stock chargeback' })
      ),
      routeContext(plain._id)
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const sum = (d: typeof data) =>
      d.partnerShares.reduce((s: number, p: { finalAmount: number }) => s + p.finalAmount, 0);

    expect(sum(data)).toBe(before); // zero-sum: nothing leaked into retained
    expect(data.retainedEarnings).toBe(0);
    expect(data.charityShare.amount).toBe(82668); // charity is fixed
    const hasnat = data.partnerShares.find((p: { partnerName: string }) => p.partnerName === 'Hasnat');
    expect(hasnat.finalAmount).toBe(82667 - 7);
    expect(hasnat.adjustments).toHaveLength(1);
    expect(hasnat.adjustments[0].reason).toBe('Damaged stock chargeback');
    expect(
      data.charityShare.amount + sum(data) + data.retainedEarnings
    ).toBe(data.netProfit);
    expect(auditCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'profit_share_adjusted' })
    );
  });

  it('funds a bonus from retained earnings, never from the other partners', async () => {
    const { data: plain } = await run();
    const res = await adjustmentsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/distributions/x/adjustments',
        json({ partnerName: 'Afnan', amount: 5000, reason: 'Ramadan incentive agreed by partners' })
      ),
      routeContext(plain._id)
    );
    const { data } = await res.json();
    const afnan = data.partnerShares.find((p: { partnerName: string }) => p.partnerName === 'Afnan');
    expect(afnan.finalAmount).toBe(82667 + 5000);
    const abdullah = data.partnerShares.find((p: { partnerName: string }) => p.partnerName === 'Abdullah');
    expect(abdullah.finalAmount).toBe(82667); // untouched
    expect(data.retainedEarnings).toBe(-5000);
    expect(
      data.charityShare.amount +
        data.partnerShares.reduce((s: number, p: { finalAmount: number }) => s + p.finalAmount, 0) +
        data.retainedEarnings
    ).toBe(data.netProfit);
  });

  it('validates adjustments: unknown partner, missing reason, zero and float amounts', async () => {
    const { data } = await run();
    const bad = [
      { partnerName: 'Ghost', amount: -100, reason: 'Not a partner here' },
      { partnerName: 'Hasnat', amount: -100, reason: 'ab' }, // reason too short
      { partnerName: 'Hasnat', amount: 0, reason: 'Zero does nothing' },
      { partnerName: 'Hasnat', amount: 10.5, reason: 'Paisa must be whole' },
    ];
    for (const body of bad) {
      const res = await adjustmentsRoute.POST(
        makeRequest('http://localhost/api/finance/distributions/x/adjustments', json(body)),
        routeContext(data._id)
      );
      expect(res.status).toBe(400);
    }
  });

  it('locks on approve and refuses every mutation afterwards', async () => {
    const { data } = await run();

    const approve = await approveRoute.POST(
      makeRequest('http://localhost/api/finance/distributions/x/approve', json({})),
      routeContext(data._id)
    );
    expect(approve.status).toBe(200);
    const approved = await approve.json();
    expect(approved.data.status).toBe('approved');
    expect(approved.data.locked).toBe(true);
    expect(approved.data.approvedByName).toBe('Test Founder');

    // Money signed off is never recomputed:
    const adjust = await adjustmentsRoute.POST(
      makeRequest(
        'http://localhost/api/finance/distributions/x/adjustments',
        json({ partnerName: 'Hasnat', amount: -100, reason: 'Too late for this' })
      ),
      routeContext(data._id)
    );
    expect(adjust.status).toBe(409);
    expect((await adjust.json()).error.code).toBe('DISTRIBUTION_LOCKED');

    // And approval is a single explicit act:
    const again = await approveRoute.POST(
      makeRequest('http://localhost/api/finance/distributions/x/approve', json({})),
      routeContext(data._id)
    );
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('INVALID_STATUS');
  });

  it('distributes only after approval, and only once', async () => {
    const { data } = await run();

    const early = await distributeRoute.POST(
      makeRequest('http://localhost/api/finance/distributions/x/distribute', json({})),
      routeContext(data._id)
    );
    expect(early.status).toBe(409); // still 'calculated' — approval comes first
    expect((await early.json()).error.code).toBe('INVALID_STATUS');

    await approveRoute.POST(
      makeRequest('http://localhost/api/finance/distributions/x/approve', json({})),
      routeContext(data._id)
    );
    const done = await distributeRoute.POST(
      makeRequest('http://localhost/api/finance/distributions/x/distribute', json({})),
      routeContext(data._id)
    );
    expect(done.status).toBe(200);
    const marked = await done.json();
    expect(marked.data.status).toBe('distributed');
    expect(marked.data.locked).toBe(true);

    const twice = await distributeRoute.POST(
      makeRequest('http://localhost/api/finance/distributions/x/distribute', json({})),
      routeContext(data._id)
    );
    expect(twice.status).toBe(409);
  });

  it('lists and reads distributions; unknown id 404s and a malformed id 400s', async () => {
    const { data } = await run();
    const list = await distributionsRoute.GET();
    expect(list.status).toBe(200);
    expect((await list.json()).data).toHaveLength(1);

    const detail = await distributionDetailRoute.GET(
      makeRequest('http://localhost/api/finance/distributions/x'),
      routeContext(data._id)
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()).data.distributionNumber).toBe('DIST-202609');

    const missing = await distributionDetailRoute.GET(
      makeRequest('http://localhost/api/finance/distributions/x'),
      routeContext(new ObjectId().toString())
    );
    expect(missing.status).toBe(404);
    const malformed = await distributionDetailRoute.GET(
      makeRequest('http://localhost/api/finance/distributions/x'),
      routeContext('nope')
    );
    expect(malformed.status).toBe(400);
  });
});

/* --------------------------------- settings -------------------------------- */

describe('Settings API — configurable percentages and thresholds (BUILD #7)', () => {
  it('GET answers with the SPEC defaults and says the policy is unconfigured', async () => {
    businessSettingsCollection.findOne.mockResolvedValue(null);
    const res = await settingsRoute.GET();
    const { data } = await res.json();
    expect(data.policyConfigured).toBe(false);
    expect(data.budgetThresholds).toEqual({ warning: 80, critical: 100 });
    expect(data.withdrawalsLocked).toBe(false);
  });

  it('PATCH stores a policy and thresholds, and echoes them back', async () => {
    const res = await settingsRoute.PATCH(
      makeRequest(
        'http://localhost/api/finance/settings',
        json({
          withdrawalLockedUntil: null,
          profitSharing: {
            partners: [
              { name: 'Abdullah', percentage: 25, reinvestPercentage: 100 },
              { name: 'Hasnat', percentage: 25, reinvestPercentage: 50 },
              { name: 'Ali', percentage: 15, reinvestPercentage: 0 },
              { name: 'Afnan', percentage: 15, reinvestPercentage: 10 },
            ],
            charityPercentage: 20,
          },
          budgetThresholds: { warning: 75, critical: 90 },
        })
      )
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.policyConfigured).toBe(true);
    expect(data.budgetThresholds).toEqual({ warning: 75, critical: 90 });
    expect(data.profitSharing.partners[0].percentage).toBe(25);
    expect(auditCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'business_settings_updated' })
    );
  });

  it('rejects an impossible policy: partner shares above 100 or float percentages', async () => {
    for (const partners of [
      [
        { name: 'A', percentage: 60, reinvestPercentage: 0 },
        { name: 'B', percentage: 60, reinvestPercentage: 0 },
      ],
      [
        { name: 'A', percentage: 12.5, reinvestPercentage: 0 },
        { name: 'B', percentage: 20, reinvestPercentage: 0 },
      ],
      [{ name: 'A', percentage: 20, reinvestPercentage: 0 }, { name: 'A', percentage: 30, reinvestPercentage: 0 }],
    ]) {
      const res = await settingsRoute.PATCH(
        makeRequest(
          'http://localhost/api/finance/settings',
          json({ withdrawalLockedUntil: null, profitSharing: { partners, charityPercentage: 20 } })
        )
      );
      expect(res.status).toBe(400);
    }
  });

  it('rejects a warning threshold above the critical threshold', async () => {
    const res = await settingsRoute.PATCH(
      makeRequest(
        'http://localhost/api/finance/settings',
        json({ withdrawalLockedUntil: null, budgetThresholds: { warning: 95, critical: 90 } })
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.details[0].message).toContain('warning threshold');
  });

  it('requires the withdrawalLockedUntil key so a partial body cannot wipe the lock', async () => {
    const res = await settingsRoute.PATCH(
      makeRequest(
        'http://localhost/api/finance/settings',
        json({ budgetThresholds: { warning: 70, critical: 90 } })
      )
    );
    expect(res.status).toBe(400);
  });
});
