/**
 * Offline queue — shared types (design §4, D4).
 *
 * These types are storage-agnostic on purpose: `state.ts` is pure and unit-
 * testable without a browser, `db.ts` binds them to Dexie/IndexedDB, and the
 * API tests never import either. A queue row mirrors SPEC §6.3 exactly, plus
 * the two Phase 9 additions the design doc got approved for: the `syncing`
 * state (D4) and `userId` ownership tagging for shared devices.
 */

/** The only two writes that may go offline (D1): creates, never edits. */
export type OfflineOperation = 'create_finance' | 'create_budget'

export type QueueStatus = 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict'

/**
 * The create body exactly as the ONLINE forms would POST it — paisa integers,
 * ObjectId strings, category names. The server re-validates it with the same
 * zod schemas, so the queue stores nothing the API would not accept.
 */
export interface FinanceCreatePayload {
  type: string
  amount: number
  date: string
  accountId?: string
  fromAccountId?: string
  toAccountId?: string
  category?: string
  partnerId?: string
  partnerName?: string
  paymentMethod?: string
  note?: string
  idempotencyKey: string
}

export interface BudgetCreatePayload {
  name: string
  periodStart: string
  periodEnd: string
  periodKind?: string
  status?: string
  categories: { category: string; budgeted: number }[]
  approvedBy?: string
  idempotencyKey: string
}

export interface QueueEntry {
  /** Local UUID — primary key, never a server id. */
  id: string
  /** Owner. The queue is filtered by this on shared devices (§8). */
  userId: string
  operation: OfflineOperation
  payload: FinanceCreatePayload | BudgetCreatePayload
  /**
   * Minted once at enqueue time and NEVER regenerated (§4), so a crash-and-
   * replay re-sends the same key and the ledger's unique index dedupes it —
   * exactly-once without any server-side queue collection (D2/D3).
   */
  idempotencyKey: string
  status: QueueStatus
  attempts: number
  lastAttemptAt?: number
  /** Backoff gate (§6.3): a due `failed` entry is eligible for the drain. */
  nextRetryAt?: number
  /**
   * False once the failure needs USER action (validation / permission /
   * conflict / retry budget exhausted). `true` means the engine may back off
   * and re-attempt automatically (§6.3: only network/5xx blind-retry).
   */
  autoRetry?: boolean
  /** Human reason shown on the Sync screen for failed/conflict rows. */
  errorMessage?: string
  /** Server state returned with a conflict, for the "why" detail (§7). */
  conflictData?: Record<string, unknown>
  /**
   * True once ANY HTTP response came back for this entry. Discarding an entry
   * that reached the server must be audit-logged server-side (§7); one that
   * never left the device is removed locally only.
   */
  reachedServer?: boolean
  /** Fired the sync_failure notification after exhausting attempts. */
  failureReported?: boolean
  createdAt: number
  updatedAt: number
  syncedAt?: number
}

/** Meta store keys (§4): last completed sync + a stable device id. */
export interface QueueMeta {
  key: string
  value: unknown
}

export const META_LAST_SYNCED_AT = 'lastSyncedAt'
export const META_DEVICE_ID = 'deviceId'
