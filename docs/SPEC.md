# Decoricks Management App - Complete Specification

**Version:** 1.0  
**Date:** 2026-10-04  
**Status:** Phase 0 Specification (No Code)  
**Business:** Decoricks - Pakistan-based home decor e-commerce brand

---

## 1. MVP Scope and Out-of-Scope

### 1.1 MVP Scope (Phase 1)

**Core Modules:**

- Financial management (income, expenses, transfers, profit calculation)
- Budgeting and profit tracking (budget creation, tracking, variance reporting)
- Inventory management (multi-location stock tracking, weighted average valuation)
- Sales and order management (manual order entry, COD tracking, delivery outcomes)
- Trello-style task management (Kanban boards for team tasks)
- Team chat (real-time messaging)
- Roles and permissions (module/action-based, revocable)
- Dashboards and reports (real-time metrics, weekly meeting summary)
- Alerts and notifications (in-app and push where supported)

**Core Features:**

- Responsive web app (desktop, tablet, mobile)
- Real-time sync across devices
- Offline data entry for financial/budget data with automatic sync
- Audit logging for all critical actions
- Reversal-based financial corrections (no silent edits)
- Multi-location inventory tracking (Sheikhupura, Lahore)
- Profit sharing with configurable percentages (20% each partner, 20% charity)
- Manual backup/export and restore functionality
- Weekly meeting summary view

### 1.2 Out-of-Scope (Phase 1)

**Deferred to Future Phases:**

- Payment gateway integration
- Bank account reconciliation
- Automated tax/GST tracking
- Purchase order workflow
- CRM and customer analytics
- Purchase history analytics
- Advanced supplier management
- Multi-warehouse beyond 2 locations
- Barcode/QR code scanning
- Integration with Shopify or external platforms
- Email/SMS notifications
- Mobile app (native iOS/Android)
- Advanced reporting (P&L by product, cohort analysis, etc.)
- Automated profit share deductions (manual adjustment only)
- Charity partner integration
- Document attachments
- Export to PDF/Excel

---

## 2. Screen and Navigation Map

### 2.1 Navigation Structure

```
┌─────────────────────────────────────────────────────────┐
│  Decoricks              [Abdullah ▼]  [Notifications] │
├─────────────────────────────────────────────────────────┤
│ Sidebar                                                │
│ ├─ Dashboard                                          │
│ ├─ Finance                                             │
│ │   ├─ Income                                          │
│ │   ├─ Expenses                                        │
│ │   ├─ Transfers                                       │
│ │   └─ Profit Distribution                             │
│ ├─ Budgeting                                           │
│ │   ├─ Budgets                                         │
│ │   └─ Reports                                         │
│ ├─ Inventory                                           │
│ │   ├─ Products                                        │
│ │   ├─ Stock (Sheikhupura)                             │
│ │   ├─ Stock (Lahore)                                  │
│ │   └─ Transfers                                       │
│ ├─ Sales                                               │
│ │   ├─ Orders                                          │
│ │   └─ Returns                                         │
│ ├─ Tasks                                               │
│ ├─ Chat                                                │
│ ├─ Suppliers                                          │
│ ├─ Settings                                            │
│ │   ├─ Roles & Permissions                             │
│ │   ├─ Business Settings                               │
│ │   ├─ Data Export/Backup                              │
│ │   └─ Audit Log                                        │
│ └─ Weekly Summary                                      │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Screen Descriptions

#### Dashboard

- **Purpose:** Real-time overview of business health
- **Widgets:**
  - Current cash balance
  - Month-to-date revenue
  - Month-to-date expenses
  - Net profit (current month)
  - Inventory value (total and per location)
  - Pending tasks count
  - Recent orders (last 5)
  - Quick action buttons (Add Order, Add Expense, Add Task)
- **Charts:**
  - Revenue vs Expenses (7-day, 30-day)
  - Stock levels by location
  - Profit trend (30-day)

#### Finance Module

- **Income Screen:** List of all income records, filterable by date, category, source. Add/Edit/View actions.
- **Expenses Screen:** List of all expense records, filterable by date, category, vendor. Add/Edit/View actions.
- **Transfers Screen:** List of cash transfers between accounts (not income/expense). Add/Edit/View actions.
- **Profit Distribution Screen:** Monthly profit breakdown, partner shares, charity allocation, manual adjustments.

#### Budgeting Module

- **Budgets Screen:** List of budget periods, with status (active, archived). Create/Edit/View budgets.
- **Reports Screen:** Budget vs Actual comparison, variance analysis, per category.

#### Inventory Module

- **Products Screen:** Product catalog with name, SKU, description, cost, selling price. Add/Edit/View actions.
- **Stock Screens (per location):** Current stock levels, low stock alerts, stock movements log.
- **Transfers Screen:** Transfer stock between Sheikhupura and Lahore. Add/Edit/View actions.

#### Sales Module

- **Orders Screen:** Order list with customer details, items, total, status, COD outcome. Add/Edit/View actions.
- **Returns Screen:** Return processing with restock/damaged/write-off options. Add/Edit/View actions.

#### Tasks Module

- **Kanban Board:** Boards (create/rename/archive by Founder) with editable columns — defaults To Do, In Progress, Review, Done; Founder can add/rename/reorder/archive. Cards drag between columns (dnd-kit; keyboard and touch supported) with optimistic writes and version-based conflict rejection; mobile also offers a "Move to…" menu. Task detail opens in a right drawer on desktop, full-screen sheet on mobile. Assignees, priorities (low/medium/high/urgent), due dates, labels, checklists, activity timeline, comments. Views: Board, My Tasks, Overdue. Weekly summary reports task completions and per-member overdue counts (informational; penalties remain a manual Founder action).

#### Chat Module

- **Chat Screen:** Real-time messaging with all team members. Message history, typing indicators, read receipts.

#### Suppliers Module

- **Suppliers Screen:** Supplier list with name, contact, city, products supplied, notes. Add/Edit/View actions.

#### Settings Module

- **Roles & Permissions Screen:** User management, role definitions, permission matrix.
- **Business Settings Screen:** Configurable business policies (profit sharing, withdrawal lock date, expense categories, payment methods).
- **Data Export/Backup Screen:** Manual export, scheduled export configuration, restore procedure.
- **Audit Log Screen:** Searchable log of all critical actions with timestamp, user, action, details.

#### Weekly Summary

- **Purpose:** One-page summary for weekly meetings
- **Sections:**
  - Sales summary (orders, revenue, COD delivery rate)
  - Expenses summary (total, by category)
  - Profit summary (gross, net, cash flow)
  - Stock summary (total value, low stock items, transfers)
  - Tasks completed

---

## 3. MongoDB Schema

### 3.1 Collections

#### 3.1.1 users

```javascript
{
  _id: ObjectId,
  email: String, // unique, indexed
  passwordHash: String, // bcrypt
  name: String,
  role: String, // 'founder', 'partner', 'admin'
  partnerId: String, // optional, references profit share config
  isActive: Boolean, // default true
  createdAt: Date,
  updatedAt: Date,
  lastLoginAt: Date
}

Indexes:
- email: unique
- isActive: 1
```

#### 3.1.2 roles

```javascript
{
  _id: ObjectId,
  name: String, // e.g., 'founder', 'partner_hasnat', 'partner_afnan'
  displayName: String,
  permissions: {
    finance: {
      view: Boolean,
      create: Boolean,
      edit: Boolean,
      delete: Boolean,
      approve: Boolean
    },
    budget: {
      view: Boolean,
      create: Boolean,
      edit: Boolean,
      delete: Boolean,
      approve: Boolean
    },
    inventory: {
      view: Boolean,
      create: Boolean,
      edit: Boolean,
      delete: Boolean
    },
    sales: {
      view: Boolean,
      create: Boolean,
      edit: Boolean,
      delete: Boolean
    },
    tasks: {
      view: Boolean,
      create: Boolean,
      edit: Boolean,           // edit / move own tasks
      editOthers: Boolean,     // edit / move others' tasks (Founder default)
      delete: Boolean,         // archive own tasks
      deleteOthers: Boolean,   // archive others' tasks (Founder default)
      comment: Boolean,        // comment on any task
      manage: Boolean          // manage boards and columns (Founder-only, not grantable)
    },
    chat: {
      view: Boolean,
      create: Boolean,
      edit: Boolean,
      delete: Boolean
    },
    suppliers: {
      view: Boolean,
      create: Boolean,
      edit: Boolean,
      delete: Boolean
    },
    settings: {
      view: Boolean,
      edit: Boolean
    },
    users: {
      view: Boolean,
      create: Boolean,
      edit: Boolean,
      delete: Boolean
    }
  },
  createdAt: Date,
  updatedAt: Date
}

Indexes:
- name: unique
```

#### 3.1.3 products

```javascript
{
  _id: ObjectId,
  sku: String, // unique, indexed
  name: String,
  description: String,
  category: String,
  cost: Number, // paisa, weighted average cost
  sellingPrice: Number, // paisa
  isActive: Boolean, // default true
  createdAt: Date,
  updatedAt: Date
}

Indexes:
- sku: unique
- isActive: 1
- category: 1
```

#### 3.1.4 stock

```javascript
{
  _id: ObjectId,
  productId: ObjectId, // references products
  location: String, // 'sheikhupura' or 'lahore'
  quantity: Number, // integer, default 0
  lastUpdated: Date,
  updatedAt: Date
}

