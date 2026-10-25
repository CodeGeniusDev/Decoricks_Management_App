# Daily Use — Founder's One-Page Routine

Everything here is something the app actually does. Screens are named exactly as they appear in the sidebar.

## Every day (about 5 minutes)

1. **Log in** and glance at the **Dashboard** — today's cash, recent activity, open tasks.
2. **Record the money in Finance.** Every real event gets exactly one entry with the right type:
   - A sale or any money coming in → **Income**
   - Any cost (ads, purchasing, misc) → **Expense** (pick the category)
   - Money moved between Cash / Bank Account / Wallet → **Transfer** (this is NOT income or expense)
   - A partner putting their own money into the business → **Partner capital** (NOT income)
   - A partner taking business money out personally → **Partner withdrawal** (NOT an expense)
   - A partner's profit share left in the business → **Reinvestment**
     If you are unsure how to record the very first entries, follow `docs/FIRST_REAL_ENTRIES.md` once — after that the daily habit is simple.
3. **Sales**: when a new order arrives, add it under **Sales** and update its status as it moves to delivery. Payment received on an order is recorded through the order — do not also add it as Income the same day (that double-counts).
4. **Inventory**: when stock physically moves in or out, record it on **Inventory** the same day.
5. **Tasks / Chat**: assign or complete tasks on **Tasks**; team messages live on **Chat**. No WhatsApp for work items you want tracked.

**Golden rule:** one real event = one entry, in one place. If you ever record the same money twice, the ledger will still look internally consistent — reconciliation cannot catch it (see `docs/FIRST_REAL_ENTRIES.md`).

## Every week (about 15 minutes, e.g. Friday)

1. Open **Weekly Summary** and export the week (Finance, Inventory, Sales, Tasks are all included in the bundle). Share it with the partners.
2. On **Profit & Loss**, check the week's revenue vs expenses — nothing should be a surprise; every cost was recorded during the week.
3. On **Budgets**, compare actuals against the month's budget. A budget line far off track is a conversation, not a data problem.
4. Glance at **Inventory** for anything near zero and reorder from **Suppliers**.
5. If you run your own backups on your machine, run `npm run backup` (or your `scripts/backup.sh`) and confirm a new `.enc` file appeared in the backups folder. Never let any script create or replace `~/.decoricks/backup.key`.

## Every month (about 30 minutes)

1. **Reconciliation** (Founder-only screen): run the checks. All should pass. Remember what it does and does not prove: it checks the books are _consistent_, not that they are _true_ — an entry recorded twice still passes. So read P&L with your eyes too.
2. **Profit Distribution**: if **Profit & Loss** shows a positive net profit and the partners agree, create a distribution on **Profit Distribution**. The app splits the profit per partner by the percentages in Settings and computes the charity share. Review the numbers before recording, and pay partners via **Partner withdrawal** / record **Reinvestment** exactly as agreed.
3. **Backup proof**: list the latest `.enc` backups and, once a quarter, restore one into the dev database (`npm run restore`, never with a prod database name) to prove the backup is real. Details: `docs/BACKUP_RECOVERY.md`.
4. **Render health**: in the Render dashboard confirm the service is Up, the uptime monitor (10-minute checks on `/api/health`) is green, and the free-hours usage bar has room left. `docs/RENDER_OPERATIONS.md` §6–7.
5. **Settings**:
   - **Audit Log tab** — skim who changed what this month.
   - **Users tab** — deactivate anyone who left; check roles still match duties.
   - Ask anyone whose password was shared with a group chat to use **Change password**.

## Things the app will NOT do (so you always do them by hand)

- It will not tell you an entry is wrong — a double-count passes every check. Record each event once, in the right type.
- It will not chase partners for money in or out; every rupee that moves must appear as an entry.
- It will not back itself up; the backup is a command you run.

## Khulasa (Roman Urdu)

Roz: app khol kar Dashboard dekho; jo paisa aaye ya jaye woh usi din Finance mein sahi type (Income / Expense / Transfer / Partner capital / Partner withdrawal) ke sath ek dafa entry karo. Order ki payment Sales se record hoti hai — dobara Income mein mat likho, warna double count ho jaye ga aur reconciliation pakar hi nahi payega.

Hafte: Weekly Summary se poore hafte ka export bana kar partners ko bhejo. Profit & Loss par hifson se numbers check karo. Budget aur Inventory par ek nazar daal lo. Backup (`npm run backup`) lazmi — aur backup key file kabhi kisi script se replace mat hone dena.

Mahine: Reconciliation chalao (sab pass aana chahiye), phir soch samajh se Profit Distribution banao (charity ka hissa app khud nikalta hai). Ek `.enc` backup khol kar test karo, Render par health aur free hours check karo, aur Settings → Audit Log par jhoanko ke kisne kya badla.

Asool: har asli waqea = ek entry, ek jagah, usi din.
