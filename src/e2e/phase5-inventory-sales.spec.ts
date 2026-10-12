import { expect, test } from '@playwright/test'
import { AFNAN_STATE, BASE_URL, CSRF_HEADER, FOUNDER_STATE, csrfFromState } from './helpers'

/**
 * Phase 5 acceptance: the full inventory-and-sales story through the real UI.
 *
 *   product → purchase (stock in, WAC, ledger expense) → order (reserve) →
 *   dispatch (courier expense) → delivered → confirm COD cash (income) →
 *   return (restock + refund) → transfer between locations.
 *
 * Every number the flow produces is re-read from the API at the end, so the
 * test asserts the server's derived stock (not a screenshot of it). Actions
 * run at three viewport widths through the Playwright projects (Desktop
 * Chrome, Pixel 5, iPad Pro); all tables in this app render as cards under
 * `md:`, and every locator here is scoped to a dialog or a row containing the
 * run's unique SKU, so both renderings pass the same assertions.
 *
 * Data isolation: the three projects run in parallel against the same test
 * database, so every record this spec creates carries a project- and
 * run-unique tag. Nothing is seeded and nothing pre-existing is touched.
 */

test.describe.configure({ timeout: 180_000 })

type SummaryLocation = { location: string; available: number; damaged: number; returned: number }
type SummaryItem = {
  _id: string
  sku: string
  name: string
  byLocation: SummaryLocation[]
  totalAvailable: number
}

interface Envelope<T> {
  success: boolean
  data: T
}

