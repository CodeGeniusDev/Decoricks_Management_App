import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { toCsv } from '@/lib/finance'
import { formatKarachiDate } from '@/lib/date'
import type { PeriodReport } from './period-report'

/**
 * Report renderers for `/api/reports/export`.
 *
 * Both the CSV and the PDF are built from the SAME `PeriodReport` object the
 * on-screen summary already renders, and every money string is taken from the
 * report's own `…Display` fields (already `formatPaisa`-ed, no thousands
 * separators). There is deliberately no arithmetic here — "export what I'm
 * looking at" with zero formula duplication (METRICS §H.2, §L).
 *
 * A user can never export a figure they could not view: the route only calls
 * these after `authorizeAllViews` has let the whole aggregation run.
 */

export interface ReportMeta {
  /** Wall-clock moment the file was generated; stamped in Asia/Karachi. */
  generatedAt: Date
}

/** One flattened line of the report, shared by both the CSV and the PDF. */
export interface ReportRow {
  section: string
  item: string
  value: string
}

const periodLabel = (report: PeriodReport): string =>
  `${formatKarachiDate(new Date(report.rangeStart))} – ${formatKarachiDate(
    new Date(report.rangeEnd)
  )}`

/**
 * Flatten the nested report into Section / Item / Value rows. Keeping a single
 * schema means the CSV and the PDF are literally the same table, so neither can
 * drift from the other or from the screen.
 */
export function buildReportRows(report: PeriodReport, meta: ReportMeta): ReportRow[] {
  const rows: ReportRow[] = []
  const add = (section: string, item: string, value: string) => rows.push({ section, item, value })

  add('Summary', 'Period', report.period === 'month' ? 'Monthly' : 'Weekly')
  add('Summary', 'Range (Karachi)', periodLabel(report))
  add('Summary', 'Generated at (Karachi)', formatKarachiDate(meta.generatedAt, 'datetime'))

  const { salesSummary, profitSummary, expensesSummary, stockSummary, tasksCompleted } = report
  add('Sales', 'Orders', String(salesSummary.orders))
  add('Sales', 'Revenue', salesSummary.revenueDisplay)
  add('Sales', 'COD delivered', String(salesSummary.codDelivered))
  add('Sales', 'COD returned', String(salesSummary.codReturned))
  add('Sales', 'COD refused', String(salesSummary.codRefused))
  add('Sales', 'Delivery rate', `${salesSummary.deliveryRate}%`)

  add('Profit & Loss', 'Net sales', profitSummary.netSalesDisplay)
  add('Profit & Loss', 'COGS', profitSummary.cogsDisplay)
  add('Profit & Loss', 'COGS provisional?', profitSummary.cogsProvisional ? 'Yes' : 'No')
  add('Profit & Loss', 'Gross profit', profitSummary.grossDisplay)
  add('Profit & Loss', 'Operating expenses', profitSummary.operatingExpensesDisplay)
  add('Profit & Loss', 'Refunds', profitSummary.refundsDisplay)
  add('Profit & Loss', 'Net profit', profitSummary.netDisplay)

  add('Expenses', 'Total expenses', expensesSummary.totalDisplay)
  for (const line of expensesSummary.byCategory) {
    add('Expenses by category', line.category, line.amountDisplay)
  }

  add('Inventory', 'Total stock value', stockSummary.totalValueDisplay)
  for (const item of stockSummary.lowStockItems) {
    add('Low stock', item.name, `${item.quantity} units`)
  }

  add('Tasks', 'Completed in period', String(tasksCompleted.count))
  for (const a of tasksCompleted.byAssignee) {
    add('Tasks by member', a.name, String(a.count))
  }
  for (const o of report.overdueByMember) {
    add('Overdue tasks', o.name, String(o.count))
  }

  for (const order of report.recentOrders) {
    add(
      'Recent orders',
      `${order.orderNumber} — ${order.customerName}`,
      `${order.totalDisplay} (${order.orderStatus})`
    )
  }
  for (const exp of report.recentExpenses) {
    add(
      'Recent expenses',
      `${formatKarachiDate(new Date(exp.date))} — ${exp.category}`,
      exp.amountDisplay
    )
  }

  return rows
}

