import { describe, it, expect } from 'vitest'
import {
  buildReportRows,
  reportToCsv,
  reportToPdf,
} from '@/lib/reports/render'
import type { PeriodReport } from '@/lib/reports/period-report'

/**
 * The renderers never recompute a number — they carry the report's own
 * `formatPaisa` display strings straight through, so the downloaded file can
 * never disagree with the screen (METRICS §H.2). These tests pin that, plus the
 * CSV escaping and the WinAnsi-safe PDF path.
 */

const base: PeriodReport = {
  period: 'week',
  rangeStart: '2026-10-12T00:00:00.000Z',
  rangeEnd: '2026-10-18T23:59:59.999Z',
  salesSummary: {
    orders: 3,
    revenue: 125000,
    revenueDisplay: 'PKR 1250.00',
    codDelivered: 2,
    codReturned: 1,
    codRefused: 0,
    deliveryRate: 66.7,
  },
  expensesSummary: {
    total: 30000,
    totalDisplay: 'PKR 300.00',
    byCategory: [
      { category: 'rent, office', amount: 20000, amountDisplay: 'PKR 200.00' },
      { category: 'meta_ads', amount: 10000, amountDisplay: 'PKR 100.00' },
    ],
  },
  profitSummary: {
    gross: 95000,
    grossDisplay: 'PKR 950.00',
    net: 65000,
    netDisplay: 'PKR 650.00',
    cogs: 0,
    cogsDisplay: 'PKR 0.00',
    cogsProvisional: true,
    netSales: 125000,
    netSalesDisplay: 'PKR 1250.00',
    refunds: 0,
    refundsDisplay: 'PKR 0.00',
    operatingExpenses: 30000,
    operatingExpensesDisplay: 'PKR 300.00',
  },
  stockSummary: {
    totalValue: 500000,
    totalValueDisplay: 'PKR 5000.00',
    lowStockItems: [{ id: 'p1', name: 'Cushion Cover', quantity: 2 }],
  },
  tasksCompleted: { count: 4, byAssignee: [{ name: 'Ayesha', count: 4 }] },
  overdueByMember: [{ name: 'Bilal', count: 1 }],
  recentOrders: [
    {
      date: '2026-10-13T09:00:00.000Z',
      orderNumber: 'ORD-1001',
      customerName: 'Ali “Traders”',
      total: 75000,
      totalDisplay: 'PKR 750.00',
      orderStatus: 'delivered',
    },
  ],
  recentExpenses: [
    {
      date: '2026-10-13T09:00:00.000Z',
      category: 'meta_ads',
      amount: 10000,
      amountDisplay: 'PKR 100.00',
      description: 'October boost',
    },
  ],
}

const meta = { generatedAt: new Date('2026-10-18T18:30:00.000Z') }

describe('reports/render', () => {
  it('carries the report’s own display strings through without recomputation', () => {
    const rows = buildReportRows(base, meta)
    const revenue = rows.find((r) => r.section === 'Sales' && r.item === 'Revenue')
    expect(revenue?.value).toBe(base.salesSummary.revenueDisplay)
    const net = rows.find((r) => r.section === 'Profit & Loss' && r.item === 'Net profit')
    expect(net?.value).toBe(base.profitSummary.netDisplay)
  })

  it('flattens per-category and per-order lines', () => {
    const rows = buildReportRows(base, meta)
    expect(rows.some((r) => r.section === 'Expenses by category' && r.item === 'meta_ads')).toBe(true)
    expect(rows.some((r) => r.section === 'Low stock' && r.value === '2 units')).toBe(true)
    expect(rows.some((r) => r.section === 'Recent orders' && r.item.includes('ORD-1001'))).toBe(true)
  })

  it('escapes a comma-bearing value in the CSV', () => {
    const csv = reportToCsv(base, meta)
    expect(csv.split('\r\n')[0]).toBe('Section,Item,Value')
    // The category "rent, office" must be quoted so the comma is not a delimiter.
    expect(csv).toContain('"rent, office"')
  })

  it('produces real PDF bytes and survives non-ASCII names', async () => {
    // The customer name carries curly quotes; the WinAnsi-safe path must strip
    // them rather than throw at draw time.
    const bytes = await reportToPdf(base, meta)
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF')
    expect(bytes.length).toBeGreaterThan(500)
  })
})
