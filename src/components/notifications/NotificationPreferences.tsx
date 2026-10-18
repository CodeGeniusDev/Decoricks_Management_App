'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { ErrorState } from '@/components/ui/ErrorState'
import { Toast } from '@/components/ui/Toast'
import { apiJson } from '@/lib/api-client'
import {
  NON_MUTEABLE_TYPES,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_LABELS,
  type NotificationPrefs,
  type NotificationType,
} from '@/lib/notifications/types'
import { NotificationGlyph } from './notification-visuals'
import { PushEnableControl } from './PushEnableControl'

/**
 * Settings → Notifications. The per-user switches the brief asks for, plus the
 * desktop-alert (Web Push) control.
 *
 * This is the caller's OWN preference document, so there is no role gate — any
 * signed-in user tunes their own alerts (the API enforces that with `requireAuth`
 * alone). Toggles save immediately and roll back on failure so the switch never
 * lies about what the server stored. The two operational-integrity types
 * (sync failures / conflicts) are shown but locked on, because opting out of
 * "your data did not save" is not a preference — the server refuses the toggle
 * too, so the UI cannot drift from it.
 */

const DESCRIPTIONS: Record<NotificationType, string> = {
  low_stock: 'When a product drops to or below its reorder level.',
  task_overdue: 'When a task you are on passes its due date unfinished.',
  task_due_soon: 'A heads-up shortly before a task on you is due.',
  budget_warning: 'When a budget category nears its warning percentage.',
  budget_critical: 'When a budget category reaches its critical / over-budget line.',
  pending_approval: 'When something is waiting for a Founder to approve.',
  sync_failure: 'An offline entry you queued could not be saved.',
  sync_conflict: 'An offline entry clashes with server data and needs you.',
  financial_event: 'Withdrawals, locked distributions, and large expenses.',
}

export const NotificationPreferences = () => {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  // Serialise toggles so a fast double-click cannot interleave two PATCHes and
  // leave the UI showing the result of the earlier one.
  const savingRef = useRef<Set<NotificationType>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiJson<{ preferences: NotificationPrefs }>('/api/notifications/preferences')
      setPrefs(res.preferences)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load your notification settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback(async (type: NotificationType, enabled: boolean) => {
    if (NON_MUTEABLE_TYPES.has(type)) return
    if (savingRef.current.has(type)) return
    savingRef.current.add(type)
    const previous = prefs
    // Optimistic — the switch responds instantly, then the server confirms.
    setPrefs((current) => (current ? { ...current, [type]: { enabled } } : current))
    try {
      const res = await apiJson<{ preferences: NotificationPrefs }>('/api/notifications/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferences: { [type]: { enabled } } }),
      })
      setPrefs(res.preferences)
      setToast({ type: 'success', message: `${NOTIFICATION_TYPE_LABELS[type]} ${enabled ? 'on' : 'off'}.` })
    } catch (err) {
      if (previous) setPrefs(previous)
      setToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not save that change.',
      })
    } finally {
      savingRef.current.delete(type)
    }
  }, [prefs])

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton variant="rect" className="h-40" />
        <Skeleton variant="rect" className="h-24" />
      </div>
    )
  }

  if (error || !prefs) {
    return (
      <Card>
        <ErrorState
          title="Could not load your notification settings"
          description={error ?? 'Unknown error.'}
          action={{ label: 'Retry', onClick: () => void load() }}
        />
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      <Card className="p-4 sm:p-6">
        <h2 className="mb-1 text-lg font-semibold text-decoricks-dark">In-app & desktop alerts</h2>
        <p className="mb-4 text-sm text-ink-secondary">
          Choose which events reach you. Turning a type off here stops BOTH the bell and any desktop
          alert for it; the in-app list still shows anything already delivered.
        </p>

        <ul className="divide-y divide-line-subtle">
          {NOTIFICATION_TYPES.map((type) => {
            const locked = NON_MUTEABLE_TYPES.has(type)
            const enabled = locked ? true : prefs[type]?.enabled
            return (
              <li key={type} className="flex items-start gap-3 py-3">
                <NotificationGlyph type={type} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-decoricks-dark">
                      {NOTIFICATION_TYPE_LABELS[type]}
                    </span>
                    {locked && <Badge size="sm">Always on</Badge>}
                  </div>
                  <p className="text-xs text-ink-muted">{DESCRIPTIONS[type]}</p>
                </div>
                <Checkbox
                  checked={enabled}
                  disabled={locked}
                  onChange={(e) => void toggle(type, e.target.checked)}
                  aria-label={`${locked ? 'Always enabled' : 'Enable'} ${NOTIFICATION_TYPE_LABELS[type]}`}
                />
              </li>
            )
          })}
        </ul>
      </Card>

      <Card className="p-4 sm:p-6">
        <h2 className="mb-1 text-lg font-semibold text-decoricks-dark">Desktop notifications</h2>
        <p className="mb-3 text-sm text-ink-secondary">
          Let this device show an alert even when the tab is closed. Off unless you turn it on, and
          you will only be asked for browser permission when you press the button.
        </p>
        <PushEnableControl />
      </Card>
    </div>
  )
}