test('full flow: product → purchase → order → deliver → cash → return → transfer', async ({
  page,
  request,
}, testInfo) => {
  const tag = `${testInfo.project.name.replace(/[^a-zA-Z0-9]/g, '')}${Date.now()
    .toString(36)
    .slice(-5)}`.toLowerCase()
  const sku = `e2e-p5-${tag}`.toUpperCase()
  const productName = `E2E Vase ${tag}`
  const customerName = `E2E Customer ${tag}`

  // Console hygiene: SPEC requires no errors or hydration warnings.
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    // Resource-load noise (favicon etc.) is not an application error.
    if (message.text().includes('Failed to load resource')) return
    consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))

  /* 1. Product — created through the modal, never seeded. */
  await page.goto('/inventory/products')
  await page.getByRole('button', { name: 'New product' }).click()
  const productDialog = page.getByRole('dialog', { name: 'New product' })
  await productDialog.getByLabel('SKU').fill(sku)
  await productDialog.getByLabel('Name').fill(productName)
  await productDialog.getByLabel('Category').fill('e2e-test')
  await productDialog.getByLabel('Selling price (PKR)').fill('1500')
  await productDialog.getByLabel('Opening cost (PKR)').fill('800')
  await productDialog.getByLabel('Reorder level (units)').fill('2')
  await productDialog.getByRole('button', { name: 'Create product' }).click()
  await expect(page.getByText(`${productName} added.`)).toBeVisible()
  // Tables render twice (desktop rows / mobile cards) — assert the visible one.
  await expect(page.getByText(sku).locator('visible=true').first()).toBeVisible()

  const productResponse = await request.get(`/api/products?search=${sku}`)
  expect(productResponse.ok()).toBeTruthy()
  const products = (await productResponse.json()) as Envelope<{ _id: string; cost: number }[]>
  const productId = products.data[0]._id
  expect(products.data[0].cost).toBe(80000) // paisa, from the opening cost

  /* 2. Purchase — 10 units at 900 into Sheikhupura. */
  await page.goto('/inventory/purchases')
  await page.getByRole('button', { name: 'Record purchase', exact: true }).click()
  const purchaseDialog = page.getByRole('dialog', { name: 'Record a purchase' })
  await purchaseDialog.getByLabel('Product').selectOption(productId)
  await purchaseDialog.getByLabel('Received into').selectOption({ label: 'Sheikhupura' })
  await purchaseDialog.getByLabel('Quantity').fill('10')
  await purchaseDialog.getByLabel('Unit cost (PKR)').fill('900')
  await purchaseDialog.getByRole('button', { name: 'Record purchase' }).click()
  // The toast shows the weighted-average restatement — the whole point of §5.4.
  await expect(page.getByText('Average cost moved from')).toBeVisible()

  /* 3. Order — 2 units on COD, courier charge 200, shipped from Sheikhupura. */
  await page.goto('/sales')
  await page.getByRole('button', { name: 'New order' }).click()
  const orderDialog = page.getByRole('dialog', { name: 'New order' })
  await orderDialog.getByLabel('Name').fill(customerName)
  await orderDialog.getByLabel('Phone').fill('03001234567')
  await orderDialog.getByLabel('City').fill('Karachi')
  await orderDialog.getByLabel('Sales channel').fill('e2e-channel')
  await orderDialog.getByLabel('Address').fill('E2E test street 1')
  await orderDialog.getByLabel('Ship from').selectOption({ label: 'Sheikhupura' })
  await orderDialog.getByLabel('Item 1').selectOption(productId)
  await orderDialog.getByLabel('Qty').fill('2')
  await orderDialog.getByLabel('Courier charge we pay (PKR)').fill('200')
  await orderDialog.getByRole('button', { name: 'Create order' }).click()
  await expect(page.getByText('created — stock reserved')).toBeVisible()

  const ordersResponse = await request.get(`/api/orders?search=${encodeURIComponent(customerName)}`)
  expect(ordersResponse.ok()).toBeTruthy()
  const orders = (await ordersResponse.json()) as Envelope<{
    orders: Array<{ _id: string; orderNumber: string; total: number; orderStatus: string }>
  }>
  const order = orders.data.orders[0]
  expect(order.orderStatus).toBe('pending')
  // Total is items + shipping charged to the customer; the courier charge we
  // pay is our expense, never part of what the customer owes.
  expect(order.total).toBe(2 * 150000)
  await page.goto(`/sales/${order._id}`)
  await expect(page.getByText(order.orderNumber).first()).toBeVisible()

  // Reserved stock is already out of "available" — the last-unit guard is live.
  const afterReserve = await summaryFor(request, sku)
  expect(availableIn(afterReserve, 'sheikhupura')).toBe(8)

  /* 4. Dispatch → delivered → COD cash. */
  await page.getByRole('button', { name: 'Dispatch', exact: true }).click()
  const dispatchDialog = page.getByRole('dialog', { name: 'Dispatch this order?' })
  await dispatchDialog.getByRole('button', { name: 'Dispatch' }).click()
  await expect(page.getByText('Courier charge posted as a ledger expense')).toBeVisible()

  await page.getByRole('button', { name: 'Mark delivered' }).click()
  await expect(page.getByText('marked delivered')).toBeVisible()

  await page.getByRole('button', { name: 'Confirm COD cash received' }).click()
  await expect(page.getByText('received — income posted to the ledger')).toBeVisible()

  const afterCash = await request.get(`/api/orders/${order._id}`)
  const paidOrder = (await afterCash.json()) as Envelope<{
    incomeTransactionId: string | null
    courierExpenseTransactionId: string | null
    paymentStatus: string
  }>
  expect(paidOrder.data.paymentStatus).toBe('received')
  expect(paidOrder.data.incomeTransactionId).toBeTruthy()
  expect(paidOrder.data.courierExpenseTransactionId).toBeTruthy()

  // The sale consumed the reserved units; available is still 8, not 10−0.
  expect(availableIn(await summaryFor(request, sku), 'sheikhupura')).toBe(8)

  /* 5. Return — 1 unit restocked, 750 refunded. */
  await page.getByRole('button', { name: 'Record return' }).click()
  const returnDialog = page.getByRole('dialog', { name: new RegExp(`Return ${order.orderNumber}`) })
  await returnDialog.getByLabel('Qty').fill('1')
  await returnDialog.getByLabel('Reason').fill('Customer changed their mind')
  await returnDialog.getByLabel('Refund to customer (PKR)').fill('750')
  await returnDialog.getByRole('button', { name: 'Record return' }).click()
  await expect(page.getByText('recorded — movements posted and refund entries linked')).toBeVisible()
  // A partial return does not rewrite the order status; the return record on
  // the order is the truth the UI must show.
  await expect(page.getByText('Returns on this order')).toBeVisible()
  await expect(page.getByText('PKR 750.00 refund')).toBeVisible()

  expect(availableIn(await summaryFor(request, sku), 'sheikhupura')).toBe(9)

  /* 6. Transfer — 3 units Sheikhupura → Lahore from the overview screen. */
  await page.goto('/inventory')
  await expect(page.getByText(sku).locator('visible=true').first()).toBeVisible()
  await page.getByRole('button', { name: 'Transfer stock' }).first().click()
  const transferDialog = page.getByRole('dialog', { name: 'Transfer between locations' })
  await transferDialog.getByLabel('Product').selectOption(productId)
  await transferDialog.getByLabel('From').selectOption({ label: 'Sheikhupura' })
  await transferDialog.getByLabel('To').selectOption({ label: 'Lahore' })
  await transferDialog.getByLabel('Quantity').fill('3')
  await transferDialog.getByRole('button', { name: 'Transfer stock' }).click()
  await expect(page.getByText('moved to Lahore. Purchases and sales were not touched')).toBeVisible()

  const finalSummary = await summaryFor(request, sku)
  expect(availableIn(finalSummary, 'sheikhupura')).toBe(6)
  expect(availableIn(finalSummary, 'lahore')).toBe(3)
  // 6 + 3 units at the post-purchase weighted average (900) = 9 × 900.
  expect(finalSummary.totalAvailable).toBe(9)

  /* 7. The movements ledger tells the whole story for this product. */
  await page.goto('/inventory/movements')
  await expect(
    page.locator('tr:visible, li:visible').filter({ hasText: productName }).first()
  ).toBeVisible()
  const movements = await request.get(`/api/stock/movements?productId=${productId}&limit=50`)
  expect(movements.ok()).toBeTruthy()
  const ledger = (await movements.json()) as Envelope<{
    items: Array<{ movementType: string; quantity: number; status: string }>
  }>
  const types = ledger.data.items.map((movement) => movement.movementType)
  // Creation reserves with `sale_out` movements (SPEC §5.5); a return that
  // restocks is `return_restock`; a transfer is ONE movement with two ends.
  for (const expectedType of ['purchase_in', 'sale_out', 'return_restock', 'transfer']) {
    expect(types, `ledger must contain ${expectedType}`).toContain(expectedType)
  }
  expect(ledger.data.items.every((movement) => movement.status === 'posted')).toBeTruthy()

  /* 8. No console errors or hydration warnings across the whole journey. */
  expect(consoleErrors).toEqual([])
})