Indexes:
- productId: 1, location: 1 (unique compound)
- location: 1
- quantity: 1 (for low stock queries)
```

#### 3.1.5 stockMovements

```javascript
{
  _id: ObjectId,
  productId: ObjectId,
  fromLocation: String, // null for purchases
  toLocation: String, // null for sales/writes-off
  quantity: Number, // positive integer
  movementType: String, // 'purchase', 'sale', 'transfer', 'restock', 'damage', 'writeoff'
  referenceId: ObjectId, // references order, purchase, etc.
  referenceType: String, // 'order', 'purchase', 'transfer', 'adjustment'
  unitCost: Number, // paisa, at time of movement
  notes: String,
  createdAt: Date,
  createdBy: ObjectId // references users
}

Indexes:
- productId: 1
- referenceId: 1, referenceType: 1
- movementType: 1
- createdAt: -1
```

#### 3.1.6 orders

```javascript
{
  _id: ObjectId,
  orderNumber: String, // unique, auto-generated, indexed
  customerName: String,
  customerPhone: String,
  customerCity: String,
  customerAddress: String,
  items: [{
    productId: ObjectId,
    productName: String,
    quantity: Number,
    unitPrice: Number, // paisa, at time of sale
    total: Number // paisa
  }],
  subtotal: Number, // paisa
  shippingCost: Number, // paisa, default 0
  total: Number, // paisa
  paymentMethod: String, // e.g., 'cod'
  paymentStatus: String, // 'pending', 'received', 'refunded'
  orderStatus: String, // 'pending', 'processing', 'shipped', 'delivered', 'returned', 'cancelled'
  codOutcome: String, // 'pending', 'delivered', 'returned', 'refused'
  courierCharges: Number, // paisa
  courierName: String,
  salesChannel: String, // e.g., 'shopify', 'instagram', 'facebook'
  deliveryDate: Date,
  notes: String,
  createdAt: Date,
  updatedAt: Date,
  createdBy: ObjectId
}

Indexes:
- orderNumber: unique
- orderStatus: 1
- paymentStatus: 1
- createdAt: -1
- customerPhone: 1
```

#### 3.1.7 returns

```javascript
{
  _id: ObjectId,
  orderId: ObjectId, // references orders
  returnNumber: String, // unique, auto-generated
  items: [{
    productId: ObjectId,
    quantity: Number,
    reason: String
  }],
  outcome: String, // 'restock', 'damaged', 'writeoff'
  refundAmount: Number, // paisa
  courierCost: Number, // paisa, if applicable
  notes: String,
  createdAt: Date,
  updatedAt: Date,
  createdBy: ObjectId
}

Indexes:
- returnNumber: unique
- orderId: 1
- outcome: 1
- createdAt: -1
```

#### 3.1.8 income

```javascript
{
  _id: ObjectId,
  incomeNumber: String, // unique, auto-generated
  amount: Number, // paisa, positive
  category: String, // e.g., 'sales', 'other'
  source: String, // e.g., 'cod', 'bank_transfer'
  description: String,
  referenceId: ObjectId, // optional, references order, etc.
  referenceType: String, // optional
  date: Date,
  createdAt: Date,
  updatedAt: Date,
  createdBy: ObjectId
}

Indexes:
- incomeNumber: unique
- date: -1
- category: 1
- referenceId: 1, referenceType: 1
```

#### 3.1.9 expenses

```javascript
{
  _id: ObjectId,
  expenseNumber: String, // unique, auto-generated
  amount: Number, // paisa, positive
  category: String, // e.g., 'meta_ads', 'shopify', 'shipping', 'packaging'
  vendorId: ObjectId, // optional, references suppliers
  description: String,
  referenceId: ObjectId, // optional
  referenceType: String, // optional
  date: Date,
  createdAt: Date,
  updatedAt: Date,
  createdBy: ObjectId
}

Indexes:
- expenseNumber: unique
- date: -1
- category: 1
- vendorId: 1
```

#### 3.1.10 transfers

```javascript
{
  _id: ObjectId,
  transferNumber: String, // unique, auto-generated
  fromAccount: String, // e.g., 'cash', 'bank_account'
  toAccount: String,
  amount: Number, // paisa, positive
  description: String,
  date: Date,
  createdAt: Date,
  updatedAt: Date,
  createdBy: ObjectId
}

Indexes:
- transferNumber: unique
- date: -1
```

#### 3.1.11 budgets

```javascript
{
  _id: ObjectId,
  budgetNumber: String, // unique, auto-generated
  name: String,
  periodStart: Date,
  periodEnd: Date,
  status: String, // 'draft', 'active', 'archived'
  categories: [{
    category: String,
    budgetedAmount: Number // paisa
  }],
  totalBudgeted: Number, // paisa
  approvedBy: ObjectId, // optional
  approvedAt: Date,
  createdAt: Date,
  updatedAt: Date,
  createdBy: ObjectId
}

Indexes:
- budgetNumber: unique
- status: 1
- periodStart: 1, periodEnd: 1
```

#### 3.1.12 budgetActuals

```javascript
{
  _id: ObjectId,
  budgetId: ObjectId, // references budgets
  category: String,
  actualAmount: Number, // paisa
  calculatedAt: Date
}

Indexes:
- budgetId: 1, category: 1 (unique compound)
- budgetId: 1
```

#### 3.1.13 profitDistributions

```javascript
{
  _id: ObjectId,
  distributionNumber: String, // unique, auto-generated
  periodStart: Date,
  periodEnd: Date,
  totalRevenue: Number, // paisa
  totalExpenses: Number, // paisa
  grossProfit: Number, // paisa
  netProfit: Number, // paisa
  partnerShares: [{
    partnerId: ObjectId,
    partnerName: String,
    sharePercentage: Number, // e.g., 20
    shareAmount: Number, // paisa
    adjustments: [{
      amount: Number, // paisa, positive or negative
      reason: String,
      adjustedBy: ObjectId,
      adjustedAt: Date
    }],
    finalAmount: Number // paisa
  }],
  charityShare: {
    percentage: Number, // e.g., 20
    amount: Number // paisa
  },
  reinvestmentAmount: Number, // paisa
  retainedEarnings: Number, // paisa
  status: String, // 'calculated', 'approved', 'distributed'
  approvedBy: ObjectId,
  approvedAt: Date,
  createdAt: Date,
  updatedAt: Date,
  createdBy: ObjectId
}

Indexes:
- distributionNumber: unique
- periodStart: 1, periodEnd: 1 (unique compound)
- status: 1
```

#### 3.1.14 profitShareAdjustments

```javascript
{
  _id: ObjectId,
  distributionId: ObjectId, // references profitDistributions
  partnerId: ObjectId,
  amount: Number, // paisa, positive or negative
  reason: String,
  createdAt: Date,
  createdBy: ObjectId
}

Indexes:
- distributionId: 1
- partnerId: 1
```

#### 3.1.15 tasks (board model — Phase 6)

The task module is a Trello-style board. It is five collections, not one. The
original `status` enum is gone; a task's stage is derived from the column it
sits in, and columns themselves belong to a board. All timestamps are stored
in UTC and rendered in Asia/Karachi. Nothing in the task family is ever hard-
deleted — every document archives.

##### 3.1.15.1 boards

```javascript
{
  _id: ObjectId,
  name: String,                       // e.g. "Operations"
  description: String,                // optional
  isActive: Boolean,                  // default true; false = archived
  archivedAt: Date,                   // set when archived, never unset
  createdBy: ObjectId,                // references users (Founder-only creation)
  createdAt: Date,
  updatedAt: Date
}

Indexes:
- isActive: 1, updatedAt: -1
- createdBy: 1
```

##### 3.1.15.2 columns

```javascript
{
  _id: ObjectId,
  boardId: ObjectId,                  // references boards
  name: String,                       // default "To Do", "In Progress", "Review", "Done"
  position: Number,                   // 0..n, sparse gaps of 1024 for insert-between
  isDoneColumn: Boolean,              // exactly one per board; drives completedAt
  isArchived: Boolean,                // never hard-deleted
  createdBy: ObjectId,
  createdAt: Date,
  updatedAt: Date
}

Indexes:
- boardId: 1, position: 1
- boardId: 1, isDoneColumn: 1
```

##### 3.1.15.3 tasks

```javascript
{
  _id: ObjectId,
  taskNumber: String,                 // "TASK-YYYYMM-NNNN" (unchanged from Phase 5)
  boardId: ObjectId,                  // references boards
  columnId: ObjectId,                 // references columns — the source of truth for stage
  position: Number,                   // 0..n within column; sparse gaps for insert-between
  title: String,
  description: String,                // optional
  assigneeIds: [ObjectId],            // references users; empty = unassigned
  /** Legacy single-assignee role label. Read-only; migration populates
   *  assigneeIds from it. New writes do not touch it. */
  assigneeName: String,
  priority: String,                   // 'low' | 'medium' | 'high' | 'urgent'
  dueDate: Date,                      // optional; UTC; overdue evaluated at Karachi midnight
  labelIds: [ObjectId],               // references taskLabels (see 3.1.15.6)
  checklist: [{                       // ordered sub-tasks
    _id: ObjectId,
    text: String,
    isDone: Boolean,
    doneAt: Date,
    doneBy: ObjectId
  }],
  completedAt: Date,                  // set when the task enters the board's isDoneColumn
  completedBy: ObjectId,              // who moved it there
  version: Number,                    // optimistic concurrency; incremented on every write
  isArchived: Boolean,                // never hard-deleted
  idempotencyKey: String,             // unique-sparse; prevents duplicate creates
  createdBy: ObjectId,
  createdAt: Date,
  updatedAt: Date
}

