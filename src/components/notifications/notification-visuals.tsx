'use client'

import React from 'react'
import {
  IconAlert,
  IconBudgets,
  IconClock,
  IconInventory,
  IconMoney,
  IconOffline,
  IconSuccess,
  IconSwap,
  type IconType,
} from '@/components/ui/icons'
import type { NotificationType } from '@/lib/notifications/types'

/**
 * One place that decides how each notification type LOOKS, so the bell list,
 * the desktop-push affordance and (later) the Sync screen all agree. Colors use
 * the muted status pairs the rest of the app already uses — no gradients, brand
 * tokens only. A type without an entry here would be a bug, so the map is total
 * over `NotificationType` and TypeScript enforces it.
 */
const VISUALS: Record<NotificationType, { Icon: IconType; className: string }> = {
  low_stock: { Icon: IconInventory, className: 'bg-status-warning-bg text-status-warning' },
  task_overdue: { Icon: IconAlert, className: 'bg-status-danger-bg text-status-danger' },
  task_due_soon: { Icon: IconClock, className: 'bg-status-info-bg text-status-info' },
  budget_warning: { Icon: IconBudgets, className: 'bg-status-warning-bg text-status-warning' },
  budget_critical: { Icon: IconAlert, className: 'bg-status-danger-bg text-status-danger' },
  pending_approval: { Icon: IconSuccess, className: 'bg-status-info-bg text-status-info' },
  sync_failure: { Icon: IconOffline, className: 'bg-status-danger-bg text-status-danger' },
  sync_conflict: { Icon: IconSwap, className: 'bg-status-warning-bg text-status-warning' },
  financial_event: { Icon: IconMoney, className: 'bg-status-info-bg text-status-info' },
}

export const NotificationGlyph = ({ type, size = 16 }: { type: NotificationType; size?: number }) => {
  const { Icon, className } = VISUALS[type]
  return (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${className}`}
      aria-hidden="true"
    >
      <Icon size={size} />
    </span>
  )
}

/**
 * Compact relative time ("just now", "5m", "3h", "2d") for the dense list row.
 * Falls back to an absolute short date past a week so an old item never reads as
 * if it just happened. Pure function of the timestamp and "now" so it stays
 * deterministic and cannot cause a hydration mismatch (the caller passes `now`).
 */
export function relativeTime(iso: string, now: number): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.max(0, Math.round((now - then) / 1000))
  if (diffSec < 45) return 'just now'
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHour = Math.round(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h ago`
  const diffDay = Math.round(diffHour / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return new Date(then).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
