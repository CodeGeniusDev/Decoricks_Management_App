# Decoricks Management App — User Guide

A short, plain-language guide for the four partners. It describes **only what the
app actually does** today. There are no screenshots. If something here does not
match what you see, tell the Founder — the app, not this page, is the truth.

---

## 1. What this app is

Decoricks Management App is the shared system for the furniture business: money in
and out, budgets, stock, sales orders, tasks, and team chat — all in one place,
reachable from a phone browser. Everyone signs in with their own email and
password. What each person can see and change depends on their role (see §3).

The app is hosted on **Render (free plan)** with the database on **MongoDB Atlas
(free tier)**. Because both are free tiers, the first tap after a period of
quietness can take **~30–60 seconds** (the server "wakes up"). That is normal;
the next taps are fast. See §7.

---

## 2. Signing in (first time)

1. Open the app URL in your browser (ask the Founder for the link).
2. On the **Login** screen enter your **email** and **password**.
3. The **Founder's** first sign-in uses a temporary bootstrap password and the
   app will force a **change password** immediately. Choose a strong new
   password and save it somewhere safe.
4. You stay signed in on that device for a while (no need to log in every few
   minutes). When you are done, use the **Log out** button in the top bar.

> Your session belongs to **this device and this browser**. Signing in on your
> phone and on your laptop are two separate sessions.

---

## 3. The two kinds of user

- **Founder** — the owner account. Can do everything, including the money
  approvals, the user list, permissions, reconciliation, the audit log, and
  Settings.
- **Partner** — a team member. By default the three partner logins are set up
  with **different** access on purpose:

  | Partner (default) | Sales | Finance | Inventory | Tasks / Chat |
  |---|---|---|---|---|
  | **Hasnat** | Create & edit orders, returns | View only | View (can record Lahore stock) | Own tasks / full chat |
  | **Ali** | View only | View only | View (can record Lahore stock) | Own tasks / full chat |
  | **Afnan** | View only | View only | View only | Own tasks / full chat |

  These are **defaults**. The Founder can grant more (or less) to any role in
  **Settings → Permissions**. If a button is missing for you, it usually means
  your role does not have that permission yet — ask the Founder.

> Chat is open to everyone. Money edits (creating transactions, approving
> budgets/distributions) are Founder actions unless the Founder grants them.

---

## 4. Founder — the things only you do

1. **Add a person** — Settings → **Users & Roles** → **Add user**: their name,
   email, a temporary starting password, and pick their role. They must change
   the password on first sign-in. (Details in `docs/MAINTENANCE.md`.)
2. **Set permissions** — Settings → **Permissions**: tick what each role may
   view / create / edit / delete / approve. Changes take effect on their next
   action.
3. **Maintain the money lists** — Finance → **Accounts** and Finance →
   **Categories**: add the bank/cash accounts and the income/expense categories.
   An expense cannot be saved until a category exists.
4. **Record and correct money** — Finance → **New transaction** posts income,
   expenses, transfers, partner capital/withdrawal, reinvestment. Money is
   **append-only**: you never delete a wrong entry, you **reverse** it (creates an
   opposite entry), so the history stays honest.
5. **Approve** budgets and profit distributions (Budgets, Profit Distribution).
6. **Reconciliation** — the **Reconciliation** screen (Founder-only) recomputes
   every headline figure independently and should show **zero difference**. Check
   it after big data changes or a restore.
7. **Audit log** — Settings → **Audit Log** shows who did what. It is read-only
   and cannot be edited or deleted. Settings → **Data Export** downloads the
   current books as CSV (transactions, products, stock, orders), each honoring
   your permissions.
8. **Business settings** — Settings → **Business Settings** for company-level
   values.

---

## 5. Partner — your daily loop

1. **Dashboard** (home) — the numbers for the day: cash, income/expense, open
   tasks, recent orders. Pull the sidebar to move around.
2. **Sales → New order** — record a customer order (only if your role can create
   sales, e.g. Hasnat/Founder). Prices come from the product list, so you cannot
   type a price by mistake. Creating the order **reserves the stock**.
