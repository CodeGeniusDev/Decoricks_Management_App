# Launch Checklist — First Two Weeks of Parallel Use

For the first **two weeks** the app runs **alongside** the old records
(spreadsheet / notebook). Do **not** switch over yet. The goal is to prove the
app's numbers agree with the old records, then retire the old ones. Keep this
file (or a printed copy) as the shared scoreboard.

Start date: ____________ Target review date (start + 14 days): ____________

---

## 1. What partners do every day

- **Enter it once, in the app.** Orders, expenses/income, budgets, task moves —
  the moment it happens, not at end of day.
- **Keep the old record too**, as the comparison copy, for these two weeks.
- **Check the Sync screen** if you worked offline: no entry may sit in
  **Waiting to sync** overnight. Anything in **Needs your attention** gets fixed
  or flagged the same day.
- **Reconcile at day's end (2 minutes):** does the app's cash / today's total
  look like the old record? If it matches, tick the day in §3.

## 2. Founder — extra daily/weekly checks

- **Reconciliation screen** once a day → must show **zero difference**.
- Spot-check a few orders and ledger entries against the old record.
- Confirm the **keep-awake monitor** is up (first tap of the day is fast) and
  the **nightly backup ran** (newest `.enc` is from yesterday).
- Watch for slow/duplicate/missing writes; that is exactly what this window is
  for.

---

## 3. Comparing the app to the old records

**Cadence:**

- **Daily** — each partner eyeballs their own totals vs the old record.
- **Every 2–3 days** — Founder compares the **app figures** (Cash Balance,
  Income, Expenses, Net Profit, Stock valuation, open Orders/Tasks) against the
  old record and logs the delta.
- **End of each week** — a full side-by-side of the month-to-date money and
  stock.

Record results (a ✔ means the app and old record agree within rounding):

| Date | Cash | Income | Expenses | Stock | Orders/Tasks | Notes |
| ---- | ---- | ------ | -------- | ----- | ------------ | ----- |
|      |      |        |          |       |              |       |
|      |      |        |          |       |              |       |

> The app is the more rigorous source: money is **append-only** and reversible,
> figures are **recomputed** independently. If the app and the old record
> disagree, first re-check the **old** record — past the two-week window,
> investigate every app-vs-old mismatch before trusting either.

---

## 4. How to report a bug

Give enough to reproduce it — a vague "the numbers are wrong" cannot be fixed.
Send to the Founder/operator (chat `#General` or messaging), including:

1. **What you did** (screen + the exact taps, e.g. Finance → New transaction → Expense).
2. **What you expected** vs **what happened**.
3. **The numbers involved** (amounts, order number, date) — but **no passwords**.
4. **When** it happened and **which device/browser**.
5. A **screenshot** if it's a display problem.

Label severity: **Money wrong** / **Can't save** / **Looks wrong only**. Anything
in the first two categories stops that person using the affected feature until it
is resolved.

---

## 5. When to take a manual backup

The nightly job is the routine; take an **extra manual backup**:

- **Before** the first real data entry each of the first few days.
- After any **large correction** or bulk entry.
- **Before and after** any dependency update or redeploy.
- At the **end of week 1** and **end of week 2** (these become the rollback
  points if anything goes wrong later).

How: `npm run backup` (see `docs/BACKUP_RECOVERY.md` §2) — and confirm the key
file still decrypts it by doing a dry-run restore.

---

## 6. Exit criteria — retiring the old records

The old spreadsheet/notebook may be **retired (switch to the app only)** only
when **all** are true:

- [ ] **14 straight days** of daily use with **no "Money wrong" / "Can't save"**
      bugs open.
- [ ] Every day's comparison (§3) agreed, and the **Reconciliation screen shows
      zero difference** on the review date.
- [ ] Nothing is stuck in **Waiting to sync / Needs attention** on any device.
- [ ] All four users are onboarded (own login, changed password, know the daily
      loop and the Sync screen).
- [ ] A **restore has been tested from hand** at least once (see §5 and
      `docs/BACKUP_RECOVERY.md` §3).
- [ ] The **nightly backup job** has produced several consecutive good archives,
      kept **off the laptop**.

Only then: archive the old record read-only (do not delete it yet), announce the
switch date, and keep watching the Reconciliation screen daily for another week.

> **Do not confuse this with deleting the Atlas `test` database.** That is a
> separate, later, gated action described in `docs/MAINTENANCE.md` §6 — it needs
> a final verified backup **and** two weeks of _stable app-only_ use, and is
> never done inside this checklist.
