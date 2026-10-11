/**
 * Phase 3 e2e — the full money loop in the browser at desktop, tablet and
 * mobile widths: add income, add expense, transfer, reverse an entry with
 * confirmation, filter the list and export the filtered rows as CSV.
 *
 * The last test fails on any console error or uncaught exception (hydration
 * warnings included) while walking every Finance screen, per the brief's
 * "check the browser console" requirement.
 *
 * Runs against the production build (playwright.config.ts webServer) with the
 * Founder session restored from auth.setup.ts. Entries carry unique notes so
 * parallel projects and reruns never collide, and every assertion is scoped to
 * a `tr`/`li` that contains the run's note — the ledger is append-only and the
 * dev database is shared.
 */
import fs from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const openTransactions = async (page: Page) => {
  await page.goto('/finance/transactions');
  await expect(page.getByRole('button', { name: 'New transaction' })).toBeVisible();
};

/** The single visible desktop row or mobile card whose text contains `note`.
 * `:visible` matters: only one of the two renderings is shown per breakpoint
 * and the hidden one would otherwise win the selector race on mobile. */
const entryCard = (page: Page, note: string): Locator =>
  page.locator('tr:visible, li:visible').filter({ hasText: note }).first();

/** Fills and posts one ledger entry through the modal; waits for the toast. */
const createEntry = async (
  page: Page,
  fields: {
    type?: 'Income' | 'Expense' | 'Transfer';
    amount: string;
    note: string;
    account?: string;
    category?: string;
    from?: string;
    to?: string;
  }
) => {
  await page.getByRole('button', { name: 'New transaction' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  if (fields.type) {
    await dialog.getByLabel('Type').selectOption({ label: fields.type });
  }
  await dialog.getByLabel('Amount (PKR)').fill(fields.amount);

  if (fields.type === 'Transfer') {
    await dialog.getByLabel('From account').selectOption({ label: fields.from! });
    await dialog.getByLabel('To account').selectOption({ label: fields.to! });
  } else {
    await dialog.getByLabel('Account').selectOption({ label: fields.account! });
    if (fields.category) {
      await dialog.getByLabel('Category').selectOption({ label: fields.category });
    }
  }
  await dialog.getByLabel('Note').fill(fields.note);

  // Gate on the create POST so a slow server under parallel load cannot make
  // the transient success toast expire before the assertion runs.
  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/api/finance/transactions'),
    { timeout: 30_000 }
  );
  await dialog.getByRole('button', { name: 'Save transaction' }).click();
  await created;
  await expect(page.getByRole('status').filter({ hasText: 'recorded' })).toBeVisible();
  await expect(dialog).toBeHidden();
};

/** Narrows the list via the debounced search box. */
const searchNote = async (page: Page, note: string) => {
  await page.getByLabel('Search', { exact: true }).fill(note);
};

test.describe('Phase 3 finance ledger', () => {
  test('adds an income entry and finds it in the ledger', async ({ page }) => {
    const note = `e2e income ${uid()}`;
    await openTransactions(page);
    await createEntry(page, {
      type: 'Income',
      amount: '5432.10',
      account: 'Cash',
      category: 'Sales Revenue',
      note,
    });

    await searchNote(page, note);
    const entry = entryCard(page, note);
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('Income');
    await expect(entry).toContainText('PKR 5432.10');
    await expect(entry).toContainText('Sales Revenue');
    await expect(entry).toContainText('Posted');
  });

  test('adds an expense entry shown as a deduction', async ({ page }) => {
    const note = `e2e expense ${uid()}`;
    await openTransactions(page);
    await createEntry(page, {
      type: 'Expense',
      amount: '99.99',
      account: 'Cash',
      category: 'Meta Ads',
      note,
    });

    await searchNote(page, note);
    const entry = entryCard(page, note);
    await expect(entry).toContainText('Expense');
    await expect(entry).toContainText('PKR 99.99');
    await expect(entry).toContainText('Meta Ads');
  });

  test('records a transfer that never touches income or expense', async ({ page }) => {
    const note = `e2e transfer ${uid()}`;
    await openTransactions(page);
    await createEntry(page, {
      type: 'Transfer',
      amount: '1000.00',
      from: 'Cash',
      to: 'Bank Account',
      note,
    });

    await searchNote(page, note);
    const entry = entryCard(page, note);
    await expect(entry).toContainText('Transfer');
    await expect(entry).toContainText('PKR 1000.00');

    // The server-computed totals for the same search must show the transfer is
    // neutral: no revenue, no expense, no net cash flow.
    const resp = await page.request.get(
      `/api/finance/transactions?search=${encodeURIComponent(note)}`
    );
    expect(resp.ok()).toBe(true);
    const body = await resp.json();
    expect(body.data.summary.revenue).toBe(0);
    expect(body.data.summary.expense).toBe(0);
    expect(body.data.summary.netCashFlow).toBe(0);
  });

  test('reverses an entry with confirmation, keeping the original visible', async ({ page }) => {
    const note = `e2e reversible ${uid()}`;
    const reason = `e2e-reason-${uid()}`;
    await openTransactions(page);
    await createEntry(page, {
      type: 'Income',
      amount: '777.00',
      account: 'Cash',
      category: 'Sales Revenue',
      note,
    });

    await searchNote(page, note);
    // The Reverse click must be scoped to OUR card: the search refetch can be
    // in flight under parallel load, and a page-wide `.first()` would then hit
    // a stale unfiltered row and reverse another test's entry.
    const entry = entryCard(page, note);
    await expect(entry).toBeVisible();
    await entry.getByRole('button', { name: 'Reverse' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Reverse this transaction?')).toBeVisible();
    await dialog.getByLabel('Reason (optional)').fill(reason);

    // Gate on the actual network calls: under parallel load (four projects
    // against one server plus remote Atlas) the reversal POST can exceed the
    // default 10s expect window, which would miss the transient toast and the
    // debounced list refetch. POST → toast → refreshed GET → assert.
    const reversePosted = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes('/reverse'),
      { timeout: 30_000 }
    );
    const refreshed = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        r.url().includes('/api/finance/transactions?') &&
        r.status() === 200,
      { timeout: 30_000 }
    );
    await dialog.getByRole('button', { name: 'Confirm reversal' }).click();
    await reversePosted;
    await expect(page.getByRole('status').filter({ hasText: 'Reversal posted' })).toBeVisible();
    await expect(dialog).toBeHidden();
    await refreshed;

    // The original stays on screen, now badged "Reversed".
    await expect(entryCard(page, note)).toContainText('Reversed', { timeout: 20_000 });

    // And the mirror entry exists as its own row with the negated amount —
    // the reversal math (SPEC §5) verified end to end through the API.
    const resp = await page.request.get(
      `/api/finance/transactions?search=${encodeURIComponent(reason)}`
    );
    const body = await resp.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].isReversal).toBe(true);
    expect(body.data.items[0].amountDisplay).toBe('PKR -777.00');
    expect(body.data.summary.revenue).toBe(-77700);
  });

  test('a posted entry cannot be reversed twice', async ({ page }) => {
    const note = `e2e double reverse ${uid()}`;
    await openTransactions(page);
    await createEntry(page, {
      type: 'Expense',
      amount: '50.00',
      account: 'Cash',
      category: 'Meta Ads',
      note,
    });

    await searchNote(page, note);
    // Scoped to our card so an in-flight search refetch cannot make a page-wide
    // `.first()` Reverse click land on another test's entry.
    const target = entryCard(page, note);
    await expect(target).toBeVisible();
    await target.getByRole('button', { name: 'Reverse' }).click();
    const reversePosted = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes('/reverse'),
      { timeout: 30_000 }
    );
    const refreshed = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        r.url().includes('/api/finance/transactions?') &&
        r.status() === 200,
      { timeout: 30_000 }
    );
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm reversal' }).click();
    await reversePosted;
    await expect(page.getByRole('status').filter({ hasText: 'Reversal posted' })).toBeVisible();
    await refreshed;

    // The original now shows "Reversed" and offers no second Reverse action.
    const entry = entryCard(page, note);
    await expect(entry).toContainText('Reversed', { timeout: 20_000 });
    await expect(entry.getByRole('button', { name: 'Reverse' })).toHaveCount(0);
  });

  test('filters narrow the list and clear restores it', async ({ page }) => {
    const note = `e2e filter ${uid()}`;
    await openTransactions(page);
    await createEntry(page, {
      type: 'Expense',
      amount: '25.00',
      account: 'Cash',
      category: 'Meta Ads',
      note,
    });

    // Search finds exactly this entry.
    await searchNote(page, note);
    await expect(entryCard(page, note)).toBeVisible();

    // Type=Income plus the note must match nothing (it is an expense).
    await page.getByLabel('Type').selectOption({ label: 'Income' });
    await expect(page.getByText('No transactions found')).toBeVisible();

    // Clearing brings it back.
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await searchNote(page, note);
    await expect(entryCard(page, note)).toBeVisible();
  });

  test('exports the filtered rows as CSV', async ({ page }) => {
    const note = `e2e export ${uid()}`;
    await openTransactions(page);
    await createEntry(page, {
      type: 'Income',
      amount: '1234.56',
      account: 'Cash',
      category: 'Sales Revenue',
      note,
    });

    await searchNote(page, note);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Export CSV' }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^decoricks-transactions-.*\.csv$/);
    const path = await download.path();
    expect(path).not.toBeNull();
    const csv = fs.readFileSync(path!, 'utf8');
    expect(csv.split('\r\n')[0]).toBe(
      'Date,Type,Amount (PKR),Account,From account,To account,Category,Partner,Payment method,Note,Status'
    );
    expect(csv).toContain(note);
    expect(csv).toContain('1234.56');
    expect(csv).toContain('Income');
  });

  test('finance screens load without console errors or hydration warnings', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

    for (const route of [
      '/finance',
      '/finance/transactions',
      '/finance/accounts',
      '/finance/categories',
    ]) {
      await page.goto(route);
      await expect(page.getByRole('banner')).toBeVisible();
    }

    // ResizeObserver loop notices and missing-asset network noise are not app
    // defects; anything else — hydration warnings included — fails the test.
    const real = problems.filter((p) => !/ResizeObserver|favicon|net::ERR_/i.test(p));
    expect(real).toEqual([]);
  });
});