3. **Tasks** — your board. Open a card to read/comment, drag it to another
   column, or use its **Move to…** menu. You manage your **own** cards; the
   Founder can manage everyone's.
4. **Chat** — the shared team channel; mention people with `@` and reply to a
   specific message.
5. **Inventory / Suppliers / Budgets** — look things up (edit only if granted).
6. **Sync** — if you ever saved something while offline, check it here (see §6).

---

## 6. Working offline (the Sync screen)

Some entry forms keep your work when the internet drops:

- A **New transaction** (Finance) or **New budget** saved **with no connection**
  is stored on **this device** and listed on the **Sync** screen as **Waiting to
  sync**. Nothing has reached the ledger yet.
- When you are back online, open **Sync** and press **Sync now** (or the app
  retries on its own). A row that becomes **Synced** is now a normal entry and
  shows up on the page that owns it.
- A row that turns **Needs your attention** was refused by the server (for
  example a validation problem or a clash with something already saved). Use
  **Retry**, or **Edit & resubmit** to fix it in the form, or **Discard** to drop
  it from this device (it asks first, and it only removes the never-saved copy).

**Important, honest limits of offline:**

- Only **creating a finance entry or a budget** works offline. Orders, tasks,
  chat, edits and deletes need a connection.
- The queue is **per device**. Your phone's unsent entries are not on your
  laptop.
- **Clearing the browser's site data deletes unsent entries** — that is the one
  way an offline draft can be lost. Sync before you clear data or change phone.

---

## 7. Things that will surprise you (but are normal)

- **First tap is slow after quietness.** The free host sleeps after ~15 minutes
  and the next request wakes it (~30–60 s). Keep the app in a tab, or just tap
  again if it stalls once.
- **After the Founder deploys an update** everyone sees one slow request while it
  restarts, then it's fast again.
- **"Saved" vs "Waiting".** On the Sync screen only **Synced** means the server
  has it. **Waiting to sync** means it is still just on your device.
- **You cannot erase money entries.** Wrong entry → reverse it. That is by
  design so the books always reconcile.
- **A missing button is a permission**, not a bug. Ask the Founder to grant it.

---

## 8. Quick guide — Roman Urdu (daily kaam)

**Login:** App kholo, apna email aur password daalo. Pehli baar Founder ko
password badalna parega.

**Order add karna** (Hasnat / Founder): **Sales** kholo → **New order** →
customer ka naam, phone, sheher, pata, channel bharo → **Ship from** (Sheikhupura
ya Lahore) chooso → items mein **product** aur **quantity** daalo (rate apne aap
product list se aayega) → chahein to shipping aur courier charge likho → **Create
order**. Order banate hi stock reserve ho jata hai.

**Expense add karna** (Founder, ya jise permission ho): **Finance** → **New
transaction** → **Type = Expense** → **Amount (PKR)** → **Date** → **Account**
chooso → **Category** chooso (pehle se category honi chahiye) → chahein to
**Payment method** aur **Note** → **Save transaction**. Ghalat entry **delete
nahi** hoti — usay **Reverse** karo (ulta entry ban jati hai).

**Task move karna:** **Tasks** board kholo → apni card ko **doosre column mein
drag** karo, ya card khol ke **Move to…** se column badlo. (Sirf apni cards;
Founder sabki kar sakta hai.)

**Offline entry:** Jab internet na ho, **New transaction** ya **New budget**
save karo to woh aapke **device par** "Waiting to sync" mein mehfooz ho jayega.
Internet aane par **Sync** kholo → **Sync now** → status **Synced** ho jaye.
Agar **Needs your attention** aaye to **Retry** ya **Edit & resubmit** karo.

**Sync screen check karna:** Sidebar se **Sync** kholo. Yahan teen ginati
dikhti hain — **Waiting to sync**, **Needs your attention**, **Synced (last
24h)**. Har row par **Retry / Edit & resubmit / Discard** hai. Upar **Sync now**
daba ke poori queue server par bhej do.

> **Note:** "Add expense" aur "offline entry" **sirf create** ke liye hain, aur
> **finance create** by-default sirf Founder ke paas hai. Partner ko permission
> Founder **Settings → Permissions** se deta hai.