Indexes:
- boardId: 1, columnId: 1, position: 1
- assigneeIds: 1
- dueDate: 1
- priority: 1
- isArchived: 1, updatedAt: -1
- taskNumber: unique, sparse
- idempotencyKey: unique, sparse
```

A task's stage (`todo / in_progress / review / done` in older reads) is derived
by joining `columnId → columns.name` (or `columns.isDoneColumn` for done).
The stored `status` field is removed; readers must not depend on it.

##### 3.1.15.4 taskComments

```javascript
{
  _id: ObjectId,
  taskId: ObjectId,                   // references tasks
  authorId: ObjectId,                 // references users
  body: String,
  editedAt: Date,                     // set only if the author edited within the window
  isDeleted: Boolean,                 // soft delete; body is redacted
  deletedAt: Date,
  deletedBy: ObjectId,
  createdAt: Date,
  updatedAt: Date
}

Indexes:
- taskId: 1, createdAt: 1
- authorId: 1
```

Authors may edit or delete only their own comments, and only within
`businessSettings.commentEditWindowMinutes` (default 15). Deletes are soft and
audit-logged.

##### 3.1.15.5 taskActivity

```javascript
{
  _id: ObjectId,
  taskId: ObjectId,
  actorId: ObjectId,
  kind: String,                       // 'created' | 'assigned' | 'moved' | 'completed'
                                      // | 'reopened' | 'commented' | 'archived' | 'edited'
  changes: Object,                    // field-by-field diff, e.g.
                                      //   { from: { columnId, position },
                                      //     to:   { columnId, position } }
  at: Date
}

Indexes:
- taskId: 1, at: -1
```

Append-only. Moving a task into the board's done column writes a `completed`
entry and sets `completedBy/completedAt`; moving it out writes a `reopened`
entry and clears those fields, but the original `completed` entry stays in the
timeline.

##### 3.1.15.6 taskLabels

```javascript
{
  _id: ObjectId,
  name: String,
  color: String,                      // brand hex only, e.g. "#0EA5E9"
  isActive: Boolean,                  // archive rather than delete
  createdBy: ObjectId,
  createdAt: Date,
  updatedAt: Date
}

Indexes:
- name: unique
- isActive: 1
```

#### 3.1.16 messages

```javascript
{
  _id: ObjectId,
  channelId: ObjectId, // references chatChannels (Phase 7)
  senderId: ObjectId, // references users
  senderName: String, // denormalised for cheap transcript rendering
  content: String, // sanitized plain text; nulled once soft-deleted
  isSystem: Boolean, // default false
  clientId: String, // client-generated idempotency key (retry guard)
  editedAt: Date | null,
  isDeleted: Boolean, // default false (soft delete)
  deletedAt: Date | null,
  deletedBy: ObjectId | null,
  createdAt: Date
}

Indexes:
- createdAt: -1 (owned by the sync change-cursor)
- senderId: 1
- { channelId: 1, createdAt: -1 } // channel history + cursor pagination
- { channelId: 1, clientId: 1 } unique, sparse // idempotent send
```

##### 3.1.16.1 chatChannels (Phase 7)

```javascript
{
  _id: ObjectId,
  key: String, // unique slug; `general` / `orders` / `content` are seeded
  name: String,
  description: String,
  isArchived: Boolean, // default false
  createdBy: ObjectId | null, // null for the three seeded channels
  createdAt: Date,
  updatedAt: Date
}

Indexes:
- key: 1 unique
- { isArchived: 1, updatedAt: -1 }
```

##### 3.1.16.2 chatChannelReads (Phase 7)

```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  channelId: ObjectId,
  lastReadAt: Date, // drives per-channel unread counts
  updatedAt: Date
}

Indexes:
- { userId: 1, channelId: 1 } unique
```

The three default channels are seeded and any pre-channel message is backfilled
into `general` on first touch (`ensureChatCollections`) — no separate migration
step is required.

#### 3.1.17 suppliers

```javascript
{
  _id: ObjectId,
  name: String,
  contactPerson: String,
  phone: String,
  email: String,
  city: String,
  address: String,
  productsSupplied: [String], // array of product names or categories
  notes: String,
  isActive: Boolean, // default true
  createdAt: Date,
  updatedAt: Date
}

Indexes:
- name: 1
- isActive: 1
- city: 1
```

#### 3.1.18 businessSettings

```javascript
{
  _id: ObjectId,
  profitSharing: {
    partners: [{
      userId: ObjectId,
      name: String,
      percentage: Number // e.g., 20
    }],
    charityPercentage: Number, // e.g., 20
    withdrawalLockedUntil: Date
  },
  expenseCategories: [String], // e.g., ['meta_ads', 'shopify', 'shipping', ...]
  paymentMethods: [String], // e.g., ['cod', 'bank_transfer', 'jazzcash']
  locations: [String], // e.g., ['sheikhupura', 'lahore']
  defaultCurrency: String, // 'PKR'
  timezone: String, // 'Asia/Karachi'
  budgetApprovalThreshold: Number, // paisa, optional
  lowStockThreshold: Number, // integer
  /** Phase 6: window (in minutes) after posting during which a comment's
   *  author may still edit or soft-delete it. Default 15. Founder-editable
   *  under Settings → Business. */
  commentEditWindowMinutes: Number,
  updatedAt: Date,
  updatedBy: ObjectId
}

Indexes:
- single document, _id fixed
```

#### 3.1.19 auditLog

```javascript
{
  _id: ObjectId,
  userId: ObjectId, // references users
  action: String, // e.g., 'create_order', 'update_expense', 'delete_task'
  entityType: String, // e.g., 'order', 'expense', 'task'
  entityId: ObjectId,
  oldValue: Object, // optional, snapshot before change
  newValue: Object, // optional, snapshot after change
  details: String, // human-readable description
  ipAddress: String, // optional
  userAgent: String, // optional
  createdAt: Date
}

Indexes:
- userId: 1
- action: 1
- entityType: 1, entityId: 1
- createdAt: -1
```

#### 3.1.20 offlineQueue

```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  operation: String, // e.g., 'create_order', 'update_expense'
  payload: Object, // the data to sync
  idempotencyKey: String, // unique per operation
  status: String, // 'pending', 'synced', 'failed', 'conflict'
  attempts: Number, // default 0
  lastAttemptAt: Date,
  errorMessage: String, // optional
  conflictData: Object, // optional, server state at conflict
  createdAt: Date,
  updatedAt: Date
}

Indexes:
- userId: 1, status: 1
- idempotencyKey: unique
- createdAt: -1
```

#### 3.1.21 notifications

```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  type: String, // e.g., 'low_stock', 'budget_exceeded', 'task_assigned'
  title: String,
  message: String,
  data: Object, // optional, related entity data
  isRead: Boolean, // default false
  readAt: Date,
  createdAt: Date
}

