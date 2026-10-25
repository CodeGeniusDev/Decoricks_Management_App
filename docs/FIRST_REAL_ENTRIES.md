# First Real Entries — how to record your starting position without counting it twice

Written after the Stage-2 purge, when `decoricks_prod` holds only
configuration (users, roles, accounts with PKR 0 opening balances, categories,
the 3 chat channels). Everything you enter from now on is real. This guide was
verified by running every scenario below against `decoricks_dev` with the app's
own engines — the numbers shown are real output, not illustrations.

## The three ideas the app is built on

1. **Cash** — what is physically in your accounts (Cash, Bank Account, Wallet).
2. **Profit (P&L)** — revenue minus expenses. Capital and withdrawals are NOT
   profit; they never appear in the P&L.
3. **Partner capital** — what each partner put INTO the business, and what they
   took OUT (withdrawals). This is the partners' claim on the business,
   separate from profit.

Every paisa in your accounts must be explained **exactly once** — either as an
account's opening balance or as a ledger entry. Explained twice = double
counted. The reconciliation screen checks that the books are _consistent_, not
that they are _true_ — this is the single most important thing to understand
before your first entries (proved with real output below).

---

## a) Four partners each contributed PKR 25,000 (total PKR 100,000)

You have two ways to represent this. I tested BOTH, plus the trap of doing
both at once, on `decoricks_dev`. Real output:

### Approach 1 — opening balance on the Bank account (no ledger entries)

```
--- A — Bank opening balance PKR 100,000, zero transactions ---
  account Bank Account   opening   10000000  balance PKR 100,000
TOTAL CASH (dashboard cash block) : PKR 100,000
Dashboard/finance summary : revenue PKR 0 | expense PKR 0 | netProfit PKR 0
                            capital PKR 0 | withdrawals PKR 0 | equity PKR 0
Cash flow : revenueIn PKR 0 | capitalIn PKR 0 | operatingOut PKR 0 | net PKR 0
P&L       : NET PROFIT PKR 0
Distribution: distributable netProfit PKR 0
Partner capital per partner: (no capital entries)
Reconciliation (all 9 checks): ALL PASS
```

Cash is right (PKR 100,000). Nothing is double counted. **But the books have no
memory**: no record of who contributed what, no date, no audit trail, no
payment method. Partner capital shows PKR 0, so a later "return of capital" or
profit-weighting discussion has nothing to point at. An opening balance is also
easy to re-edit silently later — it is a setting, not a transaction.

### Approach 2 — four `Partner capital` ledger entries of PKR 25,000 (recommended)

Entered as: Finance → **+ New entry** → type **Partner capital** → Partner =
each user, Account = Bank, Amount = PKR 25,000, date = the day the money
arrived, payment method = bank transfer. One entry per partner.

```
--- B — 4 x PKR 25,000 partner_capital into Bank ---
  account Bank Account   opening          0  balance PKR 100,000
TOTAL CASH (dashboard cash block) : PKR 100,000
Dashboard/finance summary : revenue PKR 0 | expense PKR 0 | netProfit PKR 0
                            cashIn PKR 100,000 | capital PKR 100,000 | equity PKR 100,000
Cash flow : revenueIn PKR 0 | capitalIn PKR 100,000 | net PKR 100,000
P&L       : revenue PKR 0 | NET PROFIT PKR 0          ← capital is NOT income
Distribution: distributable netProfit PKR 0           ← nobody can "distribute" their own capital
Partner capital per partner:
  Abdullah Abbad PKR 25,000 | Partner Hasnat PKR 25,000 | Partner Ali PKR 25,000 | Partner Afnan PKR 25,000
Reconciliation (all 9 checks): ALL PASS
```

Same cash as Approach 1 — and on top of it: per-partner attribution, a dated
auditable trail, the money visible as a real inflow in Cash Flow (under
_Capital in_, never under revenue), and no effect on P&L or distributions.
**This is the recommended method: keep all opening balances at 0 and post the
contributions as `Partner capital` entries.**

### The trap — doing both (verified double count)

```
--- A+B — same PKR 100,000 as opening balance AND capital entries ---
  account Bank Account   opening   10000000  balance PKR 200,000
TOTAL CASH : PKR 200,000                 ← the business looks TWICE as rich
Reconciliation (all 9 checks): ALL PASS  ← reconciliation CANNOT see this
```

The dashboard shows PKR 200,000 while the partners actually contributed
PKR 100,000 — and **reconciliation still passes all 9 checks**. That is not a
bug: reconciliation verifies that all screens agree with the ledger and with
each other; if the ledger itself describes the money twice, every screen
"correctly" shows the doubled figure. The only defence is the rule from the
top: opening balance OR ledger entry, never both. (If you ever double-post,
fix it with a reversal of the extra entry, or the Founder editing the opening
balance back — both are audited.)

One more wrong option, for completeness: posting the PKR 100,000 as **Income**
would make it revenue, inflate net profit, and the Distributions screen would
let partners "share out" their own contributed money as if it were profit,
taxed by charity percentage. `Partner capital` exists precisely to avoid that.

---

## b) An expense a partner paid personally, before the app existed

Example (verified): Partner Ali bought PKR 18,000 of fabric with his own money
before Decoricks had any business accounts. The business bank never saw the
paisa, but the cost is genuinely the business's.

**Record it as a pair — an in-kind capital contribution and the expense — on
the same date:**

1. Finance → + New entry → **Partner capital**: Ali, PKR 18,000, account =
   Bank, note _"In-kind capital: paid PKR 18,000 fabric from personal pocket
   before the app"_.