const csvColumns = [
  { key: 'section', label: 'Section', value: (r: ReportRow) => r.section },
  { key: 'item', label: 'Item', value: (r: ReportRow) => r.item },
  { key: 'value', label: 'Value', value: (r: ReportRow) => r.value },
]

export function reportToCsv(report: PeriodReport, meta: ReportMeta): string {
  return toCsv<ReportRow>(buildReportRows(report, meta), csvColumns)
}

/**
 * pdf-lib embeds the WinAnsi standard fonts; a codepoint outside WinAnsi (an
 * em dash is fine, but arbitrary Unicode is not) would throw at draw time. Keep
 * the payload ASCII-safe so a stray product or customer name can never fail a
 * download the user was entitled to.
 */
const winAnsiSafe = (text: string): string =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–/g, '-')
    .replace(/—/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E]/g, '')

const BLACK = rgb(0.1, 0.1, 0.1)
const MUTED = rgb(0.4, 0.4, 0.4)
const RULE = rgb(0.8, 0.8, 0.8)

// A4 portrait.
const PAGE_W = 595.28
const PAGE_H = 841.89
const MARGIN = 42
const COL_SECTION = 118
const COL_ITEM = 250
// Remaining width belongs to the value column.
const COL_VALUE = PAGE_W - MARGIN * 2 - COL_SECTION - COL_ITEM

export async function reportToPdf(report: PeriodReport, meta: ReportMeta): Promise<Uint8Array> {
  const rows = buildReportRows(report, meta)
  const pdf = await PDFDocument.create()
  pdf.setTitle('Decoricks Period Report')
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  let page = pdf.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN

  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H])
    y = PAGE_H - MARGIN
  }
  const ensure = (needed: number) => {
    if (y - needed < MARGIN) newPage()
  }

  // Header block (first page only).
  page.drawText(winAnsiSafe('Decoricks — Period Report'), {
    x: MARGIN,
    y,
    size: 18,
    font: bold,
    color: BLACK,
  })
  y -= 22
  const subtitles = [
    `${report.period === 'month' ? 'Monthly' : 'Weekly'} · ${periodLabel(report)}`,
    `Generated ${formatKarachiDate(meta.generatedAt, 'datetime')} (Karachi)`,
  ]
  for (const line of subtitles) {
    page.drawText(winAnsiSafe(line), { x: MARGIN, y, size: 10, font, color: MUTED })
    y -= 14
  }
  y -= 8

  const drawHeaderRow = () => {
    ensure(40)
    page.drawText('Section', { x: MARGIN, y, size: 10, font: bold, color: BLACK })
    page.drawText('Item', { x: MARGIN + COL_SECTION, y, size: 10, font: bold, color: BLACK })
    page.drawText('Value', { x: MARGIN + COL_SECTION + COL_ITEM, y, size: 10, font: bold, color: BLACK })
    y -= 6
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 1,
      color: RULE,
    })
    y -= 14
  }
  drawHeaderRow()

  const clip = (text: string, width: number, size: number): string => {
    let s = winAnsiSafe(text)
    if (font.widthOfTextAtSize(s, size) <= width) return s
    while (s.length > 1 && font.widthOfTextAtSize(`${s}...`, size) > width) s = s.slice(0, -1)
    return `${s}...`
  }

  let lastSection = ''
  for (const row of rows) {
    ensure(18)
    const size = 9
    const showSection = row.section !== lastSection
    if (showSection) {
      page.drawText(clip(row.section, COL_SECTION - 6, size), {
        x: MARGIN,
        y,
        size,
        font: bold,
        color: MUTED,
      })
      lastSection = row.section
    }
    page.drawText(clip(row.item, COL_ITEM - 8, size), {
      x: MARGIN + COL_SECTION,
      y,
      size,
      font,
      color: BLACK,
    })
    page.drawText(clip(row.value, COL_VALUE - 8, size), {
      x: MARGIN + COL_SECTION + COL_ITEM,
      y,
      size,
      font,
      color: BLACK,
    })
    y -= 16
  }

  return pdf.save()
}