Indexes:
- userId: 1, isRead: 1
- createdAt: -1
```

### 3.2 Validation Rules

**Common validations:**

- All monetary fields: must be non-negative integers (paisa)
- All dates: must be valid ISO dates
- All required fields: must be present and non-empty
- All references: must exist in target collection

**Specific validations:**

- `users.email`: valid email format
- `products.sku`: alphanumeric with hyphens/underscores, unique
- `stock.quantity`: non-negative integer
- `orders.total`: sum of items + shipping cost
- `income.amount`: positive integer
- `expenses.amount`: positive integer
- `transfers.amount`: positive integer
- `profitDistributions.partnerShares[*].sharePercentage`: sum ≤ 100
- `businessSettings.profitSharing.partners[*].percentage`: sum ≤ 100

### 3.3 Relationships

- `users` → `roles` (role assignment)
- `stock` → `products` (many-to-one)
- `stockMovements` → `products` (many-to-one)
- `stockMovements` → `orders` (optional, via referenceId)
- `orders` → `users` (createdBy)
- `returns` → `orders` (many-to-one)
- `income` → `orders` (optional, via referenceId)
- `expenses` → `suppliers` (optional, many-to-one)
- `budgetActuals` → `budgets` (many-to-one)
- `profitDistributions` → `users` (approvedBy, createdBy)
- `profitShareAdjustments` → `profitDistributions` (many-to-one)
- `tasks` → `users` (assigneeIds[], createdBy, completedBy)
- `tasks` → `boards` (many-to-one)
- `tasks` → `columns` (many-to-one, current column)
- `taskComments` → `tasks` (many-to-one), → `users` (authorId, deletedBy)
- `taskActivity` → `tasks` (many-to-one), → `users` (actorId)
- `columns` → `boards` (many-to-one)
- `taskLabels` → (standalone; joined via `tasks.labelIds`)
- `messages` → `users` (senderId)
- `auditLog` → `users` (userId)
- `offlineQueue` → `users` (userId)
- `notifications` → `users` (userId)

---

## 4. Role-Permission Matrix

### 4.1 Default Roles

| Role             | Description                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Founder          | Full control over all modules and settings. Sole owner of board and column management (create/rename/archive boards, add/rename/reorder/archive columns). Can edit or archive any task, including others'.                                                                                                                      |
| Partner (Hasnat) | Create/update orders, record delivery outcomes/returns, record Lahore stock movements, view all dashboards/finance/budgets/inventory/sales. Tasks and chat are open: create, edit or move own, comment on any. Can edit or move others' tasks only if the corresponding permission is granted. Cannot manage boards or columns. |
| Partner (Ali)    | Record Lahore stock movements, view all dashboards/finance/budgets/inventory/sales. Tasks and chat are open on the same terms as Hasnat. Cannot manage boards or columns.                                                                                                                                                       |
| Partner (Afnan)  | View-only access to dashboards, finance, budgets, inventory, sales. Tasks and chat are still open on the same terms (create, edit or move own, comment on any) — the earlier "view-only on tasks and chat" line contradicted §4.2 and is corrected here. Cannot manage boards or columns.                                       |

### 4.2 Permission Matrix

| Module        | Action                    | Founder | Partner (Hasnat)               | Partner (Ali)            | Partner (Afnan) |
| ------------- | ------------------------- | ------- | ------------------------------ | ------------------------ | --------------- |
| **Finance**   |                           |         |                                |                          |                 |
|               | View                      | ✅      | ✅                             | ✅                       | ✅              |
|               | Create                    | ✅      | ❌                             | ❌                       | ❌              |
|               | Edit                      | ✅      | ❌                             | ❌                       | ❌              |
|               | Delete                    | ✅      | ❌                             | ❌                       | ❌              |
|               | Approve                   | ✅      | ❌                             | ❌                       | ❌              |
| **Budget**    |                           |         |                                |                          |                 |
|               | View                      | ✅      | ✅                             | ✅                       | ✅              |
|               | Create                    | ✅      | ❌                             | ❌                       | ❌              |
|               | Edit                      | ✅      | ❌                             | ❌                       | ❌              |
|               | Delete                    | ✅      | ❌                             | ❌                       | ❌              |
|               | Approve                   | ✅      | ❌                             | ❌                       | ❌              |
| **Inventory** |                           |         |                                |                          |                 |
|               | View                      | ✅      | ✅                             | ✅                       | ✅              |
|               | Create                    | ✅      | ❌ (except Lahore stock)       | ❌ (except Lahore stock) | ❌              |
|               | Edit                      | ✅      | ❌ (except Lahore stock)       | ❌ (except Lahore stock) | ❌              |
|               | Delete                    | ✅      | ❌                             | ❌                       | ❌              |
| **Sales**     |                           |         |                                |                          |                 |
|               | View                      | ✅      | ✅                             | ✅                       | ✅              |
|               | Create                    | ✅      | ✅                             | ❌                       | ❌              |
|               | Edit                      | ✅      | ✅ (delivery outcomes/returns) | ❌                       | ❌              |
|               | Delete                    | ✅      | ❌                             | ❌                       | ❌              |
| **Tasks**     |                           |         |                                |                          |                 |
|               | View                      | ✅      | ✅                             | ✅                       | ✅              |
|               | Create                    | ✅      | ✅                             | ✅                       | ✅              |
|               | Edit own                  | ✅      | ✅                             | ✅                       | ✅              |
|               | Edit any                  | ✅      | ❌*                            | ❌*                      | ❌*             |
|               | Move (drag) own           | ✅      | ✅                             | ✅                       | ✅              |
|               | Move (drag) any           | ✅      | ❌*                            | ❌*                      | ❌*             |
|               | Comment                   | ✅      | ✅                             | ✅                       | ✅              |
|               | Edit/Delete own comment   | ✅      | ✅                             | ✅                       | ✅              |
|               | Delete/Archive own task   | ✅      | ✅                             | ✅                       | ✅              |
|               | Archive any task          | ✅      | ❌                             | ❌                       | ❌              |
|               | Manage boards and columns | ✅      | ❌                             | ❌                       | ❌              |
| **Chat**      |                           |         |                                |                          |                 |
|               | View                      | ✅      | ✅                             | ✅                       | ✅              |
|               | Create                    | ✅      | ✅                             | ✅                       | ✅              |
|               | Edit                      | ✅      | ✅                             | ✅                       | ✅              |
|               | Delete                    | ✅      | ✅                             | ✅                       | ✅              |
| **Suppliers** |                           |         |                                |                          |                 |
|               | View                      | ✅      | ✅                             | ✅                       | ✅              |
|               | Create                    | ✅      | ❌                             | ❌                       | ❌              |
|               | Edit                      | ✅      | ❌                             | ❌                       | ❌              |
|               | Delete                    | ✅      | ❌                             | ❌                       | ❌              |
| **Settings**  |                           |         |                                |                          |                 |
|               | View                      | ✅      | ❌                             | ❌                       | ❌              |
|               | Edit                      | ✅      | ❌                             | ❌                       | ❌              |
| **Users**     |                           |         |                                |                          |                 |
|               | View                      | ✅      | ❌                             | ❌                       | ❌              |
|               | Create                    | ✅      | ❌                             | ❌                       | ❌              |
|               | Edit                      | ✅      | ❌                             | ❌                       | ❌              |
|               | Delete                    | ✅      | ❌                             | ❌                       | ❌              |

Notes on the Tasks rows:

- ❌\* marks actions that are off by default for that role but can be granted per-role through the Settings → Permissions editor (Founder-only screen). The Phase 6 server checks these on every route via `authorize('tasks', <action>)` and, where the action targets another member's task, additionally verifies the grant.
- Board and column management (`manage`) is not grantable — Founder only. The board's default columns (To Do, In Progress, Review, Done) are seeded at board creation and remain editable only by the Founder.

### 4.3 Enforcement

All permission checks are enforced on the server:

- API endpoints validate user role and permissions before executing operations
- Role assignment can only be modified by Founder
- Permissions are stored in the `roles` collection and cached in memory for performance
- Audit log records all permission-denied attempts for security monitoring

---

## 5. Financial Formulas

### 5.1 Revenue

**Formula:**

```
Revenue = Sum of all order totals for the period
```

**Numeric Example:**

- Order 1: PKR 5,000 (5 items × PKR 1,000 each)
- Order 2: PKR 3,500 (1 item × PKR 3,500)
- Order 3: PKR 7,200 (3 items × PKR 2,400 each)

```
Revenue = 5,000 + 3,500 + 7,200 = PKR 15,700
```

### 5.2 Net Sales

**Formula:**

```
Net Sales = Revenue - Returns - Refunds
```

**Numeric Example:**

- Revenue: PKR 15,700
- Returns: PKR 2,000 (2 items returned)
- Refunds: PKR 500 (partial refund on damaged item)

```
Net Sales = 15,700 - 2,000 - 500 = PKR 13,200
```

### 5.3 Cost of Goods Sold (COGS)

**Formula:**

```
COGS = Sum of (sold quantity × weighted average cost at time of sale)
```

**Weighted Average Cost Calculation:**

```
Weighted Average Cost = Total Cost of Inventory / Total Quantity in Inventory
```

**Numeric Example:**

- Initial stock: 10 units at PKR 500 each = PKR 5,000
- Purchase 1: 5 units at PKR 600 each = PKR 3,000
- Total cost: PKR 8,000
- Total quantity: 15 units
- Weighted average cost: 8,000 / 15 = PKR 533.33 per unit

- Sold: 8 units
- COGS = 8 × 533.33 = PKR 4,266.64

### 5.4 Gross Profit

**Formula:**

```
Gross Profit = Net Sales - COGS
```

**Numeric Example:**

- Net Sales: PKR 13,200
- COGS: PKR 4,266.64

```
Gross Profit = 13,200 - 4,266.64 = PKR 8,933.36
```

### 5.5 Net Profit

**Formula:**

```
Net Profit = Gross Profit - Operating Expenses
```

**Numeric Example:**

- Gross Profit: PKR 8,933.36
- Operating Expenses:
  - Meta Ads: PKR 2,000
  - Shopify: PKR 500
  - Shipping: PKR 1,500
  - Packaging: PKR 800
  - Total Expenses: PKR 4,800

```
Net Profit = 8,933.36 - 4,800 = PKR 4,133.36
```

### 5.6 Cash Balance

**Formula:**

```
Cash Balance = Opening Balance + Cash Inflows - Cash Outflows
```

Where:

- Cash Inflows = Income (COD received, bank transfers, etc.)
- Cash Outflows = Expenses (paid) + Withdrawals + Transfers out
- Transfers between accounts are NOT cash inflows or outflows

**Numeric Example:**

- Opening Balance: PKR 50,000
- Cash Inflows:
  - COD received: PKR 15,000
  - Bank transfer: PKR 5,000
  - Total Inflows: PKR 20,000
- Cash Outflows:
  - Expenses paid: PKR 4,800
  - Withdrawals: PKR 0 (locked)
  - Total Outflows: PKR 4,800

```
Cash Balance = 50,000 + 20,000 - 4,800 = PKR 65,200
```

### 5.7 Inventory Valuation

**Formula:**

```
Inventory Value = Sum of (current quantity × weighted average cost) per product
```

**Numeric Example:**

- Product A: 7 units × PKR 533.33 = PKR 3,733.31
- Product B: 5 units × PKR 800 = PKR 4,000
- Product C: 3 units × PKR 1,200 = PKR 3,600

```
Total Inventory Value = 3,733.31 + 4,000 + 3,600 = PKR 11,333.31
```

### 5.8 Reinvestment

**Formula:**

```
Reinvestment = Sum of (partner share × reinvestment percentage per partner)
```

**Numeric Example:**

- Partner 1 share: PKR 826.67 (20% of PKR 4,133.36)
- Partner 1 reinvestment: 100% = PKR 826.67
- Partner 2 share: PKR 826.67
- Partner 2 reinvestment: 50% = PKR 413.33
- Partner 3 share: PKR 826.67
- Partner 3 reinvestment: 100% = PKR 826.67
- Partner 4 share: PKR 826.67
- Partner 4 reinvestment: 0% = PKR 0

```
Total Reinvestment = 826.67 + 413.33 + 826.67 + 0 = PKR 2,066.67
```

### 5.9 Retained Earnings

**Formula:**

```
Retained Earnings = Cumulative Net Profit - Cumulative Distributions - Cumulative Withdrawals
```

**Numeric Example:**

- Cumulative Net Profit (Month 1): PKR 4,133.36
- Cumulative Distributions: PKR 0 (withdrawals locked)
- Cumulative Withdrawals: PKR 0

```
Retained Earnings = 4,133.36 - 0 - 0 = PKR 4,133.36
```

### 5.10 Returns and Refunds

**Formula:**

```
Return Impact = (Returned Item Value × Refund Percentage) + Return Processing Costs
```

**Numeric Example:**

- Returned item selling price: PKR 1,000
- Refund percentage: 100% (full refund)
- Return processing cost (courier): PKR 200

```
Return Impact = (1,000 × 1.0) + 200 = PKR 1,200
```

---

## 6. Offline Sync Strategy

### 6.1 Architecture Overview

The offline sync strategy uses a local queue-based approach with idempotency keys to ensure data consistency across devices.

**Components:**

1. **Local Queue (IndexedDB):** Stores pending operations while offline
2. **Idempotency Keys:** Unique identifiers for each operation to prevent duplicate execution
3. **Sync Status Tracking:** pending → synced → failed → conflict
4. **Conflict Resolution:** Manual intervention for financial data conflicts

### 6.2 Operation Flow

#### 6.2.1 Online Flow

```
User Action → Server API → Database → Success Response → Update UI
```

#### 6.2.2 Offline Flow

```
User Action → Add to Local Queue (status: pending) → Update UI (optimistic)
→ Background Sync Attempts → On Success: Mark synced → On Failure: Mark failed
→ On Conflict: Mark conflict, show resolution UI
```

### 6.3 Queue Schema (IndexedDB)

```javascript
{
  id: string, // local UUID
  operation: string, // 'create_order', 'update_expense', 'delete_task'
  payload: object, // the data to sync
  idempotencyKey: string, // unique per operation (e.g., `${userId}_${operation}_${timestamp}_${random}`)
  status: 'pending' | 'synced' | 'failed' | 'conflict',
  attempts: number,
  lastAttemptAt: Date,
  errorMessage: string,
  conflictData: object, // server state at time of conflict
  createdAt: Date,
  updatedAt: Date
}
```

### 6.4 Idempotency Key Generation

**Format:**

```
${userId}_${entityType}_${operation}_${timestamp}_${random}
```

**Example:**

```
user123_order_create_1728038400000_abc123
```

### 6.5 Sync Statuses

| Status   | Description                                | Action                               |
| -------- | ------------------------------------------ | ------------------------------------ |
| Pending  | Operation queued, not yet synced           | Auto-retry on next sync cycle        |
| Synced   | Operation successfully synced with server  | Remove from queue after confirmation |
| Failed   | Sync failed due to network or server error | Auto-retry with exponential backoff  |
| Conflict | Sync failed due to data conflict           | Manual resolution required           |

### 6.6 Conflict Handling

**Conflict Detection:**

- Server validates idempotency key on each request
- If idempotency key exists but data differs, conflict is detected
- Server returns current state and client detects conflict

**Conflict Resolution:**

1. **Task moves and edits:** Optimistic-concurrency with a version field. Every task document carries `version: Number` (starting at 1, incremented server-side on each successful write). Clients send `version` on `PATCH /api/tasks/[id]` and on `POST /api/tasks/[id]/move`. If the stored version has advanced, the server returns `409 Conflict` with the current document; the client shows a clear toast — "Someone moved this card. Refreshed." — rolls back the optimistic change and re-fetches. Never a silent overwrite; never a lost card. Column reordering follows the same rule per board.
2. **Chat messages:** Append-only and non-conflicting (last-write wins is safe because each message is a new document). Auto-merge.
3. **Financial data:** Always require manual resolution.
   - Show both versions (local vs server)
   - Allow user to choose which to keep
   - Or create a reversal entry for the server version and apply local version
   - Or discard local changes and keep server version

**Conflict Resolution UI:**

```
┌─────────────────────────────────────────┐
│ Sync Conflict Detected                   │
├─────────────────────────────────────────┤
│ This expense was modified by another user│
│                                         │
│ Your Version:                           │
│ Amount: PKR 5,000                       │
│ Category: Shipping                      │
│                                         │
│ Server Version:                         │
│ Amount: PKR 5,500                       │
│ Category: Shipping                      │
│                                         │
│ [Keep My Version]  [Keep Server]  [Cancel]│
└─────────────────────────────────────────┘
```

### 6.7 Sync Algorithm

**Automatic Sync:**

- Triggered on: app foreground, network reconnection, every 5 minutes when online
- Process: Send all pending operations in batch
- Batching: Group up to 10 operations per request to reduce overhead

**Retry Logic:**

- Attempt 1: Immediate
- Attempt 2: 5 seconds later
- Attempt 3: 30 seconds later
- Attempt 4: 5 minutes later
- Attempt 5: 30 minutes later
- After 5 failures: Mark as failed, notify user

**Exponential Backoff:**

```
delay = baseDelay × (2 ^ (attempts - 1))
where baseDelay = 5 seconds
```

### 6.8 Data Consistency Guarantees

**Idempotency:**

- Each operation is executed exactly once on the server
- Duplicate requests with same idempotency key return the same result
- No side effects from retries

**Ordering:**

- Operations within the same entity are processed in creation order
- Use timestamps to sequence operations

**Atomicity:**

- Financial operations are wrapped in database transactions
- If any part fails, entire operation is rolled back

### 6.9 Offline Capabilities

**Supported Offline Operations:**

- Create orders
- Create expenses
- Create tasks
- Create chat messages
- Update tasks (status, assignee)
- Update own user profile

**Blocked Offline Operations:**

- Delete operations (require server confirmation)
- Permission changes (require online)
- Role assignments (require online)
- Budget approvals (require online)
- Profit distribution calculations (require online)

### 6.10 Data Freshness

**Stale Data Detection:**

- Each entity has `updatedAt` timestamp
- Client tracks last sync timestamp per entity type
- On sync, client requests all changes since last sync

**Cache Invalidation:**

- Real-time updates via WebSocket when online
- When offline, show "Last synced: X minutes ago" indicator
- After sync, refresh all displayed data

---

## 7. Real-Time Architecture

### 7.1 Approach

> **Implementation status (Phase 7):** the shipping design — SSE driven by a
> MongoDB change stream with an automatic per-module cursor-polling fallback —
> is documented authoritatively in [`docs/REALTIME.md`](./REALTIME.md). Where
> the illustrative snippets below differ from what was built (per-record event
> payloads, a 30s poll), `REALTIME.md` is correct. The live stream carries
> **dataless change signals** ("module X advanced") rather than record data, so
> a user is never sent information their permissions would hide; the client
> reacts by re-fetching through the same guarded REST routes it uses normally.

Given free tier constraints, use **Server-Sent Events (SSE)** for real-time updates instead of WebSockets.

**Rationale:**

- SSE is simpler to implement
- Works better with HTTP/2 and modern browsers
- Easier to scale on free hosting tiers
- Sufficient for one-way server → client updates
- No need for bidirectional communication (client → server uses standard HTTP API)

### 7.2 Implementation

**Server-Side (Next.js API Route):**

```typescript
// /api/events/route.ts
export async function GET(request: Request) {
  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection message
      controller.enqueue(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)

      // Subscribe to database change events
      const unsubscribe = subscribeToChanges((change) => {
        controller.enqueue(`data: ${JSON.stringify(change)}\n\n`)
      })

      // Cleanup on disconnect
      request.signal.addEventListener('abort', () => {
        unsubscribe()
        controller.close()
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
```

**Client-Side:**

```typescript
const eventSource = new EventSource('/api/events')

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data)
  // Update UI based on event type
  switch (data.type) {
    case 'order_created':
      // Update orders list
      break
    case 'expense_updated':
      // Update expenses list
      break
    // ... other event types
  }
}
```

### 7.3 Event Types

| Event Type        | Payload                                | Triggers UI Update       |
| ----------------- | -------------------------------------- | ------------------------ |
| `order_created`   | `{ orderId, orderData }`               | Orders list, dashboard   |
| `order_updated`   | `{ orderId, changes }`                 | Orders list, dashboard   |
| `expense_created` | `{ expenseId, expenseData }`           | Expenses list, dashboard |
| `expense_updated` | `{ expenseId, changes }`               | Expenses list, dashboard |
| `stock_changed`   | `{ productId, location, quantity }`    | Stock screens, dashboard |
| `task_created`    | `{ taskId, taskData }`                 | Tasks board              |
| `task_updated`    | `{ taskId, changes }`                  | Tasks board              |
| `message_sent`    | `{ messageId, messageData }`           | Chat screen              |
| `notification`    | `{ notificationId, notificationData }` | Notification bell        |

### 7.4 Free Tier Limitations

**Vercel (Free Tier):**

- Serverless functions have 10-second timeout
- SSE connections may timeout after 60 seconds of inactivity
- Auto-reconnect logic required on client

**MongoDB Atlas (Free Tier):**

- Change Streams are supported on M0 cluster
- No real-time triggers (server must poll or use Change Streams)
- Use MongoDB Change Streams for real-time database events

**Change Stream Implementation:**

```typescript
const changeStream = db.collection('orders').watch()

changeStream.on('change', (change) => {
  // Broadcast to all connected SSE clients
  broadcastToClients({
    type: 'order_updated',
    data: change,
  })
})
```

### 7.5 Fallback Strategy

Polling is the **automatic** fallback that activates by itself whenever a live
SSE stream cannot be established or delivered (paused host, buffering proxy,
resume gap, `EventSource` unavailable, hard close). Both transports emit the
same per-module cursor shape, so switching is transparent to subscribers.

- Poll the change-cursor endpoint every **6 seconds** (3s floor) — not 30s; a
  30s gap felt dead for chat. `GET /api/sync/cursor?modules=…` answers only
  "has this module changed?" with a timestamp, never row data.
- Pause while the tab is hidden; fire immediately on `online` and on becoming
  visible so a reconnect reconciles without waiting for the next tick.

### 7.6 Connection Management

**Client-Side:**

- Auto-reconnect on disconnect with exponential backoff (3s base, capped at 60s)
- Resume from the last received event via `Last-Event-ID` (bounded server replay
  buffer; a gap triggers one reconciling poll) — no missed or duplicated events
- Show a visible connection status: Live / Live · syncing (poll carrier) /
  Connecting… / Reconnecting… / Offline
- Tear every stream, timer and listener down on unmount and logout

**Server-Side:**

- Authentication and per-module `view` scope resolved **on connect**; an
  unauthenticated request is a `401` JSON error (never a stream), an
  all-modules-refused session is `403`
- Heartbeat comment frame every 20s to keep proxies from closing an idle stream
- Runs on the Node runtime on a single persistent host (see `REALTIME.md`);
  the replay buffer and rate limiter are process-local

### 7.7 Chat Module Real-Time Behaviour (Phase 7)

- Channels `General` / `Orders` / `Content` are seeded on first touch; the
  Founder can create and archive channels and moderate any message.
- History uses cursor pagination (load-older on scroll-up without scroll jump);
  the incremental tail is fetched with `since=<epoch-ms>`.
- Sends carry a client-generated `clientId` and are idempotent, so a retry after
  a dropped response can never duplicate. Messages have sent / failed / retry
  states, per-channel unread counts and last-read watermarks.
- Edit and delete are own-message, time-boxed by the settings edit window (the
  Founder moderator is exempt), soft-deleted, and audit-logged. Content is
  sanitized to plain text. Sends are rate-limited per `(user, channel)`.
- Chat is online-only: offline shows a banner, disables sending and keeps the
  draft; missed messages are re-fetched on reconnect.

---

## 8. Deployment Plan

### 8.1 Hosting Providers

**Application Hosting: Vercel (Free Tier)**

- Next.js native support
- Automatic deployments from Git
- Free SSL certificates
- Edge network for global performance
- Limitations: 10-second function timeout, 100GB bandwidth/month

**Database: MongoDB Atlas (Free M0 Cluster)**

- 512MB storage
- Shared RAM
- Geo-distributed (choose region closest to Pakistan: Mumbai)
- Limitations: No automated backups, connection pooling restrictions

**Asset Storage: Vercel Blob (Free Tier)**

- For storing exported backup files
- 1GB storage limit
- Direct file uploads/downloads

### 8.2 Environment Variables

**Required Variables:**

```env
MONGODB_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/decoricks
NEXTAUTH_SECRET=<random-secret>
NEXTAUTH_URL=https://decoricks-app.vercel.app
NODE_ENV=production
```

**Optional Variables:**

```env
BACKUP_SCHEDULE=0 2 * * * # Daily at 2 AM Karachi time
BACKUP_RETENTION_DAYS=30
```

### 8.3 Deployment Steps

**1. Prepare Repository:**

```bash
git init
git add .
git commit -m "Initial commit"
```

**2. Connect to Vercel:**

- Install Vercel CLI: `npm i -g vercel`
- Login: `vercel login`
- Deploy: `vercel`

**3. Configure Environment Variables:**

- In Vercel dashboard, add environment variables
- Set MongoDB connection string
- Generate NEXTAUTH_SECRET: `openssl rand -base64 32`

**4. Setup MongoDB Atlas:**

- Create free M0 cluster
- Create database user with read/write permissions
- Whitelist Vercel IP addresses (or use 0.0.0.0/0 for simplicity)
- Get connection string

**5. Deploy:**

```bash
vercel --prod
```

**6. Configure Custom Domain (Optional):**

- Add domain in Vercel dashboard
- Update DNS records

### 8.4 CI/CD Pipeline

**GitHub Actions (Free Tier):**

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - run: npm ci
      - run: npm run build
      - run: npm test
      - uses: amondnet/vercel-action@v20
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.ORG_ID }}
          vercel-project-id: ${{ secrets.PROJECT_ID }}
          vercel-args: '--prod'
```

### 8.5 Monitoring

**Free Tier Monitoring:**

- Vercel Analytics (free)
- MongoDB Atlas Metrics (free)
- Custom error logging to MongoDB (auditLog collection)

**Health Checks:**

- `/api/health` endpoint
- Checks database connectivity
- Returns status and uptime

### 8.6 Backup Strategy

**Manual Backup:**

- "Export Now" button triggers server-side export
- Export format: JSON dump of all collections
- Stored in Vercel Blob
- Downloadable by Founder

**Scheduled Backup:**

- Cron job (Vercel Cron Jobs) triggers export at scheduled time
- Same export process as manual
- Stored with timestamp in filename

**Restore Procedure:**

1. Download backup file from Vercel Blob
2. Upload to restore endpoint (Founder-only)
3. Server validates backup format
4. Server drops existing collections (after confirmation)
5. Server imports backup data
6. Server rebuilds indexes
7. Confirmation message

**Restore Documentation:**

- Step-by-step guide in Settings → Data Export/Backup
- Warning about data loss
- Recommendation to test restore on staging environment first

---

## 9. Free Tier Limitations and Hidden Costs

### 9.1 MongoDB Atlas Free Tier (M0 Cluster)

**Limitations:**

- **Storage:** 512MB total (may be insufficient for long-term audit logs)
- **RAM:** Shared, no guaranteed performance
- **Connections:** Max 500 simultaneous connections
- **Backups:** NO automated backups (manual export required)
- **Restore:** Point-in-time restore not available
- **Performance:** Slower during peak hours (shared resources)
- **Change Streams:** Supported but may have latency

**Hidden Costs/Risks:**

- **Data Loss Risk:** No automated backups means manual backup failure = data loss
- **Storage Exhaustion:** 512MB may fill up with audit logs over time
- **Connection Limits:** May hit 500 connection limit with multiple users + real-time connections
- **Regional Latency:** Mumbai region adds ~50-100ms latency from Pakistan
- **Maintenance:** MongoDB may restart cluster without notice

**Mitigation:**

- Regular manual exports (daily recommended)
- Implement audit log rotation (archive old logs to file exports)
- Use connection pooling to minimize connections
- Monitor storage usage and alert at 80% capacity

### 9.2 Vercel Free Tier

**Limitations:**

- **Function Timeout:** 10 seconds (may not be sufficient for large exports)
- **Execution Time:** 10,000 minutes/month (may be insufficient for heavy usage)
- **Bandwidth:** 100GB/month (may be insufficient for backup downloads/uploads)
- **Serverless Functions:** Cold starts on first request (1-2 second delay)
- **Build Time:** 6,000 minutes/month
- **Team Members:** Unlimited on Hobby plan

**Hidden Costs/Risks:**

- **Cold Starts:** First request after inactivity has 1-2 second delay
- **Function Timeout:** Large backup exports may timeout
- **Execution Limit:** Heavy real-time sync may hit execution time limit
- **Bandwidth Limit:** Frequent backup downloads may exceed 100GB
- **WebSocket Support:** Vercel does not support raw WebSockets (use SSE instead)

**Mitigation:**

- Use streaming responses for large exports
- Implement server-side batching for exports
- Optimize sync frequency to reduce execution time
- Compress backup files before download
- Use SSE instead of WebSockets

### 9.3 iOS Push Notification Limits

**Free Tier Limitations:**

- Apple Push Notification Service (APNs) requires paid Apple Developer Program ($99/year)
- Free tier: No push notifications on iOS
- Background Sync: iOS restricts background processing (max 30 seconds, infrequent)

**Mitigation:**

- Rely on in-app notifications when app is open
- Use badge count updates (limited support)
- Implement polling when app is foregrounded
- Document that iOS push notifications require paid developer account

### 9.4 Background Sync Limits

**iOS:**

- Background execution limited to 30 seconds
- Background sync only triggered by system (not app-controlled)
- Silent push notifications require paid developer account
- Background fetch is infrequent and unpredictable

**Android:**

- WorkManager API for background tasks
- More flexible than iOS
- Doze mode may restrict background execution

**Web (PWA):**

- Service Workers support background sync
- Requires HTTPS
- Not supported on all browsers (Safari partial support)

**Mitigation:**

- Sync on app foreground (user opens app)
- Use optimistic UI updates while offline
- Queue operations and sync when next online
- Show "sync pending" indicator

### 9.5 Summary of Free Tier Risks

| Risk                       | Impact                           | Probability          | Mitigation                          |
| -------------------------- | -------------------------------- | -------------------- | ----------------------------------- |
| MongoDB storage exhaustion | App stops working                | Medium (6-12 months) | Regular exports, log rotation       |
| No automated backups       | Data loss if manual backup fails | High                 | Daily exports, dual backup strategy |
| Function timeout           | Large exports fail               | Medium               | Streaming, batching                 |
| Execution time limit       | Rate limiting                    | Low                  | Optimize sync frequency             |
| Bandwidth limit            | Cannot download backups          | Low                  | Compress files                      |
| Cold starts                | Slow first request               | High                 | Acceptable trade-off                |
| No iOS push                | Poor UX on iOS                   | High                 | In-app notifications only           |
| Background sync limits     | Delayed sync                     | High                 | Sync on foreground                  |

---

## 10. Security Threat Model and Test Plan

### 10.1 Threat Model

#### 10.1.1 Authentication Threats

**Threat 1: Credential Stuffing**

- **Description:** Attacker uses leaked passwords from other breaches to access accounts
- **Impact:** Unauthorized access to sensitive financial data
- **Mitigation:**
  - Strong password policy (min 12 characters, complexity required)
  - Rate limiting on login attempts (5 attempts per 15 minutes)
  - Account lockout after 10 failed attempts
  - Session timeout after 30 minutes of inactivity

**Threat 2: Session Hijacking**

- **Description:** Attacker steals session token to impersonate user
- **Impact:** Unauthorized access under user's identity
- **Mitigation:**
  - HttpOnly, Secure, SameSite cookies
  - Short session expiration (30 minutes)
  - Regenerate session ID on login
  - IP-based session validation (optional)

**Threat 3: Password Reset Abuse**

- **Description:** Attacker triggers password reset to take over account
- **Impact:** Account takeover
- **Mitigation:**
  - Password reset links expire after 1 hour
  - Send reset notification to user's registered email
  - Require old password for sensitive actions (optional)

#### 10.1.2 Authorization Threats

**Threat 4: Privilege Escalation**

- **Description:** Attacker gains higher privileges than assigned
- **Impact:** Unauthorized modification of financial data, settings
- **Mitigation:**
  - Server-side permission checks on every API endpoint
  - Role changes require Founder approval
  - Audit log all permission changes
  - No client-side permission enforcement (security by obscurity)

**Threat 5: Horizontal Privilege Escalation**

- **Description:** User accesses another user's data
- **Impact:** Data breach, privacy violation
- **Mitigation:**
  - Always filter data by user ID on server
  - Validate ownership before read/write operations
  - Use row-level security in database queries

#### 10.1.3 Data Integrity Threats

**Threat 6: SQL/NoSQL Injection**

- **Description:** Attacker injects malicious queries to manipulate database
- **Impact:** Data corruption, unauthorized data access
- **Mitigation:**
  - Use parameterized queries (Mongoose ORM provides this)
  - Validate and sanitize all user inputs
  - Never concatenate user input into queries
  - Use MongoDB's built-in injection protection

**Threat 7: Mass Assignment**

- **Description:** Attacker sends unexpected fields to update sensitive data
- **Impact:** Unauthorized modification of restricted fields
- **Mitigation:**
  - Explicitly define allowed fields in update operations
  - Use Mongoose schemas to enforce field validation
  - Never pass request body directly to update operations

#### 10.1.4 Data Confidentiality Threats

**Threat 8: Data in Transit Interception**

- **Description:** Attacker eavesdrops on network traffic
- **Impact:** Sensitive data (passwords, financial data) exposed
- **Mitigation:**
  - Enforce HTTPS everywhere (TLS 1.2+)
  - HSTS header to prevent downgrade attacks
  - No sensitive data in URL parameters

**Threat 9: Data at Rest Exposure**

- **Description:** Database compromised, sensitive data exposed
- **Impact:** Financial data, passwords exposed
- **Mitigation:**
  - Passwords hashed with bcrypt (cost factor 12)
  - MongoDB Atlas encryption at rest (enabled by default)
  - No sensitive data in logs
  - Backup files encrypted (optional)

#### 10.1.5 Availability Threats

**Threat 10: DoS Attack**

- **Description:** Attacker overwhelms server with requests
- **Impact:** App unavailable, business disruption
- **Mitigation:**
  - Rate limiting per IP (100 requests/minute)
  - Rate limiting per user (200 requests/minute)
  - Vercel's built-in DDoS protection
  - Implement caching for read-heavy operations

**Threat 11: Resource Exhaustion**

- **Description:** Attacker triggers expensive operations to exhaust resources
- **Impact:** Server slowdown, timeouts
- **Mitigation:**
  - Query timeouts (5 seconds max)
  - Pagination for all list endpoints (max 100 items per page)
  - Limits on file upload sizes (10MB max)
  - Input validation to prevent infinite loops

#### 10.1.6 Audit Trail Threats

**Threat 12: Audit Log Tampering**

- **Description:** Attacker modifies or deletes audit logs
- **Impact:** Loss of accountability, undetected fraud
- **Mitigation:**
  - Audit logs are append-only (no updates/deletes)
  - Audit log creation requires database transaction
  - Critical audit logs also sent to external service (optional)
  - Regular integrity checks

### 10.2 Security Test Plan

#### 10.2.1 Authentication Testing

**Test 1: Password Strength Enforcement**

- **Objective:** Verify weak passwords are rejected
- **Steps:**
  1. Attempt to create account with password "123456"
  2. Attempt to create account with password "password"
  3. Attempt to create account with password < 12 characters
- **Expected Result:** All attempts rejected with error message

**Test 2: Rate Limiting on Login**

- **Objective:** Verify account lockout after failed attempts
- **Steps:**
  1. Attempt login with wrong password 5 times
  2. Attempt 6th login
- **Expected Result:** Account locked for 15 minutes

**Test 3: Session Timeout**

- **Objective:** Verify session expires after inactivity
- **Steps:**
  1. Login to account
  2. Wait 31 minutes without activity
  3. Attempt to access protected endpoint
- **Expected Result:** Redirected to login page

#### 10.2.2 Authorization Testing

**Test 4: Permission Enforcement on API**

- **Objective:** Verify unauthorized access is blocked
- **Steps:**
  1. Login as Partner (Afnan - view-only)
  2. Attempt to create expense via API
  3. Attempt to update order via API
  4. Attempt to delete task via API
- **Expected Result:** All requests return 403 Forbidden

**Test 5: Horizontal Access Control**

- **Objective:** Verify users cannot access other users' data
- **Steps:**
  1. Login as User A
  2. Attempt to fetch User B's profile via API
  3. Attempt to fetch User B's tasks via API
- **Expected Result:** All requests return 403 Forbidden or 404 Not Found

**Test 6: Role Modification Protection**

- **Objective:** Verify only Founder can modify roles
- **Steps:**
  1. Login as Partner (Hasnat)
  2. Attempt to modify own role via API
  3. Attempt to grant permissions to self via API
- **Expected Result:** All requests return 403 Forbidden

#### 10.2.3 Data Integrity Testing

**Test 7: NoSQL Injection**

- **Objective:** Verify NoSQL injection attempts are blocked
- **Steps:**
  1. Send login request with username: `{"$ne": null}`
  2. Send search request with malicious query operators
  3. Send update request with `$set` operator in user input
- **Expected Result:** All requests rejected or sanitized

**Test 8: Mass Assignment**

- **Objective:** Verify unexpected fields are rejected
- **Steps:**
  1. Send update request with `role: "founder"` field
  2. Send update request with `isAdmin: true` field
  3. Send update request with `balance: 1000000` field
- **Expected Result:** All requests return 400 Bad Request or ignore fields

**Test 9: Financial Data Immutability**

- **Objective:** Verify financial records cannot be silently edited
- **Steps:**
  1. Create expense record
  2. Attempt to update expense amount via API
  3. Attempt to delete expense via API
- **Expected Result:** Update rejected (must use reversal), delete rejected (must use reversal)

#### 10.2.4 Data Confidentiality Testing

**Test 10: HTTPS Enforcement**

- **Objective:** Verify all traffic uses HTTPS
- **Steps:**
  1. Attempt to access app via HTTP
  2. Check response headers for HSTS
- **Expected Result:** Redirect to HTTPS, HSTS header present

**Test 11: Password Hashing**

- **Objective:** Verify passwords are hashed in database
- **Steps:**
  1. Create account with password "TestPassword123!"
  2. Query database for user document
  3. Check passwordHash field
- **Expected Result:** passwordHash is bcrypt hash, not plaintext

**Test 12: Sensitive Data in Logs**

- **Objective:** Verify sensitive data is not logged
- **Steps:**
  1. Create expense with large amount
  2. Check server logs
  3. Check audit log
- **Expected Result:** No plaintext passwords or full card numbers in logs

#### 10.2.5 Availability Testing

**Test 13: Rate Limiting**

- **Objective:** Verify rate limiting prevents abuse
- **Steps:**
  1. Send 101 requests to API endpoint within 1 minute
  2. Check response status
- **Expected Result:** Request 101 returns 429 Too Many Requests

**Test 14: Query Timeout**

- **Objective:** Verify long-running queries timeout
- **Steps:**
  1. Send request with large pagination (page=1, limit=10000)
  2. Send request with complex filter that scans all documents
- **Expected Result:** Request times out after 5 seconds

**Test 15: File Upload Limits**

- **Objective:** Verify large file uploads are rejected
- **Steps:**
  1. Attempt to upload 20MB file
  2. Attempt to upload file with invalid extension
- **Expected Result:** Upload rejected with error message

#### 10.2.6 Audit Trail Testing

**Test 16: Audit Log Creation**

- **Objective:** Verify all critical actions are logged
- **Steps:**
  1. Create expense
  2. Update order
  3. Delete task
  4. Check audit log
- **Expected Result:** All 3 actions present in audit log with correct details

**Test 17: Audit Log Immutability**

- **Objective:** Verify audit logs cannot be modified
- **Steps:**
  1. Attempt to update audit log entry via API
  2. Attempt to delete audit log entry via API
- **Expected Result:** All requests return 403 Forbidden

**Test 18: Audit Log Completeness**

- **Objective:** Verify audit log includes all required fields
- **Steps:**
  1. Perform critical action
  2. Check audit log entry
- **Expected Result:** Entry includes userId, action, entityType, entityId, oldValue, newValue, timestamp

### 10.3 Security Best Practices Implementation

**1. Environment Variables:**

- Never commit secrets to Git
- Use `.env.local` for local development
- Use Vercel environment variables for production
- Rotate secrets regularly

**2. Dependency Management:**

- Run `npm audit` regularly
- Keep dependencies updated
- Review security advisories
- Use `npm ci` for consistent installs

**3. Code Review:**

- All code changes reviewed before merge
- Security-focused review for sensitive modules
- Use automated security scanning (Snyk, Dependabot)

**4. Monitoring:**

- Monitor for failed login attempts
- Monitor for unusual API usage patterns
- Alert on audit log anomalies
- Regular security log review

**5. Incident Response:**

- Document incident response procedure
- Have contact information for all team members
- Plan for data restoration from backups
- Test restore procedure quarterly

---

## 11. Open Questions for Future Phases

The following business policies were not defined in Phase 0 and should be addressed before implementation or made configurable:

1. **Profit sharing adjustments:** Should there be an automated approval workflow for manual profit share adjustments, or is Founder-only approval sufficient?

2. **Budget approval workflow:** If budget approval threshold is enabled, who approves budgets below threshold vs above threshold?

3. **Supplier credit terms:** Should supplier credit tracking (payment due dates, outstanding balances) be included in a future phase?

4. **Customer credit:** If offering credit to customers in the future, how should it be tracked and managed?

5. **Multi-currency support:** If expanding to international sales, should the app support multiple currencies?

6. **Tax registration:** If Decoricks registers for tax in the future, how should tax collection and remittance be integrated?

7. **Partner onboarding:** If adding new partners in the future, how should their permissions and profit shares be configured?

8. **Charity partner:** Which charity receives the 20% share, and should there be documentation/receipt tracking?

9. **Inventory forecasting:** Should the app include demand forecasting and reorder point calculations?

10. **Sales commission:** If adding sales staff or affiliates, how should commissions be calculated and tracked?

---

## 12. Summary of Risks

### 12.1 Technical Risks

| Risk                               | Severity | Likelihood | Mitigation                                 |
| ---------------------------------- | -------- | ---------- | ------------------------------------------ |
| MongoDB storage exhaustion (512MB) | High     | Medium     | Implement log rotation, regular exports    |
| No automated backups               | Critical | High       | Daily manual exports, dual backup strategy |
| Function timeout on large exports  | Medium   | Medium     | Streaming responses, batching              |
| Free tier execution time limit     | Medium   | Low        | Optimize sync frequency                    |
| SSE connection drops               | Low      | High       | Auto-reconnect with exponential backoff    |
| Offline sync conflicts             | Medium   | Medium     | Manual resolution for financial data       |
| Real-time latency (Mumbai region)  | Low      | High       | Acceptable for this use case               |

### 12.2 Business Risks

| Risk                                      | Severity | Likelihood | Mitigation                                     |
| ----------------------------------------- | -------- | ---------- | ---------------------------------------------- |
| Data loss from backup failure             | Critical | Medium     | Test restore procedure quarterly, dual backup  |
| Single local backup copy                  | High     | High       | Document risk, recommend second copy           |
| Founder unavailability blocking approvals | Medium   | Medium     | Make approval thresholds configurable          |
| Permission misconfiguration               | Medium   | Low        | Audit log, regular permission review           |
| Profit share calculation errors           | High     | Low        | Manual review before distribution, audit trail |

### 12.3 Security Risks

| Risk                                   | Severity | Likelihood | Mitigation                               |
| -------------------------------------- | -------- | ---------- | ---------------------------------------- |
| Account takeover (credential stuffing) | High     | Medium     | Strong password policy, rate limiting    |
| Unauthorized financial data access     | Critical | Low        | Server-side permission checks, audit log |
| Data injection attacks                 | High     | Low        | Parameterized queries, input validation  |
| Session hijacking                      | Medium   | Low        | Secure cookies, session timeout          |
| Audit log tampering                    | High     | Low        | Append-only logs, external logging       |

### 12.4 User Experience Risks

| Risk                                 | Severity | Likelihood | Mitigation                                |
| ------------------------------------ | -------- | ---------- | ----------------------------------------- |
| No iOS push notifications            | Medium   | High       | In-app notifications, document limitation |
| Cold start delays (1-2s)             | Low      | High       | Acceptable for internal app               |
| Offline sync complexity              | Medium   | Medium     | Clear UI indicators, simple resolution    |
| Mobile performance on slower devices | Low      | Medium     | Optimize bundle size, lazy loading        |

### 12.5 Recommendations

1. **Immediate (Before Development):**
   - Set up dual backup strategy (local + cloud storage)
   - Define and document backup restore procedure
   - Test MongoDB connection from deployment environment

2. **During Development:**
   - Implement comprehensive error logging
   - Add monitoring for storage usage
   - Implement rate limiting early
   - Write security tests alongside features

3. **Post-Launch:**
   - Monitor free tier usage closely
   - Schedule weekly manual backups
   - Review audit logs weekly
   - Plan for paid tier upgrade if limits are approached

4. **Long-Term:**
   - Budget for MongoDB Atlas paid tier (M10 or higher) for automated backups
   - Consider regional hosting closer to Pakistan for lower latency
   - Evaluate iOS push notification feasibility if mobile app is developed
   - Plan for scalability as business grows

---

## Appendix A: Configuration Defaults

### Business Settings (Initial)

```javascript
{
  profitSharing: {
    partners: [
      { userId: <founder_id>, name: "Abdullah", percentage: 20 },
      { userId: <hasnat_id>, name: "Hasnat", percentage: 20 },
      { userId: <ali_id>, name: "Ali", percentage: 20 },
      { userId: <afnan_id>, name: "Afnan", percentage: 20 }
    ],
    charityPercentage: 20,
    withdrawalLockedUntil: "2027-02-04" // 4 months from launch
  },
  expenseCategories: [
    "meta_ads",
    "shopify_subscription",
    "flyers_printing",
    "product_purchasing",
    "shipping_courier",
    "packaging",
    "refunds_return_costs",
    "platform_fees",
    "content_production",
    "miscellaneous"
  ],
  paymentMethods: ["cod"],
  locations: ["sheikhupura", "lahore"],
  defaultCurrency: "PKR",
  timezone: "Asia/Karachi",
  budgetApprovalThreshold: null, // disabled by default
  lowStockThreshold: 5
}
```

### Roles (Initial)

```javascript
// Founder
{
  name: "founder",
  displayName: "Founder",
  permissions: {
    finance: { view: true, create: true, edit: true, delete: true, approve: true },
    budget: { view: true, create: true, edit: true, delete: true, approve: true },
    inventory: { view: true, create: true, edit: true, delete: true },
    sales: { view: true, create: true, edit: true, delete: true },
    tasks: {
      view: true,
      create: true,
      edit: true,           // edit / move own tasks
      editOthers: true,     // edit / move others' tasks (Founder default)
      delete: true,         // archive own tasks
      deleteOthers: true,   // archive others' tasks (Founder default)
      comment: true,
      manage: true          // boards and columns (Founder-only, not grantable)
    },
    chat: { view: true, create: true, edit: true, delete: true },
    suppliers: { view: true, create: true, edit: true, delete: true },
    settings: { view: true, edit: true },
    users: { view: true, create: true, edit: true, delete: true }
  }
}

// Partner (Hasnat)
{
  name: "partner_hasnat",
  displayName: "Partner (Hasnat)",
  permissions: {
    finance: { view: true, create: false, edit: false, delete: false, approve: false },
    budget: { view: true, create: false, edit: false, delete: false, approve: false },
    inventory: { view: true, create: false, edit: false, delete: false }, // Exception: Lahore stock via separate permission
    sales: { view: true, create: true, edit: true, delete: false },
    tasks: {
      view: true,
      create: true,
      edit: true,           // edit / move own tasks
      editOthers: false,    // grantable by Founder per role
      delete: true,         // archive own tasks
      deleteOthers: false,
      comment: true,
      manage: false         // Founder-only
    },
    chat: { view: true, create: true, edit: true, delete: true },
    suppliers: { view: true, create: false, edit: false, delete: false },
    settings: { view: false, edit: false },
    users: { view: false, create: false, edit: false, delete: false }
  }
}

// Partner (Ali)
{
  name: "partner_ali",
  displayName: "Partner (Ali)",
  permissions: {
    finance: { view: true, create: false, edit: false, delete: false, approve: false },
    budget: { view: true, create: false, edit: false, delete: false, approve: false },
    inventory: { view: true, create: false, edit: false, delete: false }, // Exception: Lahore stock via separate permission
    sales: { view: true, create: false, edit: false, delete: false },
    tasks: {
      view: true,
      create: true,
      edit: true,
      editOthers: false,
      delete: true,
      deleteOthers: false,
      comment: true,
      manage: false
    },
    chat: { view: true, create: true, edit: true, delete: true },
    suppliers: { view: true, create: false, edit: false, delete: false },
    settings: { view: false, edit: false },
    users: { view: false, create: false, edit: false, delete: false }
  }
}

// Partner (Afnan)
{
  name: "partner_afnan",
  displayName: "Partner (Afnan)",
  permissions: {
    finance: { view: true, create: false, edit: false, delete: false, approve: false },
    budget: { view: true, create: false, edit: false, delete: false, approve: false },
    inventory: { view: true, create: false, edit: false, delete: false },
    sales: { view: true, create: false, edit: false, delete: false },
    tasks: {
      view: true,
      create: true,
      edit: true,
      editOthers: false,
      delete: true,
      deleteOthers: false,
      comment: true,
      manage: false
    },
    chat: { view: true, create: true, edit: true, delete: true },
    suppliers: { view: true, create: false, edit: false, delete: false },
    settings: { view: false, edit: false },
    users: { view: false, create: false, edit: false, delete: false }
  }
}
```

---

**End of Specification Document**