2. Finance → + New entry → **Expense**: PKR 18,000, account = Bank, category
   (e.g. Product Purchasing / Miscellaneous), same note.

Real output with the pair posted on top of the PKR 100,000 capital:

```
--- C — in-kind capital +18,000 and expense -18,000 posted together ---
  account Bank Account   balance PKR 100,000   ← cash NOT reduced by 18,000 twice; net effect on cash: 0
TOTAL CASH : PKR 100,000
Dashboard summary : expense PKR 18,000 | netProfit PKR -18,000 | capital PKR 118,000
Cash flow : capitalIn PKR 118,000 | operatingOut PKR 18,000 | net PKR 100,000
P&L       : operatingExpenses PKR 18,000 | NET PROFIT PKR -18,000
Partner capital: Ali PKR 43,000 | others PKR 25,000 each
Reconciliation (all 9 checks): ALL PASS
```

Why this is correct on all three fronts at once:

- **Cash**: +18,000 (capital) −18,000 (expense) = net 0 — because the
  business's own money never moved.
- **P&L**: the expense is recorded, profit reduced by 18,000 — a real cost of
  doing business shows in the period it is entered (there is no way to
  reconstruct which month it "belonged" to; date it the day the cost was
  incurred if you know it, and say so in the note).
- **Partner capital**: Ali is credited PKR 43,000 total (25,000 cash + 18,000
  in-kind) — the books now know the business owes him that, and a later
  `Partner withdrawal` (or unequal profit split) can reference it.

Wrong alternatives, and how they break:

- **Expense only** (bank account debited): cash drops by PKR 18,000 the
  business never had — the Bank balance now lies by 18,000.
- **Not recording it at all**: Ali's PKR 43,000 is invisible; a later
  withdrawal for it looks like he is taking more than he contributed.
- If the item bought pre-app is **unsold stock** rather than a cost, do not
  expense it — enter it through Inventory as a purchase (it becomes stock
  value, and the cost hits P&L only when sold, as COGS). The capital entry for
  Ali is the same.

A loss month like this simply has nothing to distribute — run Distributions
only for months where P&L shows positive net profit.

---

## c) Recommended entry order for the first week of real data

Order matters only in two places: partners and accounts must exist before you
reference them, and products must exist before stock or orders can move them.

| Step | Screen                                               | Enter                                                                                                                                                                                                                                       |
| ---- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Settings → Users / Business**                      | Confirm the four partner users and the profit-sharing percentages + charity %. Set the withdrawal lock date if capital shouldn't leave yet.                                                                                                 |
| 2    | **Finance → Accounts**                               | Keep Cash / Bank / Wallet opening balances at **0** — your real money arrives in step 3 as ledger entries. (Use the opening-balance field only for money genuinely in an account that you cannot or choose not to trace to a contribution.) |
| 3    | **Finance → + New entry → Partner capital**          | The four PKR 25,000 contributions (one entry per partner, dated, payment method, note). This is your verified start.                                                                                                                        |
| 4    | **Finance → + New entry → Expense (+ capital pair)** | Any pre-app costs a partner paid personally — as the pair shown in (b).                                                                                                                                                                     |
| 5    | **Suppliers**                                        | Add your real suppliers (name, contact, payment terms).                                                                                                                                                                                     |
| 6    | **Inventory → Products**                             | Add real products with prices.                                                                                                                                                                                                              |
| 7    | **Inventory → Purchase (stock-in)**                  | First stock purchase from a supplier, paid from the Bank account — the purchase posts the expense/COGS side and raises stock value together, in one flow.                                                                                   |
| 8    | **Sales → New order**                                | First real customer order. Order income and delivery flows post through the ledger the same way the demo records did.                                                                                                                       |
| 9    | **Finance → Cash Flow / Profit & Loss**              | Cross-check: _capital in_ PKR 100,000, revenue/expense matching steps 4–8.                                                                                                                                                                  |
| 10   | **Reconciliation**                                   | Run it (Founder). All checks pass = every screen tells the same story. Then do the same on the last day of the month before running **Distributions**.                                                                                      |

Every step from 3 onwards writes an append-only audit entry (who, when, what,
before/after). Nothing here needs Atlas; the app is the only correct place to
enter or fix money — a direct Atlas edit bypasses audit and can create exactly
the inconsistency class (a) warns about.

---

## Roman Urdu summary (khulasa)

Aapke charon partners ne PKR 25,000 diye — ye rakhte hue **Finance → New entry
→ "Partner capital"** se har partner ke naam alag entry banayein (char
entries, kul PKR 100,000). Account ka **opening balance 0 hi rakhein** — agar
balance bhar diya aur capital ki entry bhi laga di, to dashboard par PKR
2,00,000 nazar aayenge aur Reconciliation phir bhi poora pass karega — yani
double count khud pakra hi nahin jayega, isliye rule sakhti se follow karein.
Jo kharcha kisi partner ne app aane se
pehle apni jaib se kiya, usko **jodi** mein likhein: pehle us partner ke naam
"Partner capital" ki entry, phir usi raqam ki "Expense" entry — se cash theek
rahega, P&L mein kharcha aayega, aur us partner ka capital sahi jagah likha
aayega. Pehla hafta is tarteeb se bharein: users/settings → capital entries →
purane kharche → suppliers → products → pehli khareed (stock) → pehla order →
phir Cash Flow, P&L aur Reconciliation check karein. Munafa tab tak distribute
na karein jab tak P&L positive na ho. Har entry app ke andar se — Atlas se
seedha kabhi kuch badlein na.
