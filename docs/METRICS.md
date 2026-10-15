# METRICS.md — Decoricks Dashboard & Report Metric Dictionary

> Phase 8. This is the **single definition source** for every number that appears
> on the dashboard, the reports, the exports and the reconciliation panel.
>
> The rule for Phase 8 is absolute: **no metric is computed by a formula written
> for the dashboard.** Every figure below is produced by an **existing** Phase
> 1–7 calculation module. If a number cannot be traced to one of those engines
> and, from there, to the records that fed it, it does not get a widget.
>
> Formulas are reproduced here only to _document_ what the shared engine
> already does; they cite SPEC §5 and name the function that computes them.
> Where this file and SPEC §5 ever disagree, SPEC §5 wins and this file is wrong.

---

## 0. Global rules that apply to every metric

### 0.1 Money

- All money is **integer paisa** end to end. 1 PKR = 100 paisa. Storage,
  arithmetic and the engines never use floats for money.
- Formatting to `PKR n.nn` happens **only at the edge** via
  `formatPaisa(paisa)` (`src/lib/money.ts`). No metric ever returns a
  pre-rounded PKR float that is later re-summed.
- Averages and percentages are computed from paisa, then rounded **once** for
  display (`Math.round` / `toFixed` at the presentation boundary). The engine
  value stays paisa. See §G for the "no lost paisa" rounding contract.

### 0.2 Time — Asia/Karachi in reporting, UTC in storage

- Documents store **UTC** instants. Reporting buckets on **Asia/Karachi civil
  calendar** (UTC+5, no DST).
- The canonical boundary helpers are in `src/lib/finance.ts` and are the ONLY
  ones Phase 8 may use:
  - `karachiCivil(date)` → the Karachi civil date a UTC instant falls on.
  - `karachiMidnight(y, m, d)` → the **UTC instant** of a Karachi civil midnight
    (`Date.UTC(y, m-1, d) − 5h`).
  - `karachiDayRange` / `karachiWeekRange` (Monday-based) / `karachiMonthRange` →
    inclusive `{ start, end }` where `end` is `start + 24h/7d/month − 1ms`.
  - `karachiDateInputRange('YYYY-MM-DD')` → parses a UI date as a Karachi day.
  - `isWithin(date, range)` and `karachiDayCount(range)` (inclusive day count,
    used by the averages divisor).
- **Do NOT** use the `src/lib/date.ts` helpers (`getStartOfWeek` etc.) for
  reporting ranges: they build `Date` objects in the **server's local zone**, so
  their boundaries are only correct when the host clock is itself Karachi. The
  `finance.ts` helpers are host-timezone-independent and are what the P&L,
  cash-flow and distribution engines already use. Reusing them is what makes
  `dashboard = reports = ledger` possible.