test.describe('phase 5 guards (API level, run once)', () => {
  test('a Partner without permission cannot write inventory; idempotency keys replay', async ({
    playwright,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Global state; run once')

    const founder = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: FOUNDER_STATE,
    })
    const partner = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: AFNAN_STATE,
    })
    try {
      // Afnan (view-only) is refused on every Phase 5 write.
      const csrf = csrfFromState(AFNAN_STATE)
      const forbidden = await partner.post('/api/products', {
        headers: { [CSRF_HEADER]: csrf },
        data: {
          sku: `e2e-forbidden-${Date.now()}`,
          name: 'Forbidden',
          category: 'e2e-test',
          sellingPrice: 10000,
          cost: 5000,
          idempotencyKey: `forbidden-${Date.now()}`,
        },
      })
      expect(forbidden.status()).toBe(403)

      // Same idempotency key twice → exactly one product, replayed body.
      const key = `e2e-idem-${Date.now()}`
      const founderCsrf = csrfFromState(FOUNDER_STATE)
      const body = {
        sku: `e2e-idem-${Date.now()}`,
        name: 'Idempotency probe',
        category: 'e2e-test',
        sellingPrice: 10000,
        cost: 5000,
        idempotencyKey: key,
      }
      const first = await founder.post('/api/products', {
        headers: { [CSRF_HEADER]: founderCsrf },
        data: body,
      })
      expect(first.ok()).toBeTruthy()
      const second = await founder.post('/api/products', {
        headers: { [CSRF_HEADER]: founderCsrf },
        data: body,
      })
      expect(second.ok()).toBeTruthy()
      const firstId = ((await first.json()) as Envelope<{ _id: string }>).data._id
      const secondId = ((await second.json()) as Envelope<{ _id: string; replay?: boolean }>).data
      expect(secondId._id).toBe(firstId)
    } finally {
      await founder.dispose()
      await partner.dispose()
    }
  })
})

/** Reads the derived stock summary for one SKU straight from the API. */
async function summaryFor(
  request: import('@playwright/test').APIRequestContext,
  sku: string
): Promise<SummaryItem> {
  const response = await request.get('/api/stock/summary?includeArchived=true')
  expect(response.ok()).toBeTruthy()
  const summary = (await response.json()) as Envelope<{ items: SummaryItem[] }>
  const item = summary.data.items.find((entry) => entry.sku === sku)
  expect(item, `summary must contain ${sku}`).toBeTruthy()
  return item!
}

function availableIn(item: SummaryItem, location: string): number {
  return item.byLocation.find((entry) => entry.location === location)?.available ?? 0
}
