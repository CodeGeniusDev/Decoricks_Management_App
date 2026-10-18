/**
 * Phase 9 notification vocabulary — CLIENT-SAFE.
 *
 * No MongoDB imports live here: both the server emit service and the client
 * bell/preferences UI import from this module so the type set, human labels,
 * default preferences and permission gates are one shared source of truth and
 * can never drift between what the server will send and what the UI offers to
 * toggle. The document shape and collection accessors live in
 * `@/lib/models/Notifications`.
 *
 * The nine types are exactly the events the brief enumerates:
 * low stock · overdue / due-soon tasks · budget warning / critical ·
 * pending approvals · sync failures / conflicts · financial events.
 */

import type { PermissionModule } from '@/lib/models/User'

export type NotificationType =
  | 'low_stock'
  | 'task_overdue'
  | 'task_due_soon'
  | 'budget_warning'
  | 'budget_critical'
  | 'pending_approval'
  | 'sync_failure'
  | 'sync_conflict'
  | 'financial_event'

export const NOTIFICATION_TYPES: NotificationType[] = [
  'low_stock',
  'task_overdue',
  'task_due_soon',
  'budget_warning',
  'budget_critical',
  'pending_approval',
  'sync_failure',
  'sync_conflict',
  'financial_event',
]

/** Human label shown in the preferences panel and the notification list. */
export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  low_stock: 'Low stock',
  task_overdue: 'Overdue tasks',
  task_due_soon: 'Due-soon tasks',
  budget_warning: 'Budget warning',
  budget_critical: 'Budget critical',
  pending_approval: 'Pending approvals',
  sync_failure: 'Sync failures',
  sync_conflict: 'Sync conflicts',
  financial_event: 'Financial events',
}

/**
 * Two categories are operational integrity, not preference: a sync failure the
 * retry budget exhausted and a sync conflict must always reach the affected user
 * (and, for conflicts, the Founder). They are shown in the UI but rendered
 * non-muteable so a user is never silently opted out of knowing their own data
 * did not save.
 */
export const NON_MUTEABLE_TYPES: ReadonlySet<NotificationType> = new Set([
  'sync_failure',
  'sync_conflict',
])

/**
 * The permission a recipient must hold for a type to be emitted to them at all
 * (SPEC §4.3, enforced at emit time — see §2.3 of the design doc). `null` means
 * the notification is about the recipient's OWN data (their queued sync entries)
 * so no module grant gates it; the recipient is always the entry owner.
 */
export const NOTIFICATION_PERMISSION: Record<NotificationType, [PermissionModule, 'view'] | null> =
  {
    low_stock: ['inventory', 'view'],
    task_overdue: ['tasks', 'view'],
    task_due_soon: ['tasks', 'view'],
    budget_warning: ['budget', 'view'],
    budget_critical: ['budget', 'view'],
    pending_approval: ['finance', 'view'],
    financial_event: ['finance', 'view'],
    sync_failure: null,
    sync_conflict: null,
  }

/** One line in the per-user preferences document. */
export interface NotificationPref {
  enabled: boolean
}

export type NotificationPrefs = Record<NotificationType, NotificationPref>

/** Every type starts enabled; the two non-muteable ones are always effectively on. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = NOTIFICATION_TYPES.reduce(
  (prefs, type) => {
    prefs[type] = { enabled: true }
    return prefs
  },
  {} as NotificationPrefs
)

/**
 * Merge a stored (possibly partial, possibly pre-Phase-9) prefs object with the
 * defaults so a newly-added type is enabled for existing users and a missing key
 * never crashes the UI or the emit gate. Non-muteable types are forced enabled.
 */
export function resolveNotificationPrefs(
  stored: Partial<Record<NotificationType, Partial<NotificationPref>>> | undefined | null
): NotificationPrefs {
  const resolved = { ...DEFAULT_NOTIFICATION_PREFS }
  if (stored) {
    for (const type of NOTIFICATION_TYPES) {
      const value = stored[type]?.enabled
      if (typeof value === 'boolean') resolved[type] = { enabled: value }
    }
  }
  for (const type of NON_MUTEABLE_TYPES) resolved[type] = { enabled: true }
  return resolved
}

/**
 * Data the client needs to render and route a notification. Carries ONLY ids,
 * labels and an in-app link — never a figure a viewer may not be entitled to
 * see. The numeric payload is fetched through `link`, which runs its own
 * permission-checked read (mirrors REALTIME.md's dataless-signal invariant).
 */
export interface NotificationData {
  entityType: 'product' | 'task' | 'transaction' | 'budget' | 'distribution' | 'sync'
  entityId?: string
  /** In-app route to open, e.g. `/inventory?product=<id>`. */
  link?: string
  /** For `financial_event`: what happened, so the Founder sees the reason. */
  kind?: 'withdrawal_request' | 'distribution_locked' | 'large_expense'
  /** Free-form human context safe to show (labels, dates — never money). */
  detail?: string
}