- **Period selector mapping** (the brief's "today / this week / this month /
  custom") is already implemented by `resolveReportRange(searchParams)`
  (`src/lib/cash-flow.ts`), which returns `{ period: ReportPeriod, range }`:
  - `today` → `period=day` → `karachiDayRange(now)`
  - `this week` → `period=week` → `karachiWeekRange(now)` (Mon 00:00 → Sun 23:59:59.999)
  - `this month` → `period=month` → `karachiMonthRange(now)` (1st 00:00 → last day 23:59:59.999)
  - `custom` → `period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD` → inclusive
    `[karachiMidnight(from) , karachiEndOfDay(to)]`; invalid or inverted ranges
    resolve to `null` and the API returns **400**, never a silently-clipped range.

### 0.3 Single source of money truth — the unified ledger

- Since Phase 3 the authoritative record of money movement is the **`transactions`
  collection** (the append-only ledger), read through `fetchLedgerRange(db, range)`
  (`src/lib/distribution-service.ts`) / `listLedger` + `buildLedgerFilter`
  (`src/lib/finance-ledger.ts`) and normalized by `normalizeEntry`.
- Reversals are **append-only counter-entries**; `transactionEffect(entry)`
  (`src/lib/finance.ts`) carries the signed effect so a reversed entry cancels
  its original. Every P&L / cash figure is therefore a ledger sum and needs no
  special "ignore reversed" logic.
- **Legacy collections** (`income`, `expenses`) are NOT read by Phase 8 metrics.
  The pre-Phase-3 `/api/dashboard/summary` route reads them and is superseded
  (see §I).

### 0.4 Accounting profit vs cash flow — never confused

These are two different questions and are always shown under separate headings,
never merged into one "profit" number:

- **Accounting (accrual-of-record) profit** — `computeProfitLoss`
  (`src/lib/profit-loss.ts`), SPEC §5.1–§5.5: net sales, COGS, gross profit, net
  profit. Answers "did the period make money".
- **Cash flow** — `computeCashFlow` (`src/lib/cash-flow.ts`): cash in / cash out /
  per-account balances. Answers "where did actual cash go". Capital in and
  partner withdrawals are **cash events with no P&L effect**; transfers move cash
  between accounts and are **neutral** to the total position.
- `summarize(entries).netProfit` (`src/lib/finance.ts`) is a _cash-basis_ operating
  figure (`revenue − expense`). It is deliberately **not** labeled "net profit" on
  any Phase 8 widget; the widget label for that number is "operating cash result"
  and the §5.5 "Net Profit" figure always comes from `computeProfitLoss`.

### 0.5 Empty states are honest

- A period with no activity renders a truthful `0` / `PKR 0.00` / an empty list,
  never a placeholder, never a carried-forward value, never an average of a
  missing denominator. Ratios with a zero denominator resolve to a defined,
  documented value (usually `0` or `null`) rather than `NaN`/`Infinity` — see the
  per-metric notes.
- No business data is ever seeded to make a chart "look alive".

---

## A. Sales & profit metrics

Unless stated, all are computed for the selected `range` from
`ledger = fetchLedgerRange(db, range)` and
`pl = computeProfitLoss(ledger, { cogs })`.

### A.1 Total sales (revenue)

- **Definition:** the value billed on orders that were actually delivered — i.e.
  the income recognized in the ledger over the period.
- **Formula:** `Σ income entries in range` — SPEC §5.1 "Revenue".
- **Engine:** `pl.revenue` (`computeProfitLoss`), which sums
  `transactionEffect(entry).revenue` over `type === 'income'` ledger entries.
- **Inputs:** `transactions` (type `income`). For COD orders the income entry is
  posted once cash is confirmed received (`order.codCashReceivedAt`,
  `order.incomeTransactionId`), so revenue reflects **collected** sales.
- **Boundary:** ledger `date ∈ range`.
- **Permission:** `finance.view` **and** `sales.view`
  (`authorizeAllViews(['finance','sales', …])`).
- **Traceability / click-through:** the exact income entries in range →
  `/api/finance` filtered `type=income`, `from`, `to`.
- **SPEC §5.1 wording — RESOLVED (Checkpoint 1, founder-approved):** SPEC §5.1
  literally reads "Revenue = Sum of all order totals for the period." The
  **authoritative, reconciled** source is the **ledger income** (for COD, posted
  only when cash is confirmed received), because that is the single number every
  downstream figure (§5.2 net sales, §5.4 gross, §5.5 net), the cash flow, the
  distribution engine and the reconciliation panel already agree on. Order
  `total` (merchandise value, booked at order creation) is reported **separately**
  as **A.2 Gross order value**, never blended into revenue or net sales. SPEC §5.1
  has been annotated to state this recognition rule so the two documents agree;
  the §5.1 worked example (order totals summing to the period's billed value) is
  unchanged and still holds for fully-collected periods.

### A.2 Gross order value (merchandise, non-reconciling)

- **Definition:** sum of `order.total` for non-cancelled orders **created** in the
  period. A volume indicator only; it is not ledger money and is not used in any
  profit figure.
- **Engine:** order aggregation `Σ total` where `orderStatus ≠ 'cancelled'` and
  `createdAt ∈ range` (mirrors the existing `salesSummary.revenue` aggregation in
  `/api/reports/period`).
- **Label requirement:** must be visibly captioned "order value (booked, not
  collected)" and placed apart from A.1 so it is never read as revenue.
- **Permission:** `sales.view`.
- **Traceability:** `/api/orders` filtered to the period.

### A.3 Net sales

- **Definition:** revenue less refunds.
- **Formula:** `Net Sales = Revenue − Returns − Refunds` — SPEC §5.2. In the
  ledger model refunds/return costs are expense entries in category
  `refunds_return_costs`, so the engine computes `netSales = revenue − refunds`.
- **Engine:** `pl.netSales`.
- **Inputs:** `transactions` income + `refunds_return_costs` expenses.
- **Permission:** `finance.view` + `sales.view`.
- **Traceability:** income and refund entries → finance ledger filtered by
  `type`/`category` within range.

### A.4 COGS

- **Definition:** weighted-average cost of the units actually sold in the period.
- **Formula:** `Σ (sold quantity × weighted-average cost at time of sale)` — SPEC §5.3.
- **Engine:** `periodCogsInput(db, range)` (`src/lib/cogs-service.ts`) returns a
  `CogsInput { amount, provisional, source }`; passed into `computeProfitLoss` as
  `{ cogs }`. `pl.cogs` exposes the resolved amount.
- **Provisional flag:** when no inventory movements exist yet, COGS falls back to
  ledger `product_purchasing` and `pl.cogsProvisional === true`. The widget MUST
  show a "provisional — no movement data yet" marker sourced from
  `pl.cogsSource`. Never present a provisional COGS as final.
- **Permission:** `finance.view` + `inventory.view` + `sales.view`.
- **Traceability:** the `sale_out` stock movements in range (product, qty, WAC).

### A.5 Gross profit

- **Definition:** net sales less COGS.
- **Formula:** `Gross Profit = Net Sales − COGS` — SPEC §5.4.
- **Engine:** `pl.grossProfit`.
- **Permission:** `finance.view` + `sales.view` (+ `inventory.view` because COGS
  feeds it).
- **Traceability:** click-through opens the P&L report for the period, which
  itemizes revenue, refunds, COGS, gross.

### A.6 Expenses

- **Definition:** operating expenses for the period — every expense category
  **except** `refunds_return_costs` and `product_purchasing` (those are in the
  net-sales / COGS chains and must not be double-counted).
- **Formula:** `Σ operating expense entries in range` — SPEC §5.5 (Operating Expenses).
- **Engine:** `pl.operatingExpenses` (with `pl.operatingLines` per category).
- **Permission:** `finance.view`.
- **Traceability:** `/api/finance` filtered `type=expense`, excluding the two
  reserved categories, within range.

### A.7 Advertising spend

- **Definition:** the subset of operating expenses belonging to advertising /
  marketing categories.
- **Formula:** `Σ expense entries whose category ∈ advertisingCategories`.
- **Sources resolution (no invented categories):** advertising categories are a
  Founder-configurable set stored on the `businessSettings` singleton as
  `advertisingCategories: string[]` (category slugs, e.g. `meta_ads`,
  `flyers_printing`, `content_production`). It is resolved through
  `resolveBusinessPolicy` (`src/lib/business-policy.ts`) exactly like
  `budgetThresholds`, with the SPEC-adjacent marketing slugs as the unconfigured
  default and `configured` telling the UI whether a real decision was made. The
  **metric itself never hardcodes the list** — it reads the resolved set and the
  "Show calculation" panel prints the exact member categories used, so the
  classification is visible and auditable. Advertising spend is the sum of the
  operating-expense ledger effects whose `category` is in that resolved set, so it
  is a strict subset of A.6 and can never exceed total expenses.
- **Engine:** derived from the same `ledger` slice used by `computeProfitLoss`
  (reuses `transactionEffect(entry).expense`); no new money arithmetic.
- **Permission:** `finance.view`.
- **Traceability:** finance ledger filtered to those categories in range.

### A.8 Net profit

- **Definition:** gross profit less operating expenses.
- **Formula:** `Net Profit = Gross Profit − Operating Expenses` — SPEC §5.5.
- **Engine:** `pl.netProfit`.
- **Permission:** `finance.view` + `sales.view`.
- **Traceability:** P&L report for the period.

---

## B. Cash metrics (shown separately from profit)

### B.1 Cash balance by account (current)

- **Definition:** the real-time cash position per account (cash / bank / wallet),
  built only from manually recorded ledger movements (no bank feed — that is
  out of scope per SPEC §1.2).
- **Formula:** `balance(account) = openingBalance + Σ accountDeltas over all
entries ≤ now` — SPEC §5.6.
- **Engine:** `getAccountBalances(db)` (`src/lib/finance-ledger.ts`) → per-account
  balances from `computeAccountBalances(accounts, entries)` (`src/lib/finance.ts`).
- **Inputs:** `accounts` + `transactions`.
- **Boundary:** "current" = the whole ledger history up to now, **not** the period
  filter (a balance is a point-in-time stock, not a flow). Label it "as of
  <Karachi datetime>".
- **Permission:** `finance.view`.
- **Traceability:** per-account ledger entries → `/api/finance` filtered
  `accountId`.

### B.2 Cash flow for the period

- **Definition:** cash in / cash out across the selected range, split into revenue
  receipts, capital in, operating out, withdrawals out, and per-account deltas.
- **Formula:** SPEC §5.6 (inflows/outflows; transfers neutral).
- **Engine:** `computeCashFlow(accounts, entriesBefore, entriesInRange)` — it needs
  `entriesBefore` (opening positions) and `entriesInRange` (flows) from the same
  full ledger read.
- **Key behaviors the engine guarantees:** `transfer` entries are counted
  (`transferCount`) but excluded from inflow/outflow; `partner_capital` is cash in,
  `partner_withdrawal` is cash out; `totalBalanceEnd = totalBalanceStart + cashIn −
cashOut`.
- **Permission:** `finance.view`.
- **Traceability:** the entries in range, per bucket.

---

## C. Inventory metrics

### C.1 Inventory value (total and by location)

- **Definition:** current sellable stock valued at weighted-average cost.
- **Formula:** `Inventory Value = Σ (current quantity × weighted-average cost)`
  per product, summed — SPEC §5.7.
- **Engine:** `buildStockSummary(db)` (`src/lib/stock-summary.ts`) →
  `totals.totalValuation` and `totals.byLocation` (per `sheikhupura` / `lahore`).
  It derives stock from the movement ledger via `deriveStock` + `weightedAverageCost`
  - `valuationLine` (`src/lib/stock-math.ts`).
- **Do NOT** value at `product.cost × quantity` (that is the superseded
  Phase-1 approach and will not reconcile with COGS/movements). The single
  valuation source is `buildStockSummary`.
- **Boundary:** point-in-time (all movements ≤ now); not period-filtered.
- **Permission:** `inventory.view`.
- **Traceability:** the stock movements feeding a location/product →
  `/api/stock` / inventory movements screen, drillable by `productId`
  (`buildStockSummary(db, { productId })`).

### C.2 Low-stock products

- **Definition:** active products whose **combined** sellable units across both
  locations are at or below the product's own `reorderLevel`.
- **Formula:** `lowStock(product) = reorderLevel > 0 AND Σ available across
locations ≤ reorderLevel`. Reorder level is a whole-business purchasing
  threshold, not per-warehouse, so it is compared to the combined figure, and only
  against a level the user actually set (a null/0 reorder level never flags).
- **Engine:** `buildStockSummary(db).items` / `totals.lowStockCount` (the
  `isLowStock` rule lives in `stock-summary.ts` and is reused as-is).
- **Permission:** `inventory.view`.
- **Traceability:** each low item links to its product + movements.

---

## D. Order-status metrics

All over `orders` (+ `returns`) with `createdAt ∈ range`, via aggregation pipelines
(never loading the collection).

### D.1 Orders by status

- **Definition:** counts by `orderStatus ∈ { pending, processing, shipped,
delivered, returned, cancelled }`.
- **Engine:** `db.collection('orders').aggregate([ $match createdAt range,
$group by orderStatus ])`. Indexes: `orderStatus_1_createdAt_-1` (exists).
- **Permission:** `sales.view`.

### D.2 Cancellations

- **Definition:** `orderStatus = 'cancelled'` count. Cancelled orders are excluded
  from revenue (A.1/A.2) — restorals are posted for any reserved stock.
- **Permission:** `sales.view`.

### D.3 Returns

- **Definition:** `ReturnRecord`s created in range (`returns` collection);
  per-item outcome `restock | damaged | writeoff`.
- **Engine:** `getReturnCollection(db)` aggregation by `createdAt` in range.
- **Permission:** `sales.view`.

### D.4 Refunds

- **Definition:** total `ReturnRecord.refundAmount` in range, and the count of
  orders with a refund ledger entry (`order.refundTransactionId`). The **money**
  effect that feeds net sales is the `refunds_return_costs` expense (A.3); this
  metric reports the return/refund activity itself. Reconcile: `Σ refunds_return_costs`
  (A.3) equals the refund ledger postings these records produced.
- **Permission:** `sales.view` + `finance.view`.

---

## E. Budget vs actual

- **Definition:** for the active budget whose period overlaps the selection, the
  budgeted amount, actual spend and variance per expense category.
- **Formula:** per category `variance = budgeted − actual`; `percentUsed =
actual / budgeted` (clamped to 100 for display when `budgeted ≤ 0` and `actual >
0`; `0` when both zero — see `percentOf`). Warning level from thresholds
  (`warning`, `critical`) in `SPEC_DEFAULT_BUDGET_THRESHOLDS` / business settings.
- **Engine:** `computeBudgetActuals(budget, ledger, thresholds)`
  (`src/lib/budget-actuals.ts`) — `actual` per category is summed from the SAME
  `transactionEffect(entry).expense` used by the P&L, over `budgetPeriodRange`
  (inclusive Karachi days). `budget-queries.ts:loadBudgetThresholds /
fetchLedgerExpenses` supply the inputs.
- **Reconciliation guarantee:** `computeBudgetActuals.totalActual` for a category
  equals that category's operating-expense line in A.6, because both read the same
  ledger effects. This is asserted in the reconciliation panel (§H).
- **Permission:** `budget.view`.
- **Traceability:** `BudgetActuals.sourceEntries` are carried for the "Show
  calculation" drill-down.

---

## F. Team task progress (Phase 6 board model)

Over the selected range, using the board model (`completedAt` when a card enters a
done column; overdue = `dueDate` past and card not in a done column). Reuses the
exact queries already in `/api/reports/period`.

### F.1 Tasks completed in period

- **Definition:** tasks with `completedAt ∈ range` and not archived.
- **Engine:** `getTaskDocCollection(db)` match `completedAt ∈ range, isArchived:
false`; grouped by `assigneeIds` (unwound).

### F.2 Overdue

- **Definition:** `dueDate < now`, `dueDate ≠ null`, `isArchived: false`, and
  `columnId ∉ doneColumnIds` (done columns from `getColumnCollection`). Per-member
  counts.
- **Note:** penalties remain a manual Founder action (SPEC §2.2); the dashboard is
  informational only.
- **Permission:** `tasks.view`.
- **Traceability:** click-through to the tasks board filtered `Overdue` / by assignee.

---

## G. Averages (daily / weekly / monthly)

- **Definition:** the selected period's activity expressed as a per-day, per-week
  and per-month average, so a 3-day and a 30-day window are comparable.
- **Engine:** `computeAverages(ledger, range)` (`src/lib/finance.ts`), which:
  - `days = max(1, karachiDayCount(range))`
  - `perDay = round(netCashFlow / days)`
  - `perWeek = round((netCashFlow / days) × 7)`
  - `perMonth = round((netCashFlow / days) × 30)`
  - `perEntry = count>0 ? round((revenue+expense)/count) : 0`
- **Zero-activity days:** the divisor is **calendar days in the range**, not days
  with entries, so quiet days correctly pull the average down (a truthful daily
  rate), and an empty period yields `0`, never a divide-by-zero.
- **Rounding / no lost paisa:** each averaged paisa figure is rounded **once**,
  independently. `perWeek`/`perMonth` are derived from the unrounded daily rate ×
  the 7/30 convention, so rounding a week is not the sum of seven independently-
  rounded days. The rounding contract is documented in the panel and tested; the
  widget shows the paisa value, and the "Show calculation" panel prints the exact
  `netCashFlow`, `days` and the formula.
- **Profit averages:** where the dashboard shows a "daily net profit" average, it
  is `pl.netProfit / karachiDayCount(range)` rounded once — the numerator is the
  engine's net profit (A.8), never re-derived.
- **Permission:** inherits the underlying metric (finance/sales view).

---

## H. Founder-only metrics & reconciliation

### H.1 Profit distribution (Founder only)

- **Definition:** monthly net-profit split into partner shares, charity, retained
  earnings, reinvestment and adjustments.
- **Engine:** `buildDistribution(db, month)` + `computeDistribution`
  (`src/lib/distribution-service.ts`, `src/lib/distribution-math.ts`). Shares use
  `largestRemainderSplit` / `allocateExactly` so the paisa split is exact and sums
  back to the whole (no lost/created paisa).
- **Retained earnings:** `Cumulative Net Profit − Cumulative Distributions −
Cumulative Withdrawals` — SPEC §5.9. Reinvestment — SPEC §5.8.
- **Boundary:** distributions are **Karachi-month** scoped
  (`karachiMonthRangeForMonth` / `karachiMonthKey`).
- **Permission:** **`requireFounder()`** — Partners do NOT see distribution detail
  by default (brief §8). Server-side, not just hidden.

### H.2 Reconciliation panel (Founder only)

Runs these equalities and shows **pass/fail with the exact difference** — a
mismatch is never hidden or auto-corrected:

1. **Dashboard = reports = ledger.** The P&L/cash figures the dashboard renders are
   the ones `/api/reports/*` returns, and both are the same `computeProfitLoss` /
   `computeCashFlow` calls over `fetchLedgerRange`. Checks:
   `dashboard.revenue == report.revenue == Σ ledger income effects`, same for
   expenses, net profit, cash in/out. (This is why the Phase-1 legacy
   `/api/dashboard/summary` must be superseded — §I.)
2. **Inventory valuation = stock movements.** `buildStockSummary().totalValuation`
   recomputed independently from `deriveStock(movements)` × `weightedAverageCost`
   equals the reported total; and equals the COGS source's movement ledger.
3. **Account balances = ledger.** `Σ getAccountBalances().balance == opening
balances + Σ all accountDeltas` from the full ledger.
4. **Budget actual = ledger expenses.** `computeBudgetActuals.totalActual` equals
   the matching operating-expense slice of the ledger for the same range.

- Each check reports: value A, value B, difference (paisa), pass/fail. Non-zero
  difference → visible FAIL.
- **Permission:** `requireFounder()`.

---

## I. Superseding the Phase-1 dashboard route (RESOLVED — founder-approved)

`/api/dashboard/summary` currently reads legacy `income`/`expenses`/`tasks`
collections, uses server-local day math, and values stock at
`quantity × product.cost`. Those numbers **cannot reconcile** with the §5 engines
(`/api/reports/period`, cash flow, WAC valuation) that reports, exports and the
reconciliation panel use. Phase 8 therefore builds the dashboard on a new
**`/api/dashboard`** endpoint that composes the **existing engines** over
`fetchLedgerRange` + `buildStockSummary` + `computeBudgetActuals` + the Phase-6
task queries — the identical calls the reports and reconciliation make. The legacy
route is left in place (not silently deleted) but the dashboard stops using it, so
"one number, one source" holds. **Approved at Checkpoint 1.**

---

## J. Metric → engine → records index (traceability summary)

| Metric                                    | Engine (reused)                               | Primary records                          | Permission gate         |
| ----------------------------------------- | --------------------------------------------- | ---------------------------------------- | ----------------------- |
| Revenue / net sales / gross / net profit  | `computeProfitLoss`                           | `transactions` (income, refund expenses) | finance+sales view      |
| Gross order value (booked)                | orders aggregate                              | `orders`                                 | sales view              |
| COGS                                      | `periodCogsInput` → `computeProfitLoss`       | stock movements (`sale_out`)             | finance+inventory+sales |
| Expenses                                  | `computeProfitLoss.operatingLines`            | `transactions` (expense)                 | finance view            |
| Advertising spend                         | slice of same ledger effects                  | `transactions` (advertising cats)        | finance view            |
| Cash balance by account                   | `getAccountBalances`/`computeAccountBalances` | `accounts`+`transactions`                | finance view            |
| Cash flow period                          | `computeCashFlow`                             | `transactions`                           | finance view            |
| Inventory value (total/by loc)            | `buildStockSummary`                           | movements+products                       | inventory view          |
| Low stock                                 | `buildStockSummary`                           | movements+products(reorderLevel)         | inventory view          |
| Orders by status / cancellations          | orders aggregate                              | `orders`                                 | sales view              |
| Returns / refunds                         | returns aggregate                             | `returns`                                | sales(+finance) view    |
| Budget vs actual                          | `computeBudgetActuals`                        | budget+`transactions`                    | budget view             |
| Tasks completed / overdue                 | board queries (reports/period)                | `tasks`,`columns`                        | tasks view              |
| Daily/weekly/monthly averages             | `computeAverages`                             | `transactions`                           | underlying metric       |
| Profit distribution / retained / reinvest | `buildDistribution`/`computeDistribution`     | ledger+settings                          | **Founder**             |
| Reconciliation                            | recompute+compare the above                   | all                                      | **Founder**             |

---

## K. Charts (definitions only; build at Checkpoint 2)

- **Sales vs expenses trend:** per Karachi day (or week/month for long ranges)
  `revenue` and `operating expenses` from the ledger — same slices as A.1/A.6.
- **Profit trend:** `monthlyProfitSeries(ledger, monthRanges, cogsPerMonth)`
  (`src/lib/profit-loss.ts`) — reuses the existing monthly P&L series.
- **Budget vs actual:** from §E category lines.
- **Expense breakdown by category:** `pl.operatingLines` (largest first).
- **Stock value by location:** `buildStockSummary().totals.byLocation`.
- Every chart has an accessible text summary, labeled axes, patterns/labels (not
  colour alone), brand colours, no 3D, and resizes without layout shift.

---

## L. Exports (definitions only; build at Checkpoint 3)

- CSV via `toCsv(rows, columns)` (`src/lib/finance.ts`).
- PDF via a free/open-source generator (chosen at build; no paid service).
- Both stamp the **generated-at** time and the **Karachi period** in the file,
  format PKR from paisa via `formatPaisa`, and the endpoints are
  **permission-checked (`authorizeAllViews` for the underlying views; Founder for
  distribution) and audit-logged** (`recordAuditEntry`) like every mutation.
- A user cannot export a figure they cannot view server-side.

---

_This file is the Checkpoint 1 contract. Both decisions it used to defer
(§A.1 revenue basis and §I legacy-route supersession) are now **resolved and
founder-approved**; the API layer is built on the definitions above with no
further open confirmations._
